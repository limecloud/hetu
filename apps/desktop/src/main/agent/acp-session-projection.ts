import {createHash} from "node:crypto";
import type {ExternalMessage,ExternalToolActivity} from "../../shared/external-session.ts";
import {boundedExternalMessage} from "../../shared/external-message.ts";

const key=(kind:string,id:string)=>"acp-"+kind+"-"+createHash("sha256").update(id).digest("hex");
const identity=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=255&&!/[\x00-\x1f\x7f]/.test(value);
const json=(value:unknown)=>typeof value==="string"?value:JSON.stringify(value,null,2)??"";
const kinds:Record<string,ExternalToolActivity["kind"]>={execute:"command",edit:"file_change",delete:"file_change",move:"file_change"};
const states=new Map<string,ExternalToolActivity["status"]>([["pending","running"],["in_progress","running"],["completed","completed"],["failed","failed"]]);

/** ACP更新是字段快照，缺项保持原值；正文、工具、思考与计划分别投影。 */
export class AcpSessionProjection {
  #turn?:string;#history=false;#messages=new Map<string,ExternalMessage>();
  #owners=new Map<string,string>();#sequence=0;#channel?:string;#segment?:string;
  begin(turn:string,history=false){this.#turn=turn;this.#history=history;this.#messages.clear();this.#channel=undefined;this.#segment=undefined;}
  #save(message:ExternalMessage){
    if(!this.#messages.has(message.id)&&this.#messages.size>=128)throw Error("ACP事件条目超过预算，请核对原会话。");
    this.#messages.set(message.id,boundedExternalMessage(message,16000,16000,true));
    let size=[...this.#messages.values()].reduce((n,row)=>n+Buffer.byteLength(JSON.stringify(row)),0);
    for(const [id,row] of this.#messages){if(size<=64000)break;const smaller=boundedExternalMessage(row,768,0,true);size+=Buffer.byteLength(JSON.stringify(smaller))-Buffer.byteLength(JSON.stringify(row));this.#messages.set(id,smaller);}
    if(size>64000)throw Error("ACP事件身份超过预算，请核对原会话。");
    return structuredClone(this.#messages.get(message.id)!);
  }
  #own(id:string,identified=false){
    if(!this.#turn)return false;
    const prior=this.#owners.get(id);if(prior&&prior!==this.#turn&&!identified)return false;
    if(!prior||identified){this.#owners.set(id,this.#turn);while(this.#owners.size>512)this.#owners.delete(this.#owners.keys().next().value!);}
    return true;
  }
  #content(value:any){
    if(!value||typeof value.type!=="string")throw Error("ACP内容块格式无效。");
    if(value.type==="text"){if(typeof value.text!=="string")throw Error("ACP文本内容无效。");return value.text;}
    if(value.type==="resource"&&typeof value.resource?.text==="string")return value.resource.text;
    if(value.type==="resource_link")return "[提供方资源引用："+String(value.name??"").slice(0,255)+" "+String(value.uri??"").slice(0,1024)+"]";
    return "[提供方内容："+value.type.slice(0,80)+"]";
  }
  #output(content:unknown){
    if(!Array.isArray(content)||content.length>64)throw Error("ACP工具内容格式无效或超过预算。");
    return content.map(row=>{
      if(row?.type==="content")return this.#content(row.content);
      if(row?.type==="diff"){
        if(typeof row.path!=="string"||typeof row.newText!=="string"||row.oldText!=null&&typeof row.oldText!=="string")throw Error("ACP差异内容格式无效。");
        return "文件："+row.path+"\n原内容：\n"+(row.oldText??"")+"\n新内容：\n"+row.newText;
      }
      if(row?.type==="terminal")return "[提供方终端引用："+String(row.terminalId??"").slice(0,255)+"]";
      return "[提供方工具内容："+String(row?.type).slice(0,80)+"]";
    }).join("\n\n");
  }
  update(update:any,identified=false):ExternalMessage|undefined {
    if(!this.#turn)return;
    const type=update.sessionUpdate;
    if(["agent_message_chunk","agent_thought_chunk","user_message_chunk"].includes(type)){
      if(type==="user_message_chunk"&&!this.#history)return;
      const channel=type==="agent_thought_chunk"?"reasoning":type==="user_message_chunk"?"user":"assistant";
      const named=update.messageId!=null;if(named&&!identity(update.messageId))throw Error("ACP消息身份无效。");
      if(named&&!this.#own("message:"+update.messageId,identified))return;
      const stream=channel+":"+(named?update.messageId:"anonymous");
      if(this.#channel!==stream||!this.#segment){this.#channel=stream;this.#segment=key("segment",this.#turn+":"+(++this.#sequence));}
      const id=named?key(channel,update.messageId):this.#segment,prior=this.#messages.get(id),text=this.#content(update.content);
      return this.#save({id,...(channel==="user"&&this.#history?{}:{turn_id:this.#turn}),role:channel==="user"?"user":"assistant",text:(prior?.text??"")+text,...(named?{provider_item_id:update.messageId}:{}),...(channel==="reasoning"?{channel:"reasoning"}:{}),...(prior?.truncated?{truncated:true}:{})});
    }
    if(["tool_call","tool_call_update","plan"].includes(type)){this.#channel=undefined;this.#segment=undefined;}
    if(type==="plan"){
      if(!Array.isArray(update.entries)||update.entries.length>128||update.entries.some((entry:any)=>typeof entry?.content!=="string"||typeof entry.status!=="string"||typeof entry.priority!=="string"))throw Error("ACP计划格式无效或超过预算。");
      return this.#save({id:key("plan",this.#turn),turn_id:this.#turn,role:"system",text:"",plan:update.entries.map((entry:any)=>({content:entry.content,status:entry.status,priority:entry.priority}))});
    }
    if(type!=="tool_call"&&type!=="tool_call_update")return;
    if(!identity(update.toolCallId))throw Error("ACP工具身份无效。");
    if(!this.#own("tool:"+update.toolCallId,identified))return;
    const id=key("tool",update.toolCallId),prior=this.#messages.get(id);
    if(prior?.tool&&prior.tool.status!=="running"&&prior.tool.status!=="unknown")return;
    const tool:ExternalToolActivity=prior?.tool?structuredClone(prior.tool):{kind:"dynamic",name:"外部工具",status:"running"};
    if(update.title!=null){if(typeof update.title!=="string")throw Error("ACP工具名称格式无效。");tool.name=update.title;}
    if(update.kind!=null){if(typeof update.kind!=="string")throw Error("ACP工具类型格式无效。");tool.provider_kind=update.kind;tool.kind=Object.hasOwn(kinds,update.kind)?kinds[update.kind]:"dynamic";}
    if(update.status!=null){
      if(typeof update.status!=="string")throw Error("ACP工具状态格式无效。");
      tool.status=states.get(update.status)??"unknown";
      tool.progress=update.status==="pending"?"等待开始":undefined;
    }
    if(Object.hasOwn(update,"rawInput"))tool.input=json(update.rawInput);
    if(update.locations!=null){
      if(!Array.isArray(update.locations)||update.locations.length>128||update.locations.some((row:any)=>typeof row?.path!=="string"||row.line!=null&&(!Number.isSafeInteger(row.line)||row.line<0)))throw Error("ACP工具位置格式无效或超过预算。");
      tool.locations=update.locations.map((row:any)=>({path:row.path,...(row.line!=null?{line:row.line}:{})}));
    }
    let text=prior?.text??"";
    if(update.content!=null)text=this.#output(update.content);
    else if(Object.hasOwn(update,"rawOutput"))text=json(update.rawOutput);
    if(tool.kind==="command"&&Number.isSafeInteger(update.rawOutput?.exitCode)){tool.exit_code=update.rawOutput.exitCode;if(tool.status==="completed"&&tool.exit_code!==0)tool.status="failed";}
    return this.#save({id,turn_id:this.#turn,provider_item_id:update.toolCallId,role:"tool",text,tool,...(prior?.truncated?{truncated:true}:{})});
  }
  finish(status:"interrupted"|"unknown"){
    const messages=[...this.#messages.values()].filter(row=>row.tool?.status==="running").map(row=>({...row,tool:{...row.tool!,status,progress:undefined}}));
    this.#turn=undefined;this.#messages.clear();this.#channel=undefined;this.#segment=undefined;return messages;
  }
}
