import type {AgentSessionEvent,SessionSnapshot} from "../agent-session-contract.ts";
type OutputEvent=Extract<AgentSessionEvent,{type:"terminal"}>;
type Options={read():Promise<SessionSnapshot>;reset(replay:string):Promise<void>;write(data:string):void;error(error:Error):void;inputStatus?(ready:boolean):void};

/** 固定输入代次，回放与实时数据按游标消重；缺段只回读原宿主。 */
export class TerminalStream {
  #current?:SessionSnapshot;
  #sequence=0;
  #pending:OutputEvent[]=[];
  #sync?:Promise<void>;
  #synced=false;
  #closed=false;
  private options:Options;
  constructor(options:Options){this.options=options;}
  get acceptsInput(){return !this.#closed&&this.#synced&&!!this.#current?.terminal_connected&&!this.#sync;}
  dispose(){this.#closed=true;this.#pending=[];this.options.inputStatus?.(false);}
  receive(event:OutputEvent){
    if(this.#closed)return;
    if(this.#sync||!this.#current){this.#pending.push(event);return;}
    if(!this.#apply(event)){this.#pending.push(event);void this.sync().catch(error=>{if(!this.#closed)this.options.error(error);});}
  }
  #apply(event:OutputEvent){
    const current=this.#current!;
    if(event.session_id!==current.session_id||event.generation<current.generation!||event.generation===current.generation&&event.sequence<=this.#sequence)return true;
    if(event.generation!==current.generation||event.sequence!==this.#sequence+1)return false;
    this.#sequence=event.sequence;this.options.write(event.data);return true;
  }
  sync():Promise<void>{
    if(this.#closed)return Promise.resolve();
    if(this.#sync)return this.#sync;
    this.#synced=false;
    this.options.inputStatus?.(false);
    this.#sync=Promise.resolve().then(async()=>{
      for(let attempt=0;attempt<3;attempt++){
        const snapshot=await this.options.read();
        if(this.#closed)return;
        if(!Number.isSafeInteger(snapshot.terminal_sequence)||!Number.isSafeInteger(snapshot.generation)||typeof snapshot.terminal_replay!=="string")throw Error("终端回放信息不完整，请核对当前会话。");
        await this.options.reset(snapshot.terminal_replay);
        if(this.#closed)return;
        this.#current=snapshot;this.#sequence=snapshot.terminal_sequence!;
        const queued=this.#pending;this.#pending=[];
        for(const event of queued)if(!this.#apply(event))this.#pending.push(event);
        if(!this.#pending.length){this.#synced=true;return;}
      }
      throw Error("终端输出尚未同步，请核对原线程后再输入。");
    }).finally(()=>{this.#sync=undefined;this.options.inputStatus?.(this.acceptsInput);});
    return this.#sync;
  }
}
