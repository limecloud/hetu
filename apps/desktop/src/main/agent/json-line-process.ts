import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {StringDecoder} from "node:string_decoder";
import {terminateExternalChild} from "./external-child-lifecycle.ts";

type Pending={resolve(value:any):void;reject(error:Error):void;timer:NodeJS.Timeout;received?(value:any):void};
/** 有界JSONL传输。请求超时不重发；进程退出与请求失败分别反馈给应用层。 */
export class JsonLineProcess {
  #child:ChildProcessWithoutNullStreams;#pending=new Map<string,Pending>();#next=0;#buffer="";#decoder=new StringDecoder("utf8");#exit:Promise<void>;#closed=false;#failure?:Error;
  #closePromise?:Promise<void>;
  constructor(options:{binary:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;message(value:any):void;closed(error?:Error):void}){
    this.#child=spawn(options.binary,options.args,{cwd:options.cwd,env:options.env,stdio:["pipe","pipe","pipe"],shell:false,windowsHide:true,detached:process.platform!=="win32"});
    // stderr可能包含提供方私密信息，不转存或直接呈现。
    this.#child.stderr.resume();
    this.#child.stdout.on("data",chunk=>{
      try{
        this.#buffer+=this.#decoder.write(chunk);
        let end:number;
        while((end=this.#buffer.indexOf("\n"))>=0){const line=this.#buffer.slice(0,end);this.#buffer=this.#buffer.slice(end+1);if(Buffer.byteLength(line)>1024*1024)throw Error("外部协议单帧超过1MiB。");if(!line.trim())continue;const value=JSON.parse(line);if(!value||typeof value!=="object"||Array.isArray(value))throw Error("外部协议帧不是对象。");
          if(value.type==="control_response"&&value.response){const key=String(value.response.request_id),pending=this.#pending.get(key);if(pending){this.#pending.delete(key);clearTimeout(pending.timer);value.response.subtype==="error"?pending.reject(Error("提供方拒绝控制请求。")):this.#resolve(pending,value.response.response??{});continue;}}
          const key=String(value.id),pending=this.#pending.get(key);
          if(pending&&value.method===undefined&&(Object.hasOwn(value,"result")||Object.hasOwn(value,"error")||value.type==="response")){
            this.#pending.delete(key);clearTimeout(pending.timer);value.error||value.success===false?pending.reject(Error("提供方拒绝协议请求。")):this.#resolve(pending,value.result??value.data??value);
          }else options.message(value);
        }
        if(Buffer.byteLength(this.#buffer)>1024*1024)throw Error("外部协议未闭合帧超过1MiB。");
      }catch{this.#failure=Error("外部协议输出无效或超过预算；原运行结果待核对。");void this.close().catch(()=>{});}
    });
    this.#child.stdin.on("error",()=>{this.#failure=Error("外部协议输入连接已关闭；原发送结果待核对。");});
    this.#child.on("error",()=>{this.#failure=Error("无法启动外部CLI，请核对安装和可执行文件。");});
    this.#exit=new Promise(resolve=>this.#child.once("close",()=>{
      this.#closed=true;for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(this.#failure??Error("外部进程已退出；原请求结果待核对。"));}this.#pending.clear();options.closed(this.#failure);resolve();
    }));
  }
  get connected(){return !this.#closed&&!this.#failure;}
  // 在读取下一帧前应用回执，避免Promise续接将旧快照盖到后续通知上。
  #resolve(pending:Pending,value:any){try{pending.received?.(value);pending.resolve(value);}catch(error){pending.reject(error as Error);}}
  get processId(){return this.#child.pid;}
  send(value:unknown){if(!this.connected||this.#child.stdin.destroyed)throw Error("外部协议未连接，输入未发送。");const line=JSON.stringify(value),bytes=Buffer.byteLength(line);if(bytes>1024*1024)throw Error("外部协议请求超过1MiB。");if(this.#child.stdin.writableLength+bytes>2*1024*1024)throw Error("外部协议发送积压超过预算；本次输入未发送。");this.#child.stdin.write(line+"\n");}
  request(method:string,params:unknown={},timeout=30000,wire:"rpc"|"pi"|"claude"="rpc",received?:(value:any)=>void):Promise<any>{
    const id="hetu-"+(++this.#next);
    if(this.#pending.size>=64)return Promise.reject(Error("外部协议待回执请求超过预算。"));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.#pending.delete(id);reject(Error("外部协议请求超时；原运行结果待核对，不自动重发。"));},timeout);
      this.#pending.set(id,{resolve,reject,timer,received});
      try{this.send(wire==="pi"?{id,type:method,...params as object}:wire==="claude"?{type:"control_request",request_id:id,request:{subtype:method,...params as object}}:{jsonrpc:"2.0",id,method,params});}
      catch(error){this.#pending.delete(id);clearTimeout(timer);reject(error);}
    });
  }
  respond(id:string|number,result:unknown){this.send({jsonrpc:"2.0",id,result});}
  close(){
    if(this.#closePromise)return this.#closePromise;
    this.#closePromise=this.#close().catch(error=>{this.#closePromise=undefined;throw error;});
    return this.#closePromise;
  }
  async #close(){
    await terminateExternalChild(this.#child,this.#exit,()=>this.#closed);
  }
}
