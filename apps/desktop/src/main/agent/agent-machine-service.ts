import {createServer} from "node:net";
import {randomBytes,randomUUID,createHash,timingSafeEqual} from "node:crypto";
import {mkdir,readFile,open,rename,unlink,lstat,readdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import type {WorkRef} from "@hetu/plugin-sdk";
import type {AgentTool,SessionSnapshot,SessionLaunch} from "../../agent-session-contract.ts";
import {AgentSessions} from "./session-manager.ts";
import {ExternalAgentSession} from "./external-agent-session.ts";
import {discoverEngines,validEngineId} from "./engines.ts";
import {atomicJson,recordPath} from "./session-storage.ts";
import {externalProvider} from "../../shared/external-ai.ts";
import {isDeepStrictEqual} from "node:util";
import {validBotContext} from "./bot-context.ts";

const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const states=new Set(["dispatching","succeeded","rejected","unknown"]);
const identity=(value:unknown)=>typeof value==="string"&&/^(codex|terminal)-[a-zA-Z0-9-]{16,64}$/.test(value);
const compact=(value:SessionSnapshot)=>({session_id:value.session_id,generation:value.generation??0,client:value.client,surface:value.surface,state:value.state,thread_id:value.thread_id,work_ref:value.work_ref??null,model:value.model,reasoning_effort:value.reasoning_effort,terminal_sequence:value.terminal_sequence,terminal_connected:value.terminal_connected,draft_available:!!value.draft,work_completion_authority:false});

/** 私密机器宿主复用现有会话管理器；不拥有作品事实，不自行运行模型轮次。 */
export class SessionMachine {
  #sessions:AgentSessions;
  #queue=Promise.resolve();
  private options:{profile:string;bin:string;directory:string;client:string};
  constructor(options:{profile:string;bin:string;directory:string;client:string}){this.options=options;
    const suffix=process.platform==="win32"?".exe":"",dist=path.dirname(fileURLToPath(import.meta.url));
    this.#sessions=new AgentSessions({profile:options.profile,machineDirectory:options.directory,machineMcpBinary:path.join(options.bin,"hetu-mcp"+suffix),machineNodeBinary:process.env.HETU_PLUGIN_NODE??process.execPath,machineRelay:path.join(dist,"agent-mcp-relay.mjs"),engineGuard:path.join(dist,"agent-engine-guard.mjs"),emit:()=>{}});
  }
  get connected(){return this.#sessions.connected;}
  async #json(file:string,budget=1024*1024){const metadata=await lstat(file);if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.nlink!==1||metadata.size>budget)throw Error("机器恢复记录不是有界普通文件。");return JSON.parse(await readFile(file,"utf8"));}
  async #describe(id:unknown){if(!identity(id))throw Error("会话身份无效。");const value=await this.#json(recordPath(this.options.profile,undefined,id as string),8*1024*1024);if(value.session_id!==id||!validEngineId(value.client))throw Error("会话记录与原身份不符。");return value;}
  request(input:Record<string,any>){const run=this.#queue.then(()=>this.#request(input));this.#queue=run.then(()=>{},()=>{});return run;}
  async #request(input:Record<string,any>):Promise<any>{
    const method=input.method;
    if(method==="describe"){const record=await this.#describe(input.session_id);return compact({...record,generation:record.input_generation??record.generation});}
    if(method==="providers")return {providers:await discoverEngines(this.options.bin),installation_checked:true,protocol_handshake_checked:false};
    if(method==="list"){
      const rows=await this.#sessions.list(input.work_ref as WorkRef|undefined),offset=input.offset??0,limit=input.limit??32;
      if(offset>rows.length)throw Error("会话目录偏移越界。");return {sessions:rows.slice(offset,offset+limit),total:rows.length,next_offset:offset+limit<rows.length?offset+limit:null};
    }
    if(method==="operation"){
      const record=await this.#operation(input.operation_key);
      if(record.state==="dispatching")return {...record,state:"unknown"};return record;
    }
    if(!["read","draft_read","models","interaction","history","commands"].includes(method)){
      const original=await this.#operation(input.operation_key,true);
      if(original){if(original.request_sha256!==hash(input))throw Error("同一operation_key不能更换输入。");return original.state==="dispatching"?{...original,state:"unknown"}:original.result??original;}
    }
    let session:Awaited<ReturnType<AgentSessions["get"]>>|undefined;
    if(method!=="create"){
      const record=await this.#describe(input.session_id);
      if(input.work_ref!==undefined&&!isDeepStrictEqual(input.work_ref??null,record.work_ref??null))throw Error("会话不属于此作品。");
      session=await this.#sessions.get(record.work_ref,record.surface,input.session_id,false);
      if(input.expected_bot_context!==undefined&&(!validBotContext(input.expected_bot_context)||!isDeepStrictEqual(session.snapshot(false).bot_context,input.expected_bot_context)))throw Error("原Bot角色快照与Core固定配置不同，未发送输入。");
      if(input.generation!==undefined&&input.generation!==session.snapshot(false).generation)throw Error("会话代次已变化，旧输入未发送。");
    }
    if(method==="read"){
      const receipts=input.format==="conversation"&&"readTools" in session!?await session.readTools():[];
      return this.#read(session!.snapshot(),input,receipts);
    }
    if(method==="draft_read")return this.#draftRead(session!.snapshot(),input);
    if(method==="models")return session!.models();
    if(method==="interaction"){
      const raw=session!.snapshot();const external=raw.external;
      const request=external?[...external.approvals,...(external.questions??[]),...(external.elicitations??[])].find(value=>value.id===input.request_id):raw.requests?.find(value=>String(value.id)===input.request_id);
      if(!request)throw Error("原交互请求已结束或不存在。");return {session_id:raw.session_id,generation:raw.generation,request};
    }
    if(["history","commands"].includes(method)){
      if(!(session instanceof ExternalAgentSession))throw Error("此引擎请在原会话中读取历史或命令。");
      const raw=await session.requestExternal(method as "history"|"commands",method==="history"?{history_revision:input.history_revision,cursor:input.cursor}:{});return raw.conversation;
    }
    if(method==="restore"){
      const current=session!.snapshot(false);
      if(!current.thread_id)throw Error("此会话没有可核验的原生线程身份，未启动替代线程。请读取原会话并明确新建或启动。");
      if(current.surface==="tui"&&current.client!=="codex"&&!current.terminal_connected)throw Error("此终端尚无原生线程恢复适配，未以新进程冒充恢复。");
    }
    if(typeof input.operation_key!=="string"||!input.operation_key||input.operation_key.length>160)throw Error("写入需要原operation_key。");
    if(["send","input","paste","draft"].includes(method)&&(typeof input.data!=="string"||Buffer.byteLength(input.data)>65536))throw Error("会话输入无效或超过预算。");
    if(method==="create"){
      const launch=input.launch as SessionLaunch;if(!launch||!validEngineId(launch.client)||!["tui","gui"].includes(launch.surface)||launch.surface==="gui"&&launch.client!=="codex"&&!externalProvider(launch.client).structured)throw Error("请选择当前目录中的引擎与表面。");
      if(input.fixed_session_id!==undefined&&!identity(input.fixed_session_id))throw Error("固定会话身份无效。");
      if(launch.bot_context!==undefined&&!validBotContext(launch.bot_context))throw Error("固定Bot角色快照无效。");
    }
    const folder=path.join(this.options.profile,"machine-operations");await mkdir(folder,{recursive:true,mode:0o700});if((await readdir(folder)).length>=4096)throw Error("会话操作账本达到预算，请保留原操作后维护。");
    const target=method==="create"?hash([input.work_ref??null,"create"]):input.session_id;
    if(!["stop","interrupt"].includes(method))for(const name of await readdir(folder)){if(!name.endsWith(".json"))continue;const prior=await this.#json(path.join(folder,name),65536);if(["dispatching","unknown"].includes(prior.state)&&(prior.target===target||prior.session_id===input.session_id&&input.session_id))throw Error("原会话操作仍待核对，未换键派发。");}
    const file=path.join(folder,hash(input.operation_key)+".json");
    const record:any={version:1,operation_key:input.operation_key,request_sha256:hash(input),session_id:input.session_id,target,state:"dispatching"};
    await this.#saveOperation(file,record);
    try{
      if(method==="create"){
        const id=input.fixed_session_id??"terminal-"+randomUUID();
        session=await this.#sessions.get(input.work_ref,input.launch.surface,id,false,input.launch);
        await session.updateDraft("");
      }else if(method==="start"||method==="restore")await session!.start();
      else if(method==="stop")await session!.stop();
      else if(method==="interrupt")await session!.interrupt();
      else if(method==="resize")session!.terminalResize(input.cols,input.rows,input.generation);
      else if(method==="input")session!.terminalInput(input.data,input.generation);
      else if(method==="draft")await session!.updateDraft(input.data,undefined,{generation:input.generation});
      else if(method==="paste"||method==="send"&&session!.snapshot(false).surface==="tui"){
        if(session!.snapshot(false).client==="shell")throw Error("Shell输入请使用明确的input动作。");
        if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.data))throw Error("文字输入包含控制字符。");
        await session!.updateDraft(input.data);
        if("pasteDraft" in session!)await session.pasteDraft(session.snapshot(false).draft_version!);
        else session!.terminalInput("\u001b[200~"+input.data+"\u001b[201~",input.generation);
        if(method==="send")session!.terminalInput("\r",input.generation);
      }else if(method==="send")await session!.send(input.data,typeof input.display_text==="string"?input.display_text:input.data,{attempt_id:input.operation_key});
      else if(method==="model"&&"selectModel" in session!)await session.selectModel(input.model_id,input.effort_id);
      else if(method==="respond"&&!(session instanceof ExternalAgentSession)){
        const pending=session!.snapshot().requests?.find(request=>String(request.id)===input.request_id);
        if(!pending)throw Error("原Codex请求已结束或不属于此会话。");
        await session!.respond(pending.id,input.response,pending.generation);
      }else if(session instanceof ExternalAgentSession){
        const fields={...input};delete fields.method;delete fields.work_ref;delete fields.operation_key;delete fields.expected_bot_context;
        if(method==="model"){await session.requestExternal("model",{model_id:input.model_id});if(input.effort_id)await session.requestExternal("effort",{effort_id:input.effort_id});}
        else await session.requestExternal(method as any,fields);
      }else if(method==="approve")await session!.respond(input.approval_id,input.option_id,input.generation);
      else throw Error("此会话未接通该操作。");
      record.state="succeeded";record.result=compact(session!.snapshot());record.session_id=record.result.session_id;
      if(["input","paste"].includes(method)||method==="send"&&record.result.surface==="tui")record.result.delivery="written";
      await this.#saveOperation(file,record);return record.result;
    }catch(error){
      record.state=session?.snapshot().state==="uncertain"||!["create","start","restore","resize","draft"].includes(method)?"unknown":"rejected";
      record.error={message:(error as Error).message};await this.#saveOperation(file,record);
      const failure=Error((error as Error).message) as Error&{unknown?:boolean};failure.unknown=record.state==="unknown";throw failure;
    }
  }
  async #saveOperation(file:string,record:unknown){await atomicJson(file,{...record as object,record_sha256:hash(record)});}
  async #operation(key:unknown,missing=false):Promise<any>{
    if(typeof key!=="string"||!key||key.length>160)throw Error("原operation_key无效。");
    const file=path.join(this.options.profile,"machine-operations",hash(key)+".json");
    try{const saved=await this.#json(file,65536);const {record_sha256,...record}=saved;if(record_sha256!==hash(record)||record.operation_key!==key||!states.has(record.state))throw Error("原会话操作记录无效，已保留原文件。");return record;}
    catch(error){if(missing&&(error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}
  }
  #read(value:SessionSnapshot,input:Record<string,any>,originalReceipts:AgentTool[]=[]){
    if(input.generation!==undefined&&input.generation!==value.generation||input.expected_generation!==undefined&&input.expected_generation!==value.generation||input.expected_sequence!==undefined&&input.expected_sequence!==value.terminal_sequence)throw Error("原会话输出已变化，请重新读取。");
    const text=value.surface==="tui"?value.terminal_replay??"":value.messages.map(message=>message.text).join("\n\n"),offset=input.offset??0,limit=input.limit??12000;
    if(offset>text.length)throw Error("会话输出偏移越界。");let end=Math.min(text.length,offset+limit);if(end<text.length&&/[\uDC00-\uDFFF]/.test(text[end]))end--;
    const external=value.external;
    const result:any={...compact(value),output:input.format==="conversation"?undefined:text.slice(offset,end),offset,next_offset:end<text.length?end:null,total_units:text.length,capabilities:value.capabilities,requests:value.requests?.map(request=>({id:request.id,method:request.method,generation:request.generation})),external:external?{status:external.status,model:external.model,models:external.models.slice(0,128),capabilities:external.capabilities,approvals:external.approvals.map(request=>({id:request.id,title:request.title})),questions:external.questions?.map(request=>({id:request.id,title:request.title})),elicitations:external.elicitations?.map(request=>({id:request.id,title:request.title,revision:request.revision})),configuration:external.configuration,configuration_revision:external.configuration_revision,history_revision:external.history_revision,command_catalog:external.command_catalog,context:external.context,outcome:external.outcome,error:external.error}:undefined};
    if(input.format==="conversation"){
      const messages=value.messages.slice(-128).map(message=>({id:message.id,role:message.role,text:message.text,at:message.at,turn_id:message.turn_id,item_id:message.item_id,delivery:message.delivery,error:message.error}));
      const tools=(value.tools??[]).slice(-32).map(tool=>({id:tool.id,turn_id:tool.turn_id,kind:tool.kind,title:tool.title,state:tool.state,input:tool.input,output:tool.output,server:tool.server,name:tool.name}));
      const receipts=originalReceipts.slice();
      const draft=value.draft??"";result.draft_version=value.draft_version??0;
      if(Buffer.byteLength(draft)<=8000){result.draft=draft;result.draft_complete=true;}
      else{result.draft_complete=false;result.draft_read={method:"draft_read",session_id:value.session_id,generation:value.generation,expected_draft_version:result.draft_version,offset:0,limit:4000};}
      result.conversation={messages,tools,receipts,receipts_complete:true,total_receipts:originalReceipts.length,complete:true,total_messages:value.messages.length,total_tools:value.tools?.length??0,text_read:{method:"read",session_id:value.session_id,format:"text",offset:0,limit}};
      // 有界投影保留原消息身份；省略范围明确返回，正文仍沿原读取分页。
      while(Buffer.byteLength(JSON.stringify(result))>62000&&(messages.length||tools.length||receipts.length)){
        if(messages.length>1)messages.shift();else if(tools.length)tools.shift();else if(messages[0]?.text.length>4000){messages[0].text=messages[0].text.slice(0,4000);result.conversation.text_truncated=true;}else if(receipts.length)receipts.shift();else break;
      }
      result.conversation.receipts_complete=receipts.length===originalReceipts.length;
      result.conversation.complete=!result.conversation.text_truncated&&messages.length===value.messages.length&&tools.length===(value.tools?.length??0)&&result.conversation.receipts_complete;
    }
    if(Buffer.byteLength(JSON.stringify(result))>64000)throw Error("会话读取超过预算，请减小输出并读取确切交互请求。");return result;
  }
  #draftRead(value:SessionSnapshot,input:Record<string,any>){
    const text=value.draft??"",version=value.draft_version??0,offset=input.offset??0,limit=input.limit??4000;
    if(input.expected_draft_version!==undefined&&input.expected_draft_version!==version)throw Error("原草稿版本已变化，请重新读取原会话。");
    if(!Number.isSafeInteger(offset)||offset<0||offset>text.length||!Number.isSafeInteger(limit)||limit<1||limit>16000||offset&&/[\uDC00-\uDFFF]/.test(text[offset]))throw Error("草稿读取范围无效。");
    let end=Math.min(text.length,offset+limit);if(end<text.length&&/[\uDC00-\uDFFF]/.test(text[end]))end--;
    return {...compact(value),draft:text.slice(offset,end),draft_version:version,offset,next_offset:end<text.length?end:null,total_units:text.length};
  }
  async close(){await this.#sessions.stopAll();}
}

export async function serveAgentMachine(options:{directory:string;profile:string;bin:string;client:string}){
  if(![options.directory,options.profile,options.bin].every(value=>path.isAbsolute(value)))throw Error("会话宿主目录必须为绝对路径。");
  await mkdir(options.directory,{recursive:true,mode:0o700});const lease=path.join(options.directory,"lease.json"),instance=randomUUID();
  let handle;
  try{handle=await open(lease,"wx",0o600);}catch(error){
    if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
    const metadata=await lstat(lease);if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>4096)throw Error("原宿主租约无效。");
    const original=JSON.parse(await readFile(lease,"utf8"));let dead=false;try{process.kill(original.pid,0);}catch(cause){dead=(cause as NodeJS.ErrnoException).code==="ESRCH";}
    if(!dead)throw Error("原宿主仍在运行或状态未知。");
    const again=await lstat(lease);if(metadata.ino!==again.ino||metadata.mtimeMs!==again.mtimeMs)throw Error("原宿主租约已变化。");
    await rename(lease,lease+".stale-"+instance);handle=await open(lease,"wx",0o600);
  }
  await handle.writeFile(JSON.stringify({pid:process.pid,instance}));await handle.sync();await handle.close();
  const machine=new SessionMachine({profile:options.profile,bin:options.bin,directory:process.env.HETU_COLLABORATION_DIR!,client:options.client});
  const secret=randomBytes(32).toString("hex");let closing=false,pending=0,last=Date.now();
  const server=createServer(socket=>{
    let buffer=Buffer.alloc(0),received=false;socket.on("error",()=>{});socket.setTimeout(10000,()=>socket.destroy());
    socket.on("data",chunk=>{
      if(received)return;buffer=Buffer.concat([buffer,chunk]);if(buffer.length>1024*1024){socket.destroy();return;}const end=buffer.indexOf(10);if(end<0)return;received=true;
      let message:any;try{message=JSON.parse(buffer.subarray(0,end).toString());const provided=typeof message.secret==="string"?Buffer.from(message.secret):Buffer.alloc(0);if(end!==buffer.length-1||provided.length!==64||!timingSafeEqual(provided,Buffer.from(secret))||!message.input||closing||pending>=32)throw Error();}catch{socket.end(JSON.stringify({ok:false,error:"会话认证或请求无效。"})+"\n");return;}
      pending++;last=Date.now();socket.setTimeout(45000,()=>socket.destroy());
      void machine.request(message.input).then(result=>socket.end(JSON.stringify({ok:true,result})+"\n"),error=>socket.end(JSON.stringify({ok:false,error:error.message,unknown:error.unknown===true})+"\n")).finally(()=>{pending--;last=Date.now();});
    });
  });
  const close=async()=>{if(closing)return;closing=true;clearInterval(idle);server.close();await machine.close();const own=JSON.parse(await readFile(lease,"utf8"));if(own.instance===instance)await unlink(lease);};
    const idle=setInterval(()=>{if(!pending&&!machine.connected&&Date.now()-last>30*60*1000)void close();},30000);idle.unref();
  process.once("SIGTERM",()=>void close());process.once("SIGINT",()=>void close());
  try{await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});const address=server.address();if(!address||typeof address==="string")throw Error("外部会话宿主无法监听。");await atomicJson(path.join(options.directory,"instance.json"),{version:1,pid:process.pid,instance,port:address.port,secret});}
  catch(error){await close();throw error;}
  return {close};
}
if(process.env.HETU_AGENT_SERVICE==="1")await serveAgentMachine({directory:process.env.HETU_AGENT_SERVICE_DIR!,profile:process.env.HETU_AGENT_PROFILE!,bin:process.env.HETU_AGENT_BIN_DIR!,client:process.env.HETU_AGENT_CLIENT!});
