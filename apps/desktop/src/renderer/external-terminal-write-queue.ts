type Target = {session_id?:string;generation?:number};
export type TerminalMutation = Target & (
  {method:"session_input";data:string} |
  {method:"session_resize";cols:number;rows:number}
);
type Waiter = {resolve(value:unknown):void;reject(error:Error):void};
type Entry = {input:TerminalMutation;key:string;bytes:number;waiters:Waiter[]};

/** 只合并尚未派发的相邻输入；原键派发后不修改字节，失败冻结后续写入。 */
export class TerminalWriteQueue {
  #entries:Entry[]=[];
  #running?:Promise<void>;
  #scheduled=false;
  #bytes=0;
  #count=0;
  #error?:Error;
  private dispatch:(input:TerminalMutation & {operation_key:string})=>Promise<any>;
  private failed:(error:Error)=>void;
  constructor(dispatch:(input:TerminalMutation & {operation_key:string})=>Promise<any>,failed:(error:Error)=>void){this.dispatch=dispatch;this.failed=failed;}

  enqueue(input:TerminalMutation):Promise<unknown>{
    if(this.#error)return Promise.reject(this.#error);
    const bytes=new TextEncoder().encode(JSON.stringify(input)).length;
    if(this.#count>=64||this.#bytes+bytes>65536){
      const error=Error("终端输入积压超过预算，请等待并核对原输入回执。");
      this.failed(error);return Promise.reject(error);
    }
    this.#bytes+=bytes;this.#count++;
    const tail=this.#entries.at(-1);
    const same=tail?.input.session_id===input.session_id&&tail?.input.generation===input.generation;
    let entry:Entry;
    if(tail&&same&&tail.input.method===input.method){
      if(tail.input.method==="session_input"&&input.method==="session_input")tail.input={...tail.input,data:tail.input.data+input.data};
      else tail.input={...input};
      tail.bytes+=bytes;entry=tail;
    }else{
      entry={input:{...input},key:crypto.randomUUID(),bytes,waiters:[]};this.#entries.push(entry);
    }
    const result=new Promise((resolve,reject)=>entry.waiters.push({resolve,reject}));
    this.#schedule();return result;
  }

  #schedule(){
    if(this.#scheduled||this.#running||this.#error)return;
    this.#scheduled=true;
    queueMicrotask(()=>{this.#scheduled=false;this.#start();});
  }
  #start(){
    if(this.#running||this.#error||!this.#entries.length)return;
    this.#running=this.#drain().finally(()=>{this.#running=undefined;if(this.#entries.length)this.#schedule();});
  }
  async #drain(){
    while(this.#entries.length){
      const entry=this.#entries.shift()!;
      try{
        const receipt=await this.dispatch({...entry.input,operation_key:entry.key});
        if(receipt?.state!=="succeeded")throw Error("终端输入回执待核对，请查询原操作；后续输入未派发。");
        for(const waiter of entry.waiters)waiter.resolve(receipt);
      }catch(cause){
        this.#error=cause instanceof Error?cause:Error(String(cause));
        for(const pending of [entry,...this.#entries])for(const waiter of pending.waiters)waiter.reject(this.#error);
        this.#entries=[];this.#bytes=0;this.#count=0;this.failed(this.#error);return;
      }
      this.#bytes-=entry.bytes;this.#count-=entry.waiters.length;
    }
  }
  async flush(){
    while(this.#running||this.#entries.length){this.#start();await this.#running;}
    if(this.#error)throw this.#error;
  }
}
