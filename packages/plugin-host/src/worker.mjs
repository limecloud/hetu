// 独立Node后端：插件不得把日志混入stdout，也不接收作者或文件句柄。
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
let backend;
let ready = false;
let closing = false;
let disposal;
let next = 0;
const pending = new Map();
const effects = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
console.log = console.info = console.warn = console.error = () => {};
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const request = (action, input) =>
  new Promise((resolve, reject) => {
    const id = "core-" + ++next;
    pending.set(id, { resolve, reject });
    send({
      jsonrpc: "2.0",
      id,
      method: "core/request",
      params: { action, input },
    });
  });
function dispose() {
  if (disposal) return disposal;
  closing = true;
  ready = false;
  disposal = (async () => {
    const errors = [];
    for (const cleanup of effects.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    for (const p of pending.values()) p.reject(new Error("插件关闭。"));
    pending.clear();
    if (errors.length) throw new AggregateError(errors, "插件清理失败。");
  })();
  return disposal;
}
let busy = false;
input.on("line", async (line) => {
  if (Buffer.byteLength(line) > 1024 * 1024) {
    process.exitCode = 1;
    input.close();
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    input.close();
    return;
  }
  if (typeof message.id === "string" && pending.has(message.id)) {
    const p = pending.get(message.id);
    pending.delete(message.id);
    message.error
      ? p.reject(new Error(message.error.message))
      : p.resolve(message.result);
    return;
  }
  if (message.jsonrpc !== "2.0" || typeof message.id !== "number") return;
  if (busy) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "插件正在执行前一操作。" },
    });
    return;
  }
  busy = true;
  try {
    let result;
    if (message.method === "initialize" && !ready && !closing) {
      if (
        Number(process.versions.node.split(".")[0]) < 25 ||
        !process.permission ||
        process.permission.has("net")
      ) {
        throw Object.assign(new Error("需要独立的受限Node 25+运行时。"), {
          code: "unsupported_node_runtime",
        });
      }
      backend = await import(pathToFileURL(process.argv[2]).href);
      await backend.apply?.({
        work_ref: message.params.work_ref,
        request,
        effect: (cleanup) => {
          if (closing || typeof cleanup !== "function") throw new Error("插件生命周期已结束或清理函数无效。");
          effects.push(cleanup);
        },
      });
      ready = true;
      result = { host_api: "1" };
    } else if (message.method === "invoke" && ready)
      result = await backend.invoke(
        message.params.action,
        message.params.input,
      );
    else if (message.method === "dispose") {
      await dispose();
      result = { disposed: true };
    } else throw new Error("插件未就绪或方法无效。");
    send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32000,
        message: "插件执行失败；写操作请保留原键查询。",
        data: {
          runtime_code:
            typeof error?.code === "string" ? error.code : "runtime_failure",
        },
      },
    });
  } finally {
    busy = false;
  }
});
input.on("close", () => {
  void dispose().catch(() => { process.exitCode = 1; });
});
