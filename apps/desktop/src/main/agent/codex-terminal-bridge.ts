import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import type { CodexWireMessage } from "./codex-rpc.ts";

const passiveMethods=new Set(["initialize","initialized","ping","thread/read","thread/list","thread/loaded/list","thread/turns/list","thread/items/list","thread/goal/get","model/list","account/read","account/rateLimits/read","config/read","configRequirements/read","skills/list","plugin/list","app/list","mcpServerStatus/list"]);
export const passiveTerminalMessage=(message:CodexWireMessage)=>!!message.method&&passiveMethods.has(message.method);

/** 透传原生TUI协议，只在确切响应处核对线程归属；不解析终端画面。 */
export class CodexTerminalBridge {
  #directory?: string;
  #server?: http.Server;
  #websockets?: WebSocketServer;
  #peers = new Set<WebSocket>();
  #ready?: Promise<void>;
  endpoint = "";
  token?: string;
  async open(options: {
    endpoint: string; token?: string;
    check(message: CodexWireMessage): void;
    thread(thread: any): Promise<void>;
    list(result: any): any;
  }) {
    this.#directory = await mkdtemp(path.join(os.tmpdir(), "hetu-codex-terminal-"));
    const server = http.createServer(); this.#server = server;
    const websockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false }); this.#websockets = websockets;
    if (process.platform === "win32") this.token = randomBytes(32).toString("hex");
    server.on("upgrade", (request, socket, head) => {
      if (this.token && request.headers.authorization !== "Bearer " + this.token) { socket.destroy(); return; }
      websockets.handleUpgrade(request, socket, head, peer => websockets.emit("connection", peer));
    });
    let ready: () => void;
    this.#ready = new Promise(resolve => { ready = resolve; });
    websockets.on("connection", (downstream: WebSocket) => {
      const url = options.endpoint.startsWith("unix://") ? "ws+unix://" + options.endpoint.slice(7) + ":/" : options.endpoint;
      const upstream = new WebSocket(url, { maxPayload: 8 * 1024 * 1024, perMessageDeflate: false, ...(options.token ? { headers: { Authorization: "Bearer " + options.token } } : {}) });
      this.#peers.add(downstream); this.#peers.add(upstream);
      const pending = new Map<number | string, string>();
      let incoming = Promise.resolve(), outgoing = Promise.resolve();
      const connected = new Promise<void>((resolve, reject) => { upstream.once("open", resolve); upstream.once("error", reject); });
      const send = (peer: WebSocket, message: unknown) => { if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(message)); };
      const fail = () => { downstream.close(); upstream.close(); };
      void connected.catch(fail);
      downstream.on("message", raw => {
        incoming = incoming.then(async () => {
          await connected;
          const message = JSON.parse(raw.toString()) as CodexWireMessage;
          try { options.check(message); }
          catch (error) { if(message.method && message.id!==undefined)send(downstream, { id: message.id, error: { code: -32602, message: (error as Error).message } });return; }
          if (message.method && message.id !== undefined) {
            pending.set(message.id, message.method);
          }
          send(upstream, message);
        }).catch(fail);
      });
      upstream.on("message", raw => {
        outgoing = outgoing.then(async () => {
          const message = JSON.parse(raw.toString()) as CodexWireMessage;
          const method = message.id === undefined || !("result" in message || "error" in message) ? undefined : pending.get(message.id);
          if (method) {
            pending.delete(message.id!);
            if (message.result && ["thread/start", "thread/resume", "thread/fork"].includes(method)) {
              try { await options.thread(message.result.thread); }
              catch (error) { send(downstream, { id: message.id, error: { code: -32603, message: (error as Error).message } }); return; }
              send(downstream, message); ready(); return;
            }
            if (method === "thread/list" && message.result) message.result = options.list(message.result);
          }
          send(downstream, message);
        }).catch(fail);
      });
      downstream.on("close", () => { this.#peers.delete(downstream); upstream.close(); });
      upstream.on("close", () => { this.#peers.delete(upstream); downstream.close(); });
      downstream.on("error", fail); upstream.on("error", fail);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if (process.platform === "win32") server.listen(0, "127.0.0.1", resolve);
      else server.listen(path.join(this.#directory!, "terminal.sock"), resolve);
    });
    this.endpoint = process.platform === "win32" ? "ws://127.0.0.1:" + (server.address() as { port: number }).port : "unix://" + path.join(this.#directory, "terminal.sock");
  }
  async ready() {
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([this.#ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Codex终端尚未恢复确切线程，请查看终端后继续。")), 30_000); })]); }
    finally { clearTimeout(timer); }
  }
  async close() {
    for (const peer of this.#peers) peer.terminate(); this.#peers.clear();
    this.#websockets?.close();
    if (this.#server) await new Promise<void>(resolve => this.#server!.close(() => resolve()));
    this.#server = undefined;
    if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
    this.#directory = undefined;
  }
}
