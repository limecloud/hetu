import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

type ObjectValue = Record<string, unknown>;
type Session = { csrf: string; requestID: string; code: string; state: "unpaired" | "pending" | "paired" | "revoked"; expires: number; events: Set<ServerResponse> };
type Start = { view_id: string; task_ref: ObjectValue; locale: "zh-CN" | "en"; theme: "light" | "dark"; lifetime_ms?: number };
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: ObjectValue, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const token = () => randomBytes(32).toString("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_, item: unknown) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/** 固定任务的页面适配器。批准和 Core 调用只经父进程 stdio，不暴露 HTTP 作者入口。 */
export async function serveLocalView(config: Start, send: (message: ObjectValue) => void) {
  if (!/^[a-zA-Z0-9-]{16,64}$/.test(config.view_id) || !object(config.task_ref) || !object(config.task_ref.scope_ref) ||
      !["workspace", "creation_project"].includes(String(config.task_ref.scope_ref.kind)) ||
      !/^[a-z_]+_[0-9a-f-]{36}$/.test(String(config.task_ref.scope_ref.id)) || !/^task_[0-9a-f-]{36}$/.test(String(config.task_ref.task_id)) ||
      !Number.isSafeInteger(config.task_ref.request_revision) || Number(config.task_ref.request_revision) < 1 ||
      !["zh-CN", "en"].includes(config.locale) || !["light", "dark"].includes(config.theme)) throw new Error("Invalid view configuration");
  const lifetime = config.lifetime_ms ?? 30 * 60_000;
  if (!Number.isSafeInteger(lifetime) || lifetime < 100 || lifetime > 30 * 60_000) throw new Error("Invalid view lifetime");
  const resources = new Map(await Promise.all(["index.html", "host.js", "task-view.html"].map(async file => [file, await readFile(new URL(`./${file}`, import.meta.url))] as const)));
  const sessions = new Map<string, Session>();
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let stopping = false;
  let origin = "";
  const cookieName = `hetu_${config.view_id.replaceAll("-", "")}`;
  const bound = canonical(config.task_ref);
  const requireRef = (ref: unknown) => { if (canonical(ref) !== bound) throw new Error("Task mismatch"); };
  const revoke = (session: Session) => {
    session.state = "revoked";
    for (const response of session.events) { response.write("event: revoked\ndata: {}\n\n"); response.end(); }
    session.events.clear();
  };
  const rpc = (action: string, input: unknown) => new Promise<unknown>((resolve, reject) => {
    if (stopping || pending.size >= 8) { reject(new Error("View unavailable")); return; }
    const id = token();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Operation outcome unconfirmed")); }, 12_000);
    pending.set(id, { resolve, reject, timer });
    send({ type: "request", view_id: config.view_id, id, action, input });
  });
  const route = (body: unknown): { action: string; input: ObjectValue; uri?: string } => {
    if (!object(body) || !exact(body, ["method", "params"]) || !object(body.params)) throw new Error("Invalid request");
    const params = body.params;
    if (body.method === "tools/call") {
      if (!exact(params, ["name", "arguments", "_meta"]) || !object(params.arguments)) throw new Error("Invalid tool");
      const input = params.arguments;
      requireRef(input.task_ref);
      if (params.name === "hetu_open_task_view" && exact(input, ["task_ref"])) return { action: "hetu.interactions.get", input };
      if (params.name === "hetu_save_task_selection" && exact(input, ["task_ref", "expected", "candidate_refs", "comment", "operation_key"])) return { action: "hetu.interactions.save_selection", input };
      throw new Error("Tool unavailable");
    }
    if (body.method === "resources/read" && exact(params, ["uri", "_meta"]) && typeof params.uri === "string") {
      const scope = config.task_ref.scope_ref as ObjectValue;
      const prefix = `hetu://task/${scope.kind}/${scope.id}/${config.task_ref.task_id}/operations/by-key?`;
      if (!params.uri.startsWith(prefix) || params.uri.includes("#")) throw new Error("Resource unavailable");
      const query = params.uri.slice(prefix.length);
      decodeURIComponent(query); // 拒绝损坏编码，不把替换字符当作原操作键。
      const search = new URLSearchParams(query);
      const keys = [...search.keys()];
      const key = search.get("key");
      if (keys.length !== 2 || !keys.includes("action") || !keys.includes("key") || search.get("action") !== "hetu.interactions.save_selection" || !key || key.length > 128 || /[\x00-\x1f]/.test(key)) throw new Error("Resource unavailable");
      return { action: "hetu.operations.get", input: { action: "hetu.interactions.save_selection", key }, uri: params.uri };
    }
    throw new Error("Method unavailable");
  };
  const json = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); };
  const body = async (request: IncomingMessage) => {
    if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new Error("JSON required");
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > 128 * 1024) throw new Error("Request too large"); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    const appCSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
    response.setHeader("Content-Security-Policy", request.url === "/view.html" ? appCSP : "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if (request.headers.host !== new URL(origin).host || request.headers["sec-fetch-site"] === "cross-site" || (request.headers.origin && request.headers.origin !== origin)) { json(response, 403, { error: "origin_rejected" }); return; }
    if (stopping) { json(response, 410, { error: "view_ended" }); return; }
    const id = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
    let session = id ? sessions.get(id) : undefined;
    if (session && session.expires <= Date.now()) revoke(session);
    if (request.method === "GET" && request.url === "/") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(resources.get("index.html")); return; }
    if (request.method === "GET" && request.url === "/host.js") { response.setHeader("Content-Type", "text/javascript; charset=utf-8"); response.end(resources.get("host.js")); return; }
    if (request.method === "GET" && request.url === "/api/session") {
      if (!session) {
        for (const [key, value] of sessions) if (value.expires <= Date.now()) { revoke(value); sessions.delete(key); }
        if (sessions.size >= 16) { json(response, 429, { error: "session_budget" }); return; }
        const next = token();
        session = { csrf: token(), requestID: token(), code: String(randomInt(100_000, 1_000_000)), state: "unpaired", expires: Date.now() + 120_000, events: new Set() };
        sessions.set(next, session);
        response.setHeader("Set-Cookie", `${cookieName}=${next}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
      }
      if (session.state === "revoked") { json(response, 410, { error: "session_ended" }); return; }
      json(response, 200, { state: session.state, csrf: session.csrf, code: session.state === "pending" ? session.code : undefined, locale: config.locale, theme: config.theme, task_ref: session.state === "paired" ? config.task_ref : undefined }); return;
    }
    if (!session || session.state === "revoked") { json(response, 403, { error: "pairing_required" }); return; }
    if (request.method === "POST") {
      if (request.headers.origin !== origin || request.headers["x-hetu-csrf"] !== session.csrf) { json(response, 403, { error: "csrf_rejected" }); return; }
      try {
        const input = await body(request);
        if (request.url === "/api/pair" && object(input) && Object.keys(input).length === 0) {
          if (session.state === "unpaired") { session.state = "pending"; send({ type: "pair_request", view_id: config.view_id, request_id: session.requestID, code: session.code }); }
          json(response, 200, { state: session.state, code: session.state === "pending" ? session.code : undefined }); return;
        }
        if (request.url === "/api/rpc" && session.state === "paired") {
          const operation = route(input);
          const result = await rpc(operation.action, operation.input);
          if (stopping || session.state !== "paired" || session.expires <= Date.now()) { revoke(session); json(response, 410, { error: "session_ended" }); return; }
          if (object(result) && object(result.error) && result.error.code === "forbidden") revoke(session);
          if (operation.uri) json(response, 200, { contents: [{ uri: operation.uri, mimeType: "application/json", text: JSON.stringify(result) }] });
          else json(response, 200, { content: [], structuredContent: result, isError: object(result) && !!result.error });
          return;
        }
        json(response, 403, { error: "action_unavailable" });
      } catch { json(response, 400, { error: "request_unconfirmed" }); }
      return;
    }
    if (session.state === "paired" && request.method === "GET" && request.url === "/view.html") {
      response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(resources.get("task-view.html")); return;
    }
    if (session.state === "paired" && request.method === "GET" && request.url === "/api/events") {
      if (session.events.size >= 2) { json(response, 429, { error: "connection_budget" }); return; }
      response.writeHead(200, { "Content-Type": "text/event-stream" }); response.write(": connected\n\n");
      session.events.add(response); response.on("close", () => session!.events.delete(response)); return;
    }
    json(response, 404, { error: "not_found" });
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local address unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  const stop = () => {
    if (stopping) return;
    stopping = true; clearInterval(expiry); clearTimeout(lifetimeTimer);
    for (const session of sessions.values()) revoke(session);
    sessions.clear();
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("View ended")); } pending.clear();
    server.close();
    setTimeout(() => server.closeAllConnections(), 100).unref();
    send({ type: "stopped", view_id: config.view_id });
  };
  const expiry = setInterval(() => { for (const session of sessions.values()) if (session.expires <= Date.now()) revoke(session); }, 500);
  const lifetimeTimer = setTimeout(stop, lifetime);
  return {
    url: origin + "/", stop,
    receive(message: unknown) {
      if (!object(message) || message.view_id !== config.view_id || stopping) return;
      if (message.type === "stop") { stop(); return; }
      if (["authorize", "deny"].includes(String(message.type))) {
        const session = [...sessions.values()].find(value => value.requestID === message.request_id);
        if (!session || session.state !== "pending" || session.expires <= Date.now()) return;
        if (message.type === "deny") revoke(session);
        else { session.state = "paired"; session.expires = Date.now() + Math.min(lifetime, 15 * 60_000); }
      }
      if (message.type === "response" && typeof message.id === "string") {
        const call = pending.get(message.id);
        if (call) { clearTimeout(call.timer); pending.delete(message.id); call.resolve(message.result); }
      }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = createInterface({ input: process.stdin });
  let view: Awaited<ReturnType<typeof serveLocalView>> | undefined;
  let starting = false;
  let inputClosed = false;
  const send = (value: ObjectValue) => { process.stdout.write(JSON.stringify(value) + "\n"); if (value.type === "stopped") lines.close(); };
  lines.on("line", (line: string) => {
    void (async () => {
      try {
        if (Buffer.byteLength(line) > 24 * 1024 * 1024) throw new Error("IPC budget");
        const message: unknown = JSON.parse(line);
        if (!view && !starting && object(message) && message.type === "start") {
          starting = true; view = await serveLocalView(message as Start & ObjectValue, send);
          if (inputClosed) { view.stop(); return; }
          send({ type: "ready", view_id: message.view_id, url: view.url });
        } else view?.receive(message);
      } catch { send({ type: "failure" }); view?.stop(); lines.close(); process.exitCode = 1; }
    })();
  });
  lines.on("close", () => { inputClosed = true; view?.stop(); });
  process.on("SIGTERM", () => { view?.stop(); lines.close(); });
  process.on("SIGINT", () => { view?.stop(); lines.close(); });
}
