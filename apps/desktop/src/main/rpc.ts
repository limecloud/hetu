import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
const MAX = 8 * 1024 * 1024;
export class AppServer {
  #child: ChildProcessWithoutNullStreams;
  #next = 0;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #closing: Promise<void> | undefined;
  #pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private constructor(binary: string, workspace?: string, gitAuthorizations?: string) {
    this.#child = spawn(
      binary,
      [
        "--stdio",
        ...(workspace ? ["--workspace", workspace] : ["--local"]),
        ...(process.env.HETU_PLUGIN_ACCESS_DIR
          ? ["--plugin-access-dir", process.env.HETU_PLUGIN_ACCESS_DIR]
          : []),
        ...(workspace && gitAuthorizations
          ? ["--git-authorizations-dir", gitAuthorizations]
          : []),
      ],
      { stdio: "pipe", windowsHide: true, shell: false },
    );
    this.#child.stdout.on("data", (bytes: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, bytes]);
      let end;
      while ((end = this.#buffer.indexOf(10)) >= 0) {
        if (end > MAX) {
          this.fail();
          return;
        }
        const line = this.#buffer.subarray(0, end);
        this.#buffer = this.#buffer.subarray(end + 1);
        try {
          const message = JSON.parse(line.toString("utf8"));
          if (message.jsonrpc !== "2.0" || typeof message.id !== "number")
            throw new Error();
          const pending = this.#pending.get(message.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.#pending.delete(message.id);
          message.error
            ? pending.reject(Object.assign(new Error(message.error.message), { code: message.error.data?.code }))
            : pending.resolve(message.result);
        } catch {
          this.fail();
          return;
        }
      }
      if (this.#buffer.length > MAX) this.fail();
    });
    this.#child.stderr.on("data", () => {});
    this.#child.stdin.on("error", () => this.fail());
    this.#child.on("error", () => this.fail());
    this.#child.on("exit", () => this.fail());
  }
  static async open(binary: string, workspace?: string, gitAuthorizations?: string) {
    const server = new AppServer(binary, workspace, gitAuthorizations);
    try {
      await server.request("initialize", {
        protocol_version: "1",
        client_name: "hetu-electron",
      });
      server.notify("initialized");
      return server;
    } catch (e) {
      server.fail();
      throw e;
    }
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.#closed)
      return Promise.reject(
        new Error("Core连接已关闭；写入请沿原操作键恢复。"),
      );
    const id = ++this.#next,
      bytes = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    if (Buffer.byteLength(bytes) > MAX)
      return Promise.reject(new Error("请求超过传输预算。"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("结果未知，请保留原操作键并回读。"));
      }, 30000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(bytes);
    });
  }
  notify(method: string) {
    if (!this.#closed)
      this.#child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method }) + "\n",
      );
  }
  fail() {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Core进程已退出；写入结果须按原操作查询。"));
    }
    this.#pending.clear();
    this.#child.kill();
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      if (this.#closed) return;
      const exited = new Promise<void>((resolve) => this.#child.once("close", resolve));
      // 退出阶段不重放业务；在途写入仍由已持久化的原操作键恢复。
      const timer = setTimeout(() => this.fail(), 1000);
      try {
        await this.request("shutdown", {});
        this.notify("exit");
        this.#child.stdin.end();
        await exited;
      } catch {
        this.fail();
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.#closing;
  }
}
