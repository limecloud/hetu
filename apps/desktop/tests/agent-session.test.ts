import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AcpSession, AgentSession, ClaudeSession, agentSessionPersistPath, agentSessionSandbox, buildAgentSessionPrompt, buildCodexAppServerArgs, serializeAgentSessionContext } from "../src/main/agent-session.ts";

test("Agent会话上下文是类型化作品引用，不暴露工作区绝对路径", () => {
  const context = JSON.parse(serializeAgentSessionContext({
    schema_version: "1",
    work_ref: { workspace_id: "ws-context", kind: "novel", object_id: "novel-context" },
    scope: "current_work_only",
    machine_entrypoint: "hetu CLI/MCP",
    first_action: "先发现实际能力",
  }));
  assert.deepEqual(context.work_ref, { workspace_id: "ws-context", kind: "novel", object_id: "novel-context" });
  assert.equal(context.scope, "current_work_only");
  assert.equal("workspace_path" in context, false);
  const prompt = buildAgentSessionPrompt(context, "读取当前章节的固定来源");
  assert.doesNotMatch(prompt, /grant-context|management_ref/);
  assert.doesNotMatch(prompt, /workspace_path|\/tmp/);
  const sandbox = agentSessionSandbox("/private/profile", { workspace_id: "/作品/甲", kind: "novel", object_id: "章节/一" });
  assert.equal(sandbox.startsWith("/private/profile/agent-sessions/sandbox/"), true);
  assert.doesNotMatch(sandbox, /作品\/甲|章节\/一/);
  const persisted = agentSessionPersistPath("/private/profile", { workspace_id: "ws/context", kind: "novel", object_id: "chapter/一" });
  assert.match(persisted, /agent-sessions\/ws_2Fcontext-novel-chapter_2F_E4_B8_80\.json$/);
  const args = buildCodexAppServerArgs("/Applications/Hetu/bin/hetu-mcp", "/private/collaboration", { workspace_id: "workspace_test", kind: "novel", object_id: "novel_test" },"/private/shared-settings");
  assert.deepEqual(args.slice(0, 3), ["app-server", "-c", 'mcp_servers.hetu.command="/Applications/Hetu/bin/hetu-mcp"']);
  assert.ok(args.some(value => value.includes("--collaboration-dir")));
  assert.ok(args.some(value => value.includes("--work-ref")));
  assert.ok(args.includes('mcp_servers.hetu.env.HETU_LOCAL_SETTINGS_DIR="/private/shared-settings"'));
  assert.doesNotMatch(args.join(" "), /management_ref|workspace_path/);
});

test("独立 Agent 会话建立线程、接收增量并沿线程持久化", async () => {
  const directory = await mkdtemp("/tmp/hetu-agent-session-test-");
  const binary = path.join(directory, "fake-codex");
  const responsePath = path.join(directory, "approval-response.json");
  await writeFile(binary, `#!/bin/sh
exec ${process.execPath} "$0.mjs"
`);
  await writeFile(binary + ".mjs", `
    import { writeFileSync } from "node:fs";
    import readline from "node:readline";
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", line => {
      const message = JSON.parse(line);
      if (message.id === 77 && message.result) {writeFileSync(${JSON.stringify(responsePath)}, JSON.stringify(message.result));notify("turn/completed", { turnId: "turn-test" });}
      if (message.id === undefined) return;
      if (message.method === "initialize") reply(message.id, { serverInfo: { name: "fake", version: "test" } });
      else if (message.method === "thread/start" || message.method === "thread/resume") reply(message.id, { thread: { id: "thread-test" } });
      else if (message.method === "turn/start") {
        reply(message.id, { turn: { id: "turn-test" } });
      setTimeout(() => { request(77, "item/commandExecution/requestApproval", { turnId: "turn-test", command: "echo test" }); notify("item/agentMessage/delta", { turnId: "turn-test", delta: "已收到" }); }, 5);
      } else reply(message.id, {});
    });
    function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
    function request(id, method, params) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n"); }
    function notify(method, params) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n"); }
  `);
  await chmod(binary, 0o755);
  const previous = process.env.HETU_CODEX_BIN;
  process.env.HETU_CODEX_BIN = binary;
  let running:AgentSession|undefined;
  try {
    const profile = await mkdtemp("/tmp/hetu-agent-session-profile-");
    const work = { workspace_id: "ws-test", kind: "novel" as const, object_id: "novel-test" };
    const events: unknown[] = [];
    const session = new AgentSession({ transport: "stdio", client: "codex", work, cwd: "/tmp", profile, emit: event => events.push(event) });
    running=session;
    assert.equal((await session.start()).thread_id, "thread-test");
    await session.send("你好");
    const deadline=Date.now()+5000;while(session.snapshot().pending_request?.id!==77&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(session.snapshot().pending_request?.id, 77);
    await session.respond(77, { decision: "cancel" });
    let response: string | undefined;
    for (let attempt = 0; attempt < 20 && !response; attempt++) {
      response = await readFile(responsePath, "utf8").catch(() => undefined);
      if (!response) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.deepEqual(JSON.parse(response ?? "{}"), { decision: "cancel" });
    assert.ok(session.snapshot().messages.some(message => message.role === "assistant" && message.text.includes("已收到")));
    await session.stop();
    const record = JSON.parse(await readFile(agentSessionPersistPath(profile, work), "utf8"));
    assert.equal(record.thread_id, "thread-test");
    assert.ok(events.some((event: any) => event.type === "delta"));
    const resumed = new AgentSession({ transport: "stdio", client: "codex", work, cwd: "/tmp", profile, emit: () => undefined });
    running=resumed;
    assert.equal((await resumed.start()).thread_id, "thread-test");
    await resumed.stop();
    await rm(profile, { recursive: true, force: true });
  } finally {
    await running?.stop();
    if (previous === undefined) delete process.env.HETU_CODEX_BIN; else process.env.HETU_CODEX_BIN = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("重连隔离旧进程迟到事件，并合并并发启动请求", async () => {
  const directory = await mkdtemp("/tmp/hetu-agent-session-generation-");
  const binary = path.join(directory, "fake-codex");
  const marker = path.join(directory, "instances");
  await writeFile(binary, `#!/bin/sh
exec ${process.execPath} ${JSON.stringify(binary + ".mjs")} ${JSON.stringify(marker)}
`);
  await writeFile(binary + ".mjs", `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import readline from "node:readline";
    const marker = process.argv[2];
    const instance = (existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0) + 1;
    writeFileSync(marker, String(instance));
    process.on("SIGTERM", () => {});
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", line => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      if (message.method === "initialize") reply(message.id, { serverInfo: { name: "generation-fake", version: "test" } });
      else if (message.method === "thread/start" || message.method === "thread/resume") reply(message.id, { thread: { id: "thread-generation" } });
      else if (message.method === "turn/start") {
        const turnId = "turn-" + instance;
        reply(message.id, { turn: { id: turnId } });
        setTimeout(() => notify("item/agentMessage/delta", { turnId, delta: "current-" + instance }), 5);
        setTimeout(() => notify("item/agentMessage/delta", { turnId, delta: "late-" + instance }), 60);
        setTimeout(() => notify("turn/completed", { turnId }), 80);
      } else if (message.method === "shutdown") {
        setTimeout(() => process.exit(0), 150);
        reply(message.id, {});
      } else reply(message.id, {});
    });
    function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
    function notify(method, params) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n"); }
  `);
  await chmod(binary, 0o755);
  const previous = process.env.HETU_CODEX_BIN;
  process.env.HETU_CODEX_BIN = binary;
  try {
    const profile = await mkdtemp("/tmp/hetu-agent-session-generation-profile-");
    const work = { workspace_id: "ws-generation", kind: "novel" as const, object_id: "novel-generation" };
    const session = new AgentSession({ transport: "stdio", client: "codex", work, cwd: "/tmp", profile, emit: () => undefined });
    const [first, second] = await Promise.all([session.start(), session.start()]);
    assert.equal(first.thread_id, "thread-generation");
    assert.equal(second.thread_id, "thread-generation");
    await session.send("第一轮");
    await new Promise(resolve => setTimeout(resolve, 15));
    await session.stop();
    await session.start();
    await session.send("第二轮");
    await new Promise(resolve => setTimeout(resolve, 105));
    const text = session.snapshot().messages.map(message => message.text).join("|");
    assert.match(text, /current-2/);
    assert.doesNotMatch(text, /late-1/);
    await session.stop();
    await rm(profile, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.HETU_CODEX_BIN; else process.env.HETU_CODEX_BIN = previous;
    await new Promise(resolve => setTimeout(resolve, 180));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude Code stream-json 会话适配器支持消息流、结果和私有恢复投影", async () => {
  const directory = await mkdtemp("/tmp/hetu-claude-session-test-");
  const binary = path.join(directory, "fake-claude");
  await writeFile(binary, `#!/bin/sh
exec ${process.execPath} ${JSON.stringify(binary + ".mjs")}
`);
  await writeFile(binary + ".mjs", `
    import readline from "node:readline";
    process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"claude-thread-test"})+"\\n");
    const rl=readline.createInterface({input:process.stdin});
    rl.on("line", line => { const message=JSON.parse(line); if(message.type!=="user") return;
      process.stdout.write(JSON.stringify({type:"stream_event",event:{delta:{text:"Claude 已收到"}}})+"\\n");
      process.stdout.write(JSON.stringify({type:"result",result:"Claude 已收到",is_error:false})+"\\n");
    });
  `);
  await chmod(binary, 0o755);
  const previous = process.env.HETU_CLAUDE_BIN; process.env.HETU_CLAUDE_BIN = binary;
  const profile = await mkdtemp("/tmp/hetu-claude-session-profile-");
  const work = { workspace_id: "ws-claude", kind: "novel" as const, object_id: "novel-claude" };
  const session = new ClaudeSession({ client: "claude-code", work, cwd: path.join(profile, "sandbox"), profile, emit: () => undefined });
  try {
    assert.equal((await session.start()).state, "ready");
    await session.send("你好");
    const deadline=Date.now()+5000;
    while(session.snapshot().thread_id!=="claude-thread-test"||session.snapshot().state!=="ready"||!session.snapshot().messages.some(message=>message.role==="assistant")){
      assert(Date.now()<deadline,"未收到夹具的会话初始化与完成结果。");
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(session.snapshot().thread_id, "claude-thread-test");
    assert.ok(session.snapshot().messages.some(message => message.role === "assistant" && message.text.includes("Claude 已收到")));
  } finally { await session.stop(); if (previous === undefined) delete process.env.HETU_CLAUDE_BIN; else process.env.HETU_CLAUDE_BIN = previous; await rm(profile, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); }
});

test("ACP v1 会话适配器支持初始化、会话恢复、增量消息和权限回传", async () => {
  const directory = await mkdtemp("/tmp/hetu-acp-session-test-");
  const binary = path.join(directory, "fake-acp");
  const responsePath = path.join(directory, "permission-response.json");
  await writeFile(binary, `#!/bin/sh
exec ${process.execPath} ${JSON.stringify(binary + ".mjs")} ${JSON.stringify(responsePath)}
`);
  await writeFile(binary + ".mjs", `
    import { writeFileSync } from "node:fs";
    import readline from "node:readline";
    const responsePath = process.argv[2];
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", line => { const message = JSON.parse(line);
      if (message.id === 44 && message.result) writeFileSync(responsePath, JSON.stringify(message.result));
      if (message.id === undefined) return;
      if (message.method === "initialize") reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } });
      else if (message.method === "session/new" || message.method === "session/load") reply(message.id, { sessionId: "acp-session-test" });
      else if (message.method === "session/prompt") {
        reply(message.id, { stopReason: "end_turn" });
        notify("session/update", { sessionId: "acp-session-test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP 已收到" } } });
        request(44, "session/request_permission", { sessionId: "acp-session-test", toolCall: { toolCallId: "tool-1", title: "测试命令", kind: "execute", status: "pending" }, options: [{ optionId: "reject-once", name: "拒绝本次操作", kind: "reject_once" }] });
      } else if (message.method === "session/close") reply(message.id, {});
      else reply(message.id, {});
    });
    function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
    function request(id, method, params) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n"); }
    function notify(method, params) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n"); }
  `);
  await chmod(binary, 0o755);
  const previous = process.env.HETU_ACP_BIN; process.env.HETU_ACP_BIN = binary;
  try {
    const profile = await mkdtemp("/tmp/hetu-acp-session-profile-");
    const work = { workspace_id: "ws-acp", kind: "novel" as const, object_id: "novel-acp" };
    const session = new AcpSession({ client: "acp", work, cwd: path.join(profile, "sandbox"), profile, emit: () => undefined });
    assert.equal((await session.start()).thread_id, "acp-session-test");
    await session.send("读取当前作品");
    for (let attempt = 0; attempt < 20 && !session.snapshot().pending_request; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(session.snapshot().pending_request?.method, "session/request_permission");
    await session.respond(44, { outcome: { outcome: "selected", optionId: "reject-once" } });
    const persisted = JSON.parse(await readFile(path.join(profile, "agent-sessions", "acp-ws-acp-novel-novel-acp.json"), "utf8"));
    assert.equal(persisted.session_id, "acp-session-test");
    assert.ok(session.snapshot().messages.some(message => message.role === "assistant" && message.text.includes("ACP 已收到")));
    await session.stop();
    await rm(profile, { recursive: true, force: true });
  } finally { if (previous === undefined) delete process.env.HETU_ACP_BIN; else process.env.HETU_ACP_BIN = previous; await rm(directory, { recursive: true, force: true }); }
});
