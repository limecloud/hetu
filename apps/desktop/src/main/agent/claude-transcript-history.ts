import path from "node:path";
import os from "node:os";
import {constants,type Stats} from "node:fs";
import {open,lstat,realpath,readdir,type FileHandle} from "node:fs/promises";
import {createHash} from "node:crypto";
import {boundedExternalHistory} from "./external-history.ts";
import type {ExternalMessage,ExternalHistoryPage} from "../../shared/external-session.ts";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE=512*1024*1024,MAX_LINE=2*1024*1024,MAX_ROWS=100000;
type Entry={id:string;parent?:string;offset:number;bytes:number;contentSha:string;prompt:boolean;caveat:boolean;conversation:boolean};
type Index={file:string;stamp:string;sha:string;contextSha:string;entries:Entry[]};
export type ClaudeHistoryCheckpoint={sha:string;context_sha:string;through:string|null;prefix:[string,string][];excluded:string[]};
const stamp=(s:{dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number})=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(":");
const stableValue=(value:any):any=>Array.isArray(value)?value.map(stableValue):value&&typeof value==="object"?Object.keys(value).sort().map(key=>[key,stableValue(value[key])]):value;
// 原生分支会改写运行目录和会话ID；逐条核对实际内容，不把这些运输字段当作正文。
const contentSha=(row:any)=>createHash("sha256").update(JSON.stringify(stableValue(Object.fromEntries(["type","subtype","message","attachment","rendered","isMeta"].filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]))))).digest("hex");
const caveat=(row:any)=>row.type==="user"&&row.isMeta===true&&typeof row.message?.content==="string"&&row.message.content.startsWith("<local-command-caveat>");
const prompt=(row:any)=>row.type==="user"&&row.isMeta!==true&&row.parent_tool_use_id==null&&(typeof row.message?.content==="string"||Array.isArray(row.message?.content)&&row.message.content.length>0&&row.message.content.every((part:any)=>part?.type==="text"||part?.type==="image"));
const textContent=(content:any):string=>typeof content==="string"?content:Array.isArray(content)?content.map(part=>{
  if(part?.type==="text")return typeof part.text==="string"?part.text:"";
  if(part?.type==="image")return "[图片]";
  if(part?.type==="tool_use")return "[工具调用："+String(part.name??"工具")+"]\n"+JSON.stringify(part.input??{});
  if(part?.type==="tool_result")return "[工具结果"+(part.is_error?"：失败":"")+"]\n"+textContent(part.content);
  if(part?.type==="thinking")return "[提供方思考记录]";
  return "[提供方内容："+String(part?.type??"未知")+"]";
}).join("\n"):"";

/** 只读取固定UUID的提供方日志；文件仍由Claude持有，宿主不复制第二份会话正文。 */
export class ClaudeTranscriptHistory {
  #index?:Index;
  private cwd:string;private configRoot:string;private sessionId:string;
  constructor(cwd:string,env:NodeJS.ProcessEnv,sessionId:string){
    if(!uuid.test(sessionId)||!path.isAbsolute(cwd)||env.CLAUDE_CONFIG_DIR!==undefined&&!path.isAbsolute(env.CLAUDE_CONFIG_DIR))throw Error("Claude历史范围或会话身份无效。");
    this.cwd=cwd;this.sessionId=sessionId;this.configRoot=env.CLAUDE_CONFIG_DIR??path.join(os.homedir(),".claude");
  }
  get revision(){return this.#index?.sha;}
  get contextRevision(){return this.#index?.contextSha;}
  async beforePrompt(before:string,expectedContext?:string):Promise<ClaudeHistoryCheckpoint>{
    if(!uuid.test(before))throw Error("Claude回退请求身份无效。");
    await this.page();const index=this.#index;
    if(!index||expectedContext&&expectedContext!==index.contextSha)throw Error("Claude会话内容或父链已由其他入口变化，请重新读取。");
    const position=index.entries.findIndex(entry=>entry.id===before);
    if(position<0||!index.entries[position].prompt)throw Error("Claude回退只能选择当前父链的用户请求。");
    let boundary=position+1;while(index.entries[boundary]?.caveat)boundary++;
    return {sha:index.sha,context_sha:index.contextSha,through:index.entries[boundary]?.id??null,prefix:index.entries.slice(boundary).map(entry=>[entry.id,entry.contentSha]),excluded:index.entries.slice(0,boundary).map(entry=>entry.id)};
  }
  async checkpoint(through:string,expectedSha?:string):Promise<ClaudeHistoryCheckpoint>{
    if(!uuid.test(through))throw Error("Claude分支消息身份无效。");
    await this.page();const index=this.#index;
    if(!index||expectedSha&&expectedSha!==index.sha)throw Error("Claude历史已由其他入口变化，请重新读取。");
    const position=index.entries.findIndex(entry=>entry.id===through);
    if(position<0)throw Error("Claude分支消息不在当前父链中。");
    const {handle}=await this.#open(index.file);
    try{
      const entry=index.entries[position],bytes=Buffer.alloc(entry.bytes);await handle.read(bytes,0,bytes.length,entry.offset);
      const row=JSON.parse(bytes.toString("utf8"));
      if(row.uuid!==through||row.type!=="assistant"||stamp(await handle.stat())!==index.stamp)throw Error("Claude分支必须固定当前父链的AI回复。");
    }finally{await handle.close();}
    return {sha:index.sha,context_sha:index.contextSha,through,prefix:index.entries.slice(position).map(entry=>[entry.id,entry.contentSha]),excluded:index.entries.slice(0,position).map(entry=>entry.id)};
  }
  async verifyFork(checkpoint:ClaudeHistoryCheckpoint){
    await this.page();const entries=this.#index?.entries,position=entries?.findIndex(entry=>entry.id===checkpoint.through),excluded=new Set(checkpoint.excluded);
    if(checkpoint.through===null){
      if(!entries||checkpoint.prefix.length||entries.some(entry=>entry.conversation||excluded.has(entry.id)))throw Error("Claude尚未确认回退到首轮请求之前。");return;
    }
    if(!entries||position===undefined||position<0||JSON.stringify(entries.slice(position).map(entry=>[entry.id,entry.contentSha]))!==JSON.stringify(checkpoint.prefix)||entries.some(entry=>excluded.has(entry.id)))throw Error("Claude原生分支未保留指定消息内容、父链或截断位置，请核对原操作。");
  }
  async exists(){return !!await this.#resolve();}
  async #resolve(){
    const root=await realpath(this.configRoot).catch(error=>{if(error.code==="ENOENT")return undefined;throw error;});if(!root)return undefined;
    const projects=path.join(root,"projects");let info;
    try{info=await lstat(projects);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}
    if(!info.isDirectory()||info.isSymbolicLink())throw Error("Claude历史目录不是固定普通目录。");
    const canonicalCwd=await realpath(this.cwd),keys=[...new Set([this.cwd,canonicalCwd].map(value=>value.replace(/[^a-zA-Z0-9]/g,"-")))];
    const candidate=async(name:string)=>{
      const directory=path.join(projects,name),file=path.join(directory,this.sessionId+".jsonl");
      try{
        const parent=await lstat(directory);if(!parent.isDirectory()||parent.isSymbolicLink())throw Error("Claude历史项目不是固定普通目录。");
        const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error("Claude固定历史不是普通文件。");return file;
      }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}
    };
    for(const key of keys){const file=await candidate(key);if(file)return file;}
    // 不枚举会话内容；较长目录的提供方编码可变，只按本次UUID查普通项目目录。
    const directories=await readdir(projects,{withFileTypes:true});if(directories.length>4096)throw Error("Claude项目目录超出本次身份查找预算。");
    const matches:string[]=[];
    for(const directory of directories){if(!directory.isDirectory()||keys.includes(directory.name))continue;const file=await candidate(directory.name);if(file)matches.push(file);}
    if(matches.length>1)throw Error("Claude原会话存在多个历史位置，请核对账户和目录。");return matches[0];
  }
  async #open(file:string){
    const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_FILE)throw Error("Claude历史不是普通文件或超过512MiB预算。");return {handle,stat};}catch(error){await handle.close();throw error;}
  }
  async #scan(file:string,handle:FileHandle,initial:Stats):Promise<Index>{
    const entries=new Map<string,Entry>(),digest=createHash("sha256"),canonicalCwd=await realpath(this.cwd);
    let position=0,start=0,pending=Buffer.alloc(0),leaf:string|undefined,scopeSeen=false;
    const row=(line:Buffer,offset:number,bytes:number)=>{
      if(line.length>MAX_LINE)throw Error("Claude历史单行超过2MiB预算。");if(!line.toString("utf8").trim())return;
      let value:any;try{value=JSON.parse(line.toString("utf8"));}catch{throw Error("Claude历史包含未完成或无效记录，请稍后读取。");}
      if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Claude历史记录格式无效。");
      if(value.sessionId!==undefined&&value.sessionId!==this.sessionId)throw Error("Claude历史记录属于不同会话。");
      if(value.cwd!==undefined){if(typeof value.cwd!=="string"||path.resolve(value.cwd)!==canonicalCwd&&path.resolve(value.cwd)!==path.resolve(this.cwd))throw Error("Claude历史目录与固定范围不同。");scopeSeen=true;}
      if(value.type==="last-prompt"&&Object.hasOwn(value,"leafUuid")){
        if(value.leafUuid!==null&&(typeof value.leafUuid!=="string"||!uuid.test(value.leafUuid)))throw Error("Claude历史末端身份无效。");leaf=value.leafUuid??undefined;return;
      }
      if(value.isSidechain===true||typeof value.uuid!=="string"||!("parentUuid" in value)&&!['user','assistant','system'].includes(value.type))return;
      if(!uuid.test(value.uuid))throw Error("Claude历史条目身份无效。");
      const parent=value.logicalParentUuid??value.parentUuid;
      if(parent!==null&&parent!==undefined&&(typeof parent!=="string"||!uuid.test(parent)))throw Error("Claude历史父条目身份无效。");
      entries.set(value.uuid,{id:value.uuid,parent:parent??undefined,offset,bytes,contentSha:contentSha(value),prompt:prompt(value),caveat:caveat(value),conversation:prompt(value)||value.type==="assistant"});leaf=value.uuid;
      if(entries.size>MAX_ROWS)throw Error("Claude历史索引超过十万条预算。");
    };
    const buffer=Buffer.alloc(64*1024);
    while(position<initial.size){
      const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,initial.size-position),position);if(!bytesRead)throw Error("Claude历史在读取期间被截断。");
      digest.update(buffer.subarray(0,bytesRead));pending=Buffer.concat([pending,buffer.subarray(0,bytesRead)]);position+=bytesRead;
      let end:number;while((end=pending.indexOf(10))>=0){row(pending.subarray(0,end),start,end+1);start+=end+1;pending=pending.subarray(end+1);}
      if(pending.length>MAX_LINE)throw Error("Claude历史单行超过2MiB预算。");
    }
    if(pending.length)row(pending,start,pending.length);
    if(stamp(await handle.stat())!==stamp(initial))throw Error("Claude历史在扫描期间已变化，请刷新。");
    if(entries.size&&!scopeSeen)throw Error("Claude历史缺少可核验的固定工作目录。");
    const chain:Entry[]=[],seen=new Set<string>();
    while(leaf){if(seen.has(leaf))throw Error("Claude历史父链存在循环。");seen.add(leaf);const entry=entries.get(leaf);if(!entry)throw Error("Claude历史父链不完整，请在原生CLI核对。");chain.push(entry);leaf=entry.parent;}
    const contextSha=createHash("sha256").update(JSON.stringify(chain.map(entry=>[entry.id,entry.parent,entry.contentSha]))).digest("hex");
    return {file,stamp:stamp(initial),sha:digest.digest("hex"),contextSha,entries:chain};
  }
  async page(cursor?:string):Promise<ExternalHistoryPage>{
    const file=await this.#resolve();if(!file){if(cursor)throw Error("Claude原历史已不可用。");return {messages:[],truncated:false};}
    const {handle,stat}=await this.#open(file);
    try{
      if(!this.#index||this.#index.file!==file||this.#index.stamp!==stamp(stat)){
        if(cursor)throw Error("Claude历史文件已变化，请从第一页读取。");this.#index=await this.#scan(file,handle,stat);
      }
      const index=this.#index;let offset=0;
      if(cursor){
        if(typeof cursor!=="string"||cursor.length>8192||!/^[a-zA-Z0-9_-]+$/.test(cursor))throw Error("Claude历史游标无效或超过预算。");
        let value:any;try{value=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));}catch{throw Error("Claude历史游标无效。");}
        if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="offset,session,sha"||value.session!==this.sessionId||value.sha!==index.sha||!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>=index.entries.length)throw Error("Claude历史游标不属于原会话或快照。");offset=value.offset;
      }
      const messages:ExternalMessage[]=[];let end=offset;
      while(end<index.entries.length&&messages.length<8){
        const entry=index.entries[end++],bytes=Buffer.alloc(entry.bytes);const read=await handle.read(bytes,0,bytes.length,entry.offset);if(read.bytesRead!==bytes.length)throw Error("Claude历史条目已变化。");
        const value=JSON.parse(bytes.toString("utf8"));if(value.uuid!==entry.id||value.sessionId!==undefined&&value.sessionId!==this.sessionId)throw Error("Claude历史条目身份已变化。");
        const content=textContent(value.message?.content);
        const toolResult=Array.isArray(value.message?.content)&&value.message.content.length>0&&value.message.content.every((part:any)=>part.type==="tool_result");
        if(content)messages.push({id:entry.id,role:toolResult?"tool":value.type==="assistant"?"assistant":value.type==="system"||value.isMeta===true?"system":"user",text:content,...(value.type==="assistant"||entry.prompt?{turn_id:entry.id}:{})});
        else if(value.type==="system"&&value.subtype==="compact_boundary")messages.push({id:entry.id,role:"system",text:"[提供方已压缩上下文]"});
        else if(value.type==="attachment")messages.push({id:entry.id,role:"system",text:"[会话附件："+String(value.attachment?.type??"未知")+"]\n"+(typeof value.rendered==="string"?value.rendered:JSON.stringify(value.attachment??{}))});
        else messages.push({id:entry.id,role:"system",text:"[提供方记录："+String(value.subtype??value.type)+"]",truncated:true});
      }
      if(stamp(await handle.stat())!==index.stamp)throw Error("Claude历史在分页期间已变化，请刷新。");
      const next=end<index.entries.length?Buffer.from(JSON.stringify({session:this.sessionId,sha:index.sha,offset:end})).toString("base64url"):undefined;
      return boundedExternalHistory(messages.reverse(),next);
    }finally{await handle.close();}
  }
}
