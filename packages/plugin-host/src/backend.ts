import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { realpathSync } from "node:fs";
import Ajv from "ajv";
import {
  dataActions,
  dataWriteActions,
  dataCacheActions,
  sameWork,
  type PluginBridge,
  type WorkRef,
} from "@hetu/plugin-sdk";
import type { PluginPackage } from "./package.ts";
export class BackendSupervisor {
  #effect: "read" | "managed_write" | undefined;
  #operationKey: string | undefined;
  #callbacks = 0;
  #child: ChildProcessWithoutNullStreams;
  #buffer = "";
  #next = 0;
  #closed = false;
  #pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #pkg: PluginPackage;
  readonly #work: WorkRef;
  readonly #request: PluginBridge["request"];
  constructor(options: {
    node: string;
    bootstrap: string;
    snapshot: string;
    pkg: PluginPackage;
    work_ref: WorkRef;
    request: PluginBridge["request"];
    electron?: boolean;
  }) {
    this.#pkg = options.pkg;
    this.#work = options.work_ref;
    this.#request = options.request;
    if (!options.pkg.manifest.runtime) throw new Error("此插件没有Node后端。");
    const snapshot = realpathSync(options.snapshot),
      bootstrap = realpathSync(options.bootstrap);
    this.#child = spawn(
      options.node,
      [
        "--permission",
        "--max-old-space-size=128",
        "--no-addons",
        "--disable-proto=throw",
        "--allow-fs-read=" + snapshot,
        "--allow-fs-read=" + bootstrap,
        bootstrap,
        path.join(snapshot, options.pkg.manifest.runtime.entry),
      ],
      {
        stdio: "pipe",
        windowsHide: true,
        shell: false,
        env: {
          PATH: process.env.PATH,
          ...(options.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
      },
    );
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (text: string) => {
      this.#buffer += text;
      let index;
      while ((index = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        if (Buffer.byteLength(line) > 1024 * 1024) {
          this.close();
          return;
        }
        try {
          void this.message(JSON.parse(line)).catch(() => this.close());
        } catch {
          this.close();
          return;
        }
      }
      if (Buffer.byteLength(this.#buffer) > 1024 * 1024) this.close();
    });
    this.#child.stderr.on("data", () => {});
    this.#child.on("error", () => this.close());
    this.#child.on("exit", () => this.close());
    this.#child.stdin.on("error", () => this.close());
  }
  async message(message: any) {
    if (message.jsonrpc !== "2.0") throw new Error("插件协议无效。");
    if (message.method === "core/request") {
      const params = message.params;
      if (
        typeof message.id !== "string" ||
        !dataActions.includes(params?.action)
      )
        throw new Error("插件请求了未声明的核心动作。");
      if (
        params.input?.work_ref &&
        !sameWork(params.input.work_ref, this.#work)
      )
        throw new Error("插件请求了其他作品。");
      if (++this.#callbacks > 256) throw new Error("插件调用超过单次预算。");
      if (dataCacheActions.includes(params.action) && this.#effect !== "managed_write")
        throw new Error("只读插件动作不能重建派生缓存。");
      if (
        dataWriteActions.includes(params.action) &&
        (this.#effect !== "managed_write" ||
          params.input?.operation_key !== this.#operationKey)
      )
        throw new Error("插件动作不能扩大写入权限或更换原操作键。");
      const result = await this.#request(params.action, {
        ...params.input,
        work_ref: this.#work,
      });
      this.send({ jsonrpc: "2.0", id: message.id, result });
      return;
    }
    if (typeof message.id !== "number") throw new Error("插件响应无效。");
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    message.error
      ? pending.reject(
          new Error(
            message.error.message +
              " " +
              (message.error.data?.runtime_code ?? ""),
          ),
        )
      : pending.resolve(message.result);
  }
  send(message: unknown) {
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > 1024 * 1024)
      throw new Error("插件消息超过预算。");
    this.#child.stdin.write(line);
  }
  rpc(method: string, params: unknown) {
    if (this.#closed)
      return Promise.reject(new Error("插件已停止；写入请沿原键查询。"));
    return new Promise((resolve, reject) => {
      const id = ++this.#next;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("插件超时；写入结果须沿原键查询。"));
        this.close();
      }, 30000);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }
  initialize() {
    return this.rpc("initialize", {
      work_ref: this.#work,
      plugin_id: this.#pkg.manifest.id,
      package_sha256: this.#pkg.sha256,
      host_api: "1",
    });
  }
  invoke(action: string, input: unknown) {
    const declaration = this.#pkg.manifest.contributions.actions.find(
      (a) => a.id === action,
    );
    if (!declaration) throw new Error("插件动作未声明。");
    const validate = new Ajv({ strict: false }).compile(
      declaration.input_schema,
    );
    if (!validate(input)) throw new Error("插件动作参数不符合Schema。");
    if (this.#effect) throw new Error("插件正在执行其他动作。");
    if (
      declaration.effect === "managed_write" &&
      (!input ||
        typeof input !== "object" ||
        typeof (input as any).operation_key !== "string")
    )
      throw new Error("插件写动作需要固定原操作键。");
    this.#effect = declaration.effect;
    this.#operationKey = (input as any)?.operation_key;
    this.#callbacks = 0;
    return this.rpc("invoke", { action, input }).finally(() => {
      this.#effect = undefined;
      this.#operationKey = undefined;
    });
  }
  async dispose() {
    if (this.#closed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.rpc("dispose", {}),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("插件清理超时。")), 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.close();
    }
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("插件进程已退出；保留原操作查询。"));
    }
    this.#pending.clear();
    this.#child.kill();
  }
}
