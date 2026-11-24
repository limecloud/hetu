import * as pty from "node-pty";
import {TerminalStatus} from "./terminal-status.ts";

export class CodexTerminal {
  #pty?: pty.IPty;
  #replay = "";
  #exited?: Promise<void>;
  #disposing = false;
  #status=new TerminalStatus();
  #sequence=0;
  get connected() { return !!this.#pty; }
  get pid() { return this.#pty?.pid; }
  get replay() { return this.#replay; }
  get sequence() { return this.#sequence; }
  get programState(){return this.#status.state;}
  start(options: { binary: string; endpoint: string; thread: string; cwd: string; env: NodeJS.ProcessEnv; token?: string; onData: (text: string) => void; onExit: () => void }) {
    const args = ["resume", "--remote", options.endpoint, options.thread, "-c", "check_for_update_on_startup=false"];
    const env = { ...options.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
    if (options.token) { args.push("--remote-auth-token-env", "HETU_CODEX_TRANSPORT_TOKEN"); Object.assign(env, { HETU_CODEX_TRANSPORT_TOKEN: options.token }); }
    this.startProcess({...options,args,env});
  }
  startProcess(options: { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; onData: (text: string) => void; onExit: () => void }) {
    if (this.#pty) return;
    this.#replay = "";
    this.#sequence=0;
    this.#status=new TerminalStatus();
    const {args}=options,env={...options.env,TERM:"xterm-256color",COLORTERM:"truecolor"};
    const terminal = pty.spawn(options.binary, args, { cwd: options.cwd, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), cols: 100, rows: 30, name: "xterm-256color" });
    this.#pty = terminal; this.#disposing = false;
    this.#exited = new Promise(resolve => terminal.onExit(() => { if(this.#pty===terminal){this.#pty = undefined;if (!this.#disposing) options.onExit();}resolve(); }));
    terminal.onData(data => { if(this.#pty!==terminal)return;this.#status.write(data);this.#replay = (this.#replay + data).slice(-1_000_000);this.#sequence++;options.onData(data); });
  }
  write(data: string) {
    if (typeof data !== "string" || Buffer.byteLength(data) > 64 * 1024) throw new Error("终端输入超过预算。");
    if (!this.#pty) throw new Error("终端未连接，输入尚未发送。");
    this.#pty.write(data);
  }
  resize(cols: number, rows: number) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 1000 || rows < 2 || rows > 500) throw new Error("终端尺寸无效。");
    this.#pty?.resize(cols, rows);
  }
  async readyForInput(){
    const deadline=Date.now()+30_000;
    while(this.connected && !["idle","done","error"].includes(this.programState??"") && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
    if(!this.connected)throw new Error("Codex终端已退出，草稿尚未插入。");
    if(!["idle","done","error"].includes(this.programState??""))throw new Error("Codex终端仍在启动或等待输入，请完成原生提示后再放入请求。");
  }
  async close() {
    const terminal = this.#pty; if (!terminal) return;
    this.#disposing = true; terminal.kill();
    await Promise.race([this.#exited, new Promise((_, reject) => setTimeout(() => reject(new Error("终端客户端退出仍待核对。")), 3000))]);
  }
}
