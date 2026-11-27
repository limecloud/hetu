import path from "node:path";
import {JsonLineProcess} from "./json-line-process.ts";
import type {ConversationEvent,ExternalConversationDriver} from "./external-conversation-driver.ts";
import {boundedExternalQuestions,type ExternalAnswers,type ExternalModel} from "../../shared/external-session.ts";
import type {ExternalImageAttachment} from "../../shared/external-attachment.ts";

export class PiConversationDriver implements ExternalConversationDriver {
  #connection?:JsonLineProcess;#sessionId?:string;#models:ExternalModel[]=[];#modelKeys=new Map<string,{provider:string;modelId:string}>();#selectedModel?:string;#selectedEffort?:string;#message=0;#messageId="";#idleCheck=0;
  #questions=new Map<string,{id:string|number;method:string}>();#interrupted=false;
  readonly capabilities={questions:true,context:false,compact:true,images:true};
  private options:{binary:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;event(value:ConversationEvent):void};
  constructor(options:PiConversationDriver["options"]){this.options=options;}
  get connected(){return this.#connection?.connected??false;}
  get processId(){return this.#connection?.processId;}
  get sessionId(){return this.#sessionId;}
  get models(){return this.#models;}
  #verifyState(state:any){
    if(typeof state?.sessionId!=="string"||this.#sessionId&&state.sessionId!==this.#sessionId||typeof state.sessionFile!=="string"||path.resolve(state.sessionFile)!==path.join(this.options.cwd,"provider-session.jsonl"))throw Error("Pi状态不属于原会话身份或文件。");
    return state;
  }
  async open(resumeId?:string){
    const file=path.join(this.options.cwd,"provider-session.jsonl");
    this.#connection=new JsonLineProcess({...this.options,args:[...this.options.args,"--session",file],message:value=>this.#messageEvent(value),closed:error=>this.options.event({type:"closed",error:error?.message})});
    try{
      const state=this.#verifyState(await this.#connection.request("get_state",{},30000,"pi"));
      if(typeof state.sessionId!=="string"||path.resolve(state.sessionFile??"")!==file||resumeId&&state.sessionId!==resumeId)throw Error("Pi没有返回固定会话文件与身份，没有另开会话。");
      if(state.model?.provider==="unknown")throw Error("Pi尚未配置可用提供方，请先在CLI完成配置。");
      this.#sessionId=state.sessionId;this.options.event({type:"identity",id:this.#sessionId!});
      const listing=await this.#connection.request("get_available_models",{},10000,"pi");
      this.#models=(listing.models??[]).filter((row:any)=>typeof row.id==="string"&&typeof row.provider==="string"&&row.id.length+row.provider.length<255&&!row.provider.includes("/")).slice(0,128).map((row:any)=>{
        const id=row.provider+"/"+row.id;this.#modelKeys.set(id,{provider:row.provider,modelId:row.id});
        const efforts=row.reasoning===true?["off","minimal","low","medium","high","xhigh","max"].filter(level=>row.thinkingLevelMap?.[level]!==null&&(!["xhigh","max"].includes(level)||typeof row.thinkingLevelMap?.[level]==="string")).map(id=>({id,label:id})):[];
        return {id,label:String(row.name??id).slice(0,128),...(efforts.length?{efforts}:{})};
      });
      this.#selectedModel=state.model?.provider&&state.model?.id?state.model.provider+"/"+state.model.id:undefined;this.#selectedEffort=state.thinkingLevel;
      if(resumeId){const history=await this.#connection.request("get_messages",{},30000,"pi");for(const message of history.messages??[])this.#wholeMessage(message);}
    }catch(error){await this.close();throw error;}
  }
  #wholeMessage(message:any){const text=typeof message?.content==="string"?message.content:(message?.content??[]).filter((row:any)=>row.type==="text").map((row:any)=>row.text).join("\n");if(text&&["user","assistant"].includes(message.role))this.options.event({type:"message",message:{id:this.#messageId||"history-"+(++this.#message),role:message.role,text}});}
  #messageEvent(value:any){
    if(value.type==="message_start")this.#messageId="message-"+(++this.#message);
    if(value.type==="message_update"&&value.assistantMessageEvent?.type==="text_delta")this.options.event({type:"delta",id:this.#messageId||(this.#messageId="message-"+(++this.#message)),text:value.assistantMessageEvent.delta??""});
    if(value.type==="message_end")this.#wholeMessage(value.message);
    if(["tool_execution_start","tool_execution_end"].includes(value.type)&&typeof value.toolCallId==="string")this.options.event({type:"message",message:{id:value.toolCallId,role:"tool",text:String(value.toolName??"工具")+(value.type.endsWith("end")?(value.isError?"：失败":"：完成"):"：运行中")}});
    if(value.type==="extension_ui_request"){
      const id=String(value.id);
      if(["confirm","select","input","editor"].includes(value.method)&&this.#questions.size<16){
        try{
          const options=value.method==="confirm"?[{id:"true",label:"确认"},{id:"false",label:"拒绝"}]:value.method==="select"?(value.options??[]).map((option:unknown)=>({id:option,label:option})):[];
          const request=boundedExternalQuestions({id,title:value.title,questions:[{id:"value",title:value.title,prompt:value.message||value.title,allow_other:["input","editor"].includes(value.method),options}]});
          this.#questions.set(id,{id:value.id,method:value.method});this.options.event({type:"question",request});
        }catch{this.#connection?.send({type:"extension_ui_response",id:value.id,cancelled:true});}
      }else this.#connection?.send({type:"extension_ui_response",id:value.id,cancelled:true});
    }
    if(value.type==="agent_end"||value.type==="agent_settled"){
      const check=++this.#idleCheck;void this.#connection?.request("get_state",{},10000,"pi").then(value=>{const state=this.#verifyState(value);if(check===this.#idleCheck&&!state.isStreaming&&!state.isCompacting&&(state.pendingMessageCount??0)===0){this.#questions.clear();this.options.event({type:"complete",outcome:this.#interrupted?"interrupted":"completed"});}}).catch(()=>this.options.event({type:"closed",error:"Pi运行结束状态待核对。"}));
    }
  }
  async send(text:string,model?:string,effort?:string,images:ExternalImageAttachment[]=[]){
    if(!this.#connection)throw Error("Pi会话未连接。");
    if(model&&model!==this.#selectedModel){
      const value=this.#modelKeys.get(model);if(!value)throw Error("Pi模型不可选。");await this.#connection.request("set_model",{provider:value.provider,modelId:value.modelId},30000,"pi");
      const state=this.#verifyState(await this.#connection.request("get_state",{},10000,"pi"));if(state.model?.provider!==value.provider||state.model?.id!==value.modelId)throw Error("Pi实际模型与选择不一致，没有发送请求。");this.#selectedModel=model;this.#selectedEffort=state.thinkingLevel;
    }
    if(effort){
      if(!this.#models.find(option=>option.id===(model??this.#selectedModel))?.efforts?.some(option=>option.id===effort))throw Error("Pi思考选项不在当前模型目录中。");
      if(effort!==this.#selectedEffort){await this.#connection.request("set_thinking_level",{level:effort},30000,"pi");const state=this.#verifyState(await this.#connection.request("get_state",{},10000,"pi"));if(state.thinkingLevel!==effort)throw Error("Pi实际思考选项与选择不一致，没有发送请求。");this.#selectedEffort=effort;}
    }
    this.#idleCheck++;this.#interrupted=false;await this.#connection.request("prompt",{message:text,...(images.length?{images:images.map(image=>({type:"image",data:image.data,mimeType:image.mime_type}))}:{})},30000,"pi");
  }
  async interrupt(){if(!this.#connection)throw Error("Pi会话未连接。");this.#interrupted=true;await this.#connection.request("abort",{},30000,"pi");}
  async approve(){throw Error("Pi工具权限由提供方执行，宿主不冒充其批准入口。");}
  async answer(id:string,answers:ExternalAnswers){const request=this.#questions.get(id);if(!request)throw Error("Pi问题请求已变化。");this.#connection!.send({type:"extension_ui_response",id:request.id,...(request.method==="confirm"?{confirmed:answers.value[0]==="true"}:{value:answers.value[0]})});this.#questions.delete(id);}
  async compact(){
    if(!this.#connection)throw Error("Pi会话未连接。");this.#interrupted=false;
    void this.#connection.request("compact",{},600000,"pi").then(async()=>{
      const state=this.#verifyState(await this.#connection!.request("get_state",{},10000,"pi"));
      if(state.isStreaming||state.isCompacting)throw Error("Pi压缩后的空闲状态待核对。");
      this.options.event({type:"complete",outcome:"completed"});
    }).catch(()=>this.options.event({type:"closed",error:"Pi压缩结果待核对，没有自动重发。"}));
  }
  async close(){this.#idleCheck++;this.#questions.clear();await this.#connection?.close();}
}
