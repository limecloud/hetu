import { test, expect, _electron as electron } from "@playwright/test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { navigate } from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");

test("独立桌面 Agent 会话通过精确作品引用运行在私有沙箱", async () => {
  test.setTimeout(120000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-agent-session-e2e-"));
  const workspace = path.join(folder, "作品");
  const profile = path.join(folder, "profile");
  const collaboration = path.join(folder, "collaboration");
  const codex = path.join(folder, "codex-fixture");
  const log = path.join(folder, "codex.log");
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, collaboration], { encoding: "utf8" });
  expect(fixture.status, fixture.stderr).toBe(0);
  const context = JSON.parse(fixture.stdout);
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({ schema_version: 1, roots: [{ path: workspace, workspace_id: context.novel.workspace_id, works: [{ work_ref: context.novel, title: "默认小说" }] }] }));
  await writeFile(codex, `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(codex + ".mjs")} ${JSON.stringify(log)} "$@"\n`);
  await writeFile(codex + ".mjs", `
    import { appendFileSync } from "node:fs";
    import http from "node:http";
    import WebSocket from ${JSON.stringify(createRequire(import.meta.url).resolve("ws"))};
    const log = process.argv[2];
    const server=http.createServer(),wss=new WebSocket.WebSocketServer({server});let current;
    server.listen(process.argv[process.argv.indexOf("--listen")+1].slice(7));
    wss.on("connection",socket=>socket.on("message", line => {
      current=socket;const message = JSON.parse(line.toString());
      if (message.id === undefined) return;
      if (message.method === "initialize") reply(message.id, { serverInfo: { name: "desktop-e2e", version: "1" } });
      else if (message.method === "thread/start" || message.method === "thread/resume") {
        appendFileSync(log, JSON.stringify({ method: message.method, params: message.params, collaboration: process.env.HETU_COLLABORATION_DIR }) + "\\n");
        reply(message.id, { thread: { id: "thread-desktop-e2e" } });
      } else if (message.method === "turn/start") {
        appendFileSync(log, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
        reply(message.id, { turn: { id: "turn-desktop-e2e" } });
        setTimeout(() => notify("item/agentMessage/delta", { turnId: "turn-desktop-e2e", delta: "已通过桌面会话读取固定上下文。" }), 10);
        setTimeout(() => notify("turn/completed", { turnId: "turn-desktop-e2e" }), 30);
      } else if (message.method === "shutdown") { reply(message.id, {}); setTimeout(() => process.exit(0), 20); }
      else reply(message.id, {});
    }));
    function reply(id, result) { current.send(JSON.stringify({id,result})); }
    function notify(method, params) { current.send(JSON.stringify({method,params})); }
  `);
  await chmod(codex, 0o755);
  const app = await electron.launch({ args: [path.join(root, "apps/desktop")], env: {
    ...process.env,
    HETU_DESKTOP_PROFILE: profile,
    HETU_COLLABORATION_DIR: collaboration,
    HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server"),
    HETU_CLI: path.join(root, "target/debug/hetu"),
    HETU_CODEX_BIN: codex,
  } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.getByRole("button", { name: "刷新创作库", exact: true }).click();
    await expect(page.getByRole("button", { name: "打开作品 默认小说", exact: true })).toBeEnabled({ timeout: 30000 });
    await page.getByRole("button", { name: "打开作品 默认小说", exact: true }).click();
    await page.evaluate(async()=>{const api=(window as any).hetuDesktop;const state=await api.settings("preferences");await api.settings("update",{expected_revision:state.revision,patch:{agent_session:{default_surface:"gui"}}});});
    await navigate(page, "Agent 协作");
    await page.getByRole("dialog",{name:"创建会话",exact:true}).getByRole("button",{name:"引擎",exact:true}).click();await page.getByRole("button",{name:"打开聊天",exact:true}).click();
    await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole("textbox", { name: "发送给 Agent", exact: true }).fill("请读取当前章节的固定来源并返回确认。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("已通过桌面会话读取固定上下文。", { exact: true })).toBeVisible({ timeout: 30000 });
    const records = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const turn = records.find((entry: any) => entry.method === "turn/start");
    expect(turn).toBeTruthy();
    const prompt = turn.params.input[0].text as string;
    expect(prompt).toContain(context.novel.workspace_id);
    expect(prompt).not.toContain("management_ref");
    expect(prompt).not.toContain(workspace);
    const started = records.find((entry: any) => entry.method === "thread/start");
    expect(started.collaboration).toBe(collaboration);
    expect(started.params.cwd).toContain(path.join(profile, "agent-sessions", "sandbox"));
    expect(started.params.cwd).not.toBe(workspace);
    expect(started.params.cwd).not.toContain(workspace);
    for(const url of ["file:///etc/passwd","javascript:alert(1)","data:text/html,test"]){
      const failure=await page.evaluate(async url=>{try{await window.hetuDesktop.agentSession("open_link",{url});return "opened";}catch(error){return (error as Error).message;}},url);
      expect(failure).toContain("仅支持打开网页链接");
    }
    await expect(page.getByText("已连接", {exact:true})).toBeVisible();
    await navigate(page,"资料与素材");
    await app.evaluate(({ipcMain})=>{const handlers=(ipcMain as any)._invokeHandlers;(globalThis as any).__agentTimings=[];for(const channel of ["desktop:handoff","desktop:agent-session"]){const handler=handlers.get(channel);if(!handler)continue;handlers.set(channel,async(...args:any[])=>{const entry:any={channel,method:args[1],started:Date.now()};(globalThis as any).__agentTimings.push(entry);try{const value=await handler(...args);entry.elapsed=Date.now()-entry.started;return value;}catch(error){entry.elapsed=Date.now()-entry.started;entry.error=(error as Error).message;throw error;}});}});
    await page.getByRole("button",{name:"让 AI 整理资料",exact:true}).click();
    try{await expect(page.getByRole("region",{name:"独立 Agent 会话",exact:true})).toBeVisible();}catch(error){throw Error(String(error)+"\n宿主时序："+JSON.stringify(await app.evaluate(()=>(globalThis as any).__agentTimings))+"\n会话："+JSON.stringify(await page.evaluate(async()=>{const s=await window.hetuDesktop.agentSession("get");return {state:s.state,surface:s.surface,error:s.error};})));}
    await expect(page.getByRole("textbox",{name:"发送给 Agent",exact:true})).toHaveValue(/hetu.resources/);
    const draft=await page.getByRole("textbox",{name:"发送给 Agent",exact:true}).inputValue();
    expect(draft).not.toContain("management_ref");expect(draft).not.toContain(workspace);
    expect((await readFile(log,"utf8")).split("\n").filter(line=>line.includes('"method":"turn/start"'))).toHaveLength(1);
    await page.setViewportSize({width:1600,height:900});
    await expect(page.locator(".agent-workspace-full")).toBeVisible();
    await page.getByRole("button",{name:"并排查看作品",exact:true}).click();
    await expect(page.getByRole("separator",{name:"调整终端侧栏宽度",exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"让 AI 整理资料",exact:true})).toBeVisible();
    const originalThread=await page.evaluate(async()=>(await window.hetuDesktop.agentSession("get")).thread_id);
    const separator=page.getByRole("separator",{name:"调整终端侧栏宽度",exact:true});
    await separator.focus();await separator.press("ArrowLeft");
    expect(Number(await separator.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(420);
    await page.getByRole("button",{name:"关闭终端面板",exact:true}).click();
    await expect(page.getByRole("region",{name:"独立 Agent 会话",exact:true})).not.toBeVisible();
    await page.getByRole("button",{name:"打开终端会话",exact:true}).click();
    await expect(page.getByRole("textbox",{name:"发送给 Agent",exact:true})).toHaveValue(draft);
    expect(await page.evaluate(async()=>(await window.hetuDesktop.agentSession("get")).thread_id)).toBe(originalThread);
    await expect(page.locator(".agent-workspace-full")).toBeVisible();
    await page.getByRole("button",{name:"并排查看作品",exact:true}).click();
    await page.getByRole("button",{name:"展开终端工作区",exact:true}).click();
    await expect(page.getByRole("button",{name:"让 AI 整理资料",exact:true})).not.toBeVisible();
    await page.getByRole("button",{name:"并排查看作品",exact:true}).click();
    await expect(page.getByRole("button",{name:"让 AI 整理资料",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"关闭终端面板",exact:true}).click();
    await page.getByRole("complementary",{name:"项目导航",exact:true}).getByRole("button",{name:"返回创作库",exact:true}).click();
    await page.getByRole("button",{name:"打开作品 默认剧本",exact:true}).click();
    await navigate(page,"Agent 协作");await page.getByRole("button",{name:"关闭创建会话",exact:true}).click();
    const directory=page.getByRole("complementary",{name:"作品目录",exact:true});
    await expect(directory).toBeVisible();
    await directory.locator(".agent-content-entry").filter({hasText:"雾港初见"}).click();
    await expect(page.getByRole("region",{name:"作品内容预览",exact:true})).toContainText("船还没来");
    const rejected=await page.evaluate(async work=>{try{await window.hetuDesktop.agentSession("insert",{work_ref:work,text:"旧作品请求"});return "sent";}catch(error){return (error as Error).message;}},context.novel);
    expect(rejected).toContain("作品已切换");
  } finally {
    await app.close();
  }
});
