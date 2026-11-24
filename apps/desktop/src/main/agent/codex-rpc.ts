import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";

export class CodexRpcError extends Error {
  delivery: "not_sent" | "rejected" | "unknown";
  constructor(message: string, delivery: "not_sent" | "rejected" | "unknown") { super(message); this.delivery = delivery; }
}
export type CodexWireMessage = { id?: string | number; method?: string; params?: any; result?: any; error?: { message?: string } };
export type CodexRpcOptions = {
  binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  transport?: "socket" | "stdio"; timeout?: number;
  message: (value: CodexWireMessage) => void; disconnected: (reason: string) => void;
};
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** 仅负责Codex传输与受管进程，不推断轮次或作品执行结果。 */
export class CodexRpc {
  #child?: ChildProcessWithoutNullStreams;
  #socket?: WebSocket;
  #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #next = 0;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #lastError?: string;
  #directory?: string;
  #endpoint?: string;
  #token?: string;
  #exit?: Promise<void>;
  private options: CodexRpcOptions;
  constructor(options: CodexRpcOptions) { this.options = options; }
  get endpoint() { return this.#endpoint; }
  get pid() { return this.#child?.pid; }
  get running() { return !!this.#child?.pid && this.#child.exitCode === null && this.#child.signalCode === null; }
  get token() { return this.#token; }
  get connected() { return !this.#closed && !!this.#child && (this.options.transport === "stdio" || this.#socket?.readyState === WebSocket.OPEN); }
  async waitForExit(milliseconds:number){
    if(!this.running)return true;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([this.#exit,new Promise(resolve=>{timer=setTimeout(resolve,milliseconds);})]);return !this.running;}
    finally{if(timer)clearTimeout(timer);}
  }

  async open(): Promise<void> {
    const args = [...this.options.args];
    if (this.options.transport !== "stdio") {
      this.#directory = await mkdtemp(path.join(os.tmpdir(), "hetu-codex-"));
      if (process.platform === "win32") {
        const port = await new Promise<number>((resolve, reject) => {
          const server = net.createServer(); server.once("error", reject);
          server.listen(0, "127.0.0.1", () => { const value = server.address() as net.AddressInfo; server.close(error => error ? reject(error) : resolve(value.port)); });
        });
        this.#endpoint = `ws://127.0.0.1:${port}`;
        this.#token = randomBytes(32).toString("hex");
        const tokenPath = path.join(this.#directory, "transport-token");
        await writeFile(tokenPath, this.#token, { mode: 0o600 });
        args.push("--ws-auth", "capability-token", "--ws-token-file", tokenPath);
      } else this.#endpoint = "unix://" + path.join(this.#directory, "rpc.sock");
      args.push("--listen", this.#endpoint);
    }
    const child = spawn(this.options.binary, args, { cwd: this.options.cwd, env: this.options.env, stdio: "pipe", windowsHide: true, shell: false, detached: process.platform !== "win32" });
    this.#child = child;
    this.#exit = new Promise(resolve => child.once("exit", () => resolve()));
    child.once("error", error => this.#disconnect(error.message));
    child.once("exit", (code, signal) => this.#disconnect(`Codex进程已退出（${code ?? signal ?? "未知"}）。`));
    child.stderr.on("data", () => { /* 诊断不携带创作输入进入普通日志。 */ });
    child.stdin.on("error", error => this.#disconnect(error.message));
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.options.transport !== "stdio" || this.#closed) return;
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      let end: number;
      while ((end = this.#buffer.indexOf(10)) >= 0) {
        if (end > MAX_MESSAGE_BYTES) { this.#disconnect("Codex消息超过传输预算。"); return; }
        const line = this.#buffer.subarray(0, end); this.#buffer = this.#buffer.subarray(end + 1);
        if (line.length) this.#receive(line.toString("utf8"));
      }
      if (this.#buffer.length > MAX_MESSAGE_BYTES) this.#disconnect("Codex消息超过传输预算。");
    });
    if (this.options.transport === "stdio") return;
    const deadline = Date.now() + (this.options.timeout ?? 30_000);
    while (!this.#closed && Date.now() < deadline) {
      try { await this.#connect(); return; }
      catch { if (!this.#closed) await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    throw new CodexRpcError(this.#lastError ?? "无法连接受管Codex服务，请核对安装版是否支持App Server与remote模式。", "not_sent");
  }

  async reconnect() {
    if (!this.running || this.options.transport === "stdio") throw new Error("原服务已退出，无法仅恢复观察连接。");
    this.#socket?.removeAllListeners(); this.#socket?.on("error",()=>{}); this.#socket?.terminate();
    this.#closed = false;
    try { await this.#connect(); } catch(error) { this.#closed = true; throw new Error("原Codex服务仍保留，但观察连接尚未恢复："+(error as Error).message); }
  }

  async #connect() {
    const endpoint = this.#endpoint!;
    const url = endpoint.startsWith("unix://") ? "ws+unix://" + endpoint.slice(7) + ":/" : endpoint;
    const socket = new WebSocket(url, { maxPayload: MAX_MESSAGE_BYTES, handshakeTimeout: 1000, perMessageDeflate: false, ...(this.#token ? { headers: { Authorization: "Bearer " + this.#token } } : {}) });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    this.#socket = socket;
    socket.on("message", value => this.#receive(value.toString()));
    socket.on("close", () => this.#disconnect("Codex连接中断，待核对原线程和原操作。"));
    socket.on("error", error => this.#disconnect(error.message));
  }

  request(method: string, params: unknown, onWritten?: () => void): Promise<any> {
    if (!this.connected) return Promise.reject(new CodexRpcError("Codex连接不可用，尚未发送。", "not_sent"));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new CodexRpcError("Codex请求超时，结果待核对；请查询原线程。", "unknown")); }, this.options.timeout ?? 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }, onWritten); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(new CodexRpcError((error as Error).message, "not_sent")); }
    });
  }

  write(value: unknown, onWritten?: () => void): void {
    if (!this.connected) throw new CodexRpcError("Codex连接已关闭。", "not_sent");
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > MAX_MESSAGE_BYTES) throw new CodexRpcError("消息超过传输预算。", "not_sent");
    const written = (error?: Error | null) => { if (error) this.#disconnect(error.message); else onWritten?.(); };
    if (this.options.transport === "stdio") this.#child!.stdin.write(bytes + "\n", written);
    else this.#socket!.send(bytes, written);
  }

  #receive(text: string) {
    if (this.#closed) return;
    try {
      const value = JSON.parse(text) as CodexWireMessage;
      if (value.id !== undefined && ("result" in value || "error" in value)) {
        const pending = this.#pending.get(value.id as number);
        if (!pending) return;
        clearTimeout(pending.timer); this.#pending.delete(value.id as number);
        if (value.error) pending.reject(new CodexRpcError(value.error.message || "Codex拒绝了请求。", "rejected"));
        else pending.resolve(value.result);
      } else this.options.message(value);
    } catch { this.#disconnect("Codex返回了无效的协议消息，已保留原会话。"); }
  }
  #disconnect(reason: string) {
    if (this.#closed) return;
    this.#closed = true; this.#lastError=reason;
    for (const request of this.#pending.values()) { clearTimeout(request.timer); request.reject(new CodexRpcError(reason, "unknown")); }
    this.#pending.clear(); this.options.disconnected(reason);
  }
  async close(): Promise<void> {
    const child = this.#child;
    this.#disconnect("Codex受管服务已关闭，未完成的请求保留待核对。");
    this.#socket?.terminate();
    if (child?.pid) {
      if (process.platform === "win32") {
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve,reject)=>execFile("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true},error=>error?reject(new Error("Codex进程树退出仍待核对。")):resolve()));
          await this.#exit;
        }
      } else {
        const active = () => { try { process.kill(-child.pid!,0);return true; } catch(error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
        const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!,signal); } catch(error) { if((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
        const until = async(milliseconds:number) => { const deadline=Date.now()+milliseconds;while(active() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));return !active(); };
        if(active()) { kill("SIGTERM");if(!await until(1500)) { kill("SIGKILL");if(!await until(3000)) throw new Error("无法确认Codex受管进程组退出，已保留会话占用。"); } }
      }
    }
    this.#child = undefined;
    if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
  }
}
