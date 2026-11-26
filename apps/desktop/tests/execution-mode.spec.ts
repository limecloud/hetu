import {test, expect, _electron as electron, type ElectronApplication} from "@playwright/test";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {mkdtemp, mkdir} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import {openSettings, closeSettings, closeApplication} from "./navigation.ts";

test("桌面切换执行模式即时同步CLI与两种MCP连接，集中确认及重开保持同一策略", async ({}, info) => {
  test.setTimeout(180000);
  const root = path.resolve("../.."), folder = await mkdtemp(path.join(tmpdir(), "hetu-execution-ui-"));
  const profile = path.join(folder, "profile"), workspace = path.join(folder, "work");
  await mkdir(profile);
  const executable = process.env.HETU_PACKAGED_APP;
  const bin = executable ? path.resolve(path.dirname(executable), "../Resources/bin") : path.join(root, "target/debug");
  const binary = (name: string) => path.join(bin, name + (process.platform === "win32" ? ".exe" : ""));
  const env: Record<string, string | undefined> = {...process.env, HETU_DESKTOP_PROFILE: profile, HETU_PLUGIN_STATE_DIR: profile,
    HETU_LOCAL_SETTINGS_DIR: path.join(profile, "local-settings"), HETU_COLLABORATION_DIR: path.join(folder, "collaboration")};
  for (const key of ["HETU_APP_SERVER", "HETU_CLI", "HETU_PLUGIN_CLI", "HETU_PLUGIN_NODE", "ELECTRON_RUN_AS_NODE"])
    delete env[key];
  const cli = (action: string, input: any, code = 0) => {
    const result = spawnSync(binary("hetu"), ["--client", "codex", "call", action, "--input", "-"],
      {env, input: JSON.stringify(input), encoding: "utf8", timeout: 30000});
    expect(result.status, result.stderr + result.stdout).toBe(code);
    return JSON.parse(result.stdout);
  };
  const command = (action: string, input: any) => ({action, contract_revision: "1", input});
  expect(cli("hetu.execution.initialize", {workspace_path: workspace,
    create: {title: "统一模式隔离验收", locale: "zh-CN", operation_key: "initialize"}}).status).toBe("succeeded");
  const clients: Client[] = [];
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  const launch = async () => {
    app = await electron.launch({...executable ? {executablePath: executable, args: []} : {args: [path.join(root, "apps/desktop")]}, env});
    const main = await app.firstWindow();
    const page = await openSettings(app, main);
    page.on("pageerror", error => errors.push(error.message));
    await page.getByRole("tab", {name: "通用", exact: true}).click();
    return page;
  };
  const call = async (client: Client, action: string, input: any = {}) =>
    (await client.callTool({name: "hetu_call_action", arguments: {action, input}})).structuredContent as any;
  try {
    for (const [index, args] of [["stable", ["--client", "codex"]], ["bound", ["--workspace", workspace]]] as const) {
      const client = new Client({name: "hetu-execution-" + index, version: "1"}, {});
      await client.connect(new StdioClientTransport({command: binary("hetu-mcp"), args: [...args], env, stderr: "pipe"}));
      clients.push(client);
    }
    // 工作区连接保留实际工具目录，稳定连接通过精简分派读取同一策略。
    const bound = async (action: string, input: any = {}) => {
      const tool = {"hetu.execution.get_mode": "hetu_get_execution_mode", "hetu.execution.invoke": "hetu_execute_workspace"}[action];
      expect(tool).toBeTruthy();
      return (await clients[1].callTool({name: tool!, arguments: input})).structuredContent as any;
    };
    let page = await launch();
    const mode = () => page.getByRole("combobox", {name: "执行模式", exact: true});
    await expect(mode()).toHaveValue("auto");
    const initial = (await call(clients[0], "hetu.execution.get_mode")).data;
    expect((await bound("hetu.execution.get_mode")).data).toEqual(initial);
    await mode().selectOption("confirm");
    await expect.poll(async () => (await call(clients[0], "hetu.execution.get_mode")).data.execution_mode).toBe("confirm");
    expect((await bound("hetu.execution.get_mode")).data.execution_mode).toBe("confirm");
    expect(cli("hetu.execution.get_mode", {}).data.execution_mode).toBe("confirm");
    const write = (title: string) => command("hetu.documents.create", {kind: "novel_chapter", title,
      source_format: "markdown", content: "固定文字🌿\r\n保留原换行", operation_key: title});
    const input = {workspace_path: workspace, command: write("集中第一章")};
    expect((await call(clients[0], "hetu.execution.invoke", input)).error.code).toBe("hetu.execution_confirmation_required");
    expect((await bound("hetu.execution.invoke", input)).error.code).toBe("hetu.execution_confirmation_required");
    const prepared = cli("hetu.execution.prepare", {workspace_path: workspace, commands: [input.command, write("集中第二章")],
      summary: "一次创建两个章节", operation_key: "batch"}).data;
    const plan_ref = {plan_id: prepared.plan_id, sha256: prepared.sha256};
    expect((await call(clients[0], "hetu.execution.execute", {plan_ref})).error.code).toBe("hetu.execution_confirmation_required");
    expect(cli("hetu.execution.record_confirmation", {plan_ref, decision: "confirm",
      user_instruction: "隔离验收：确认一次创建所展示的两个章节", operation_key: "confirm"}).status).toBe("succeeded");
    const done = (await call(clients[0], "hetu.execution.execute", {plan_ref})).data;
    expect(done.state).toBe("completed"); expect(done.results).toHaveLength(2);
    expect(cli("hetu.execution.execute", {plan_ref}).data).toEqual(done);
    const document_id = done.results[0].data.document.document_id;
    const read = await bound("hetu.execution.invoke", {workspace_path: workspace, command: command("hetu.documents.get", {document_id})});
    expect(read.data.result.data.content).toBe("固定文字🌿\r\n保留原换行");
    await page.screenshot({path: info.outputPath("confirm-settings.png"), scale: "css"});
    // 两步共用旧基线：第一步成功后第二步必然CAS冲突，恢复不能重做成功步骤。
    const original=read.data.result.data;
    const partial=cli("hetu.execution.prepare",{workspace_path:workspace,commands:[
      command("hetu.documents.rename",{document_id,base_revision_id:original.revision.revision_id,title:"只执行一次的改名",operation_key:"partial-rename"}),
      command("hetu.documents.save",{document_id,base_revision_id:original.revision.revision_id,source_format:"markdown",content:"不应覆盖的过期正文",operation_key:"partial-stale-save"}),
    ],summary:"固定改名与过期基线负例",operation_key:"partial-batch"}).data;
    const partial_ref={plan_id:partial.plan_id,sha256:partial.sha256};
    cli("hetu.execution.record_confirmation",{plan_ref:partial_ref,decision:"confirm",user_instruction:"隔离验收：确认展示的两步固定变化，保留冲突结果",operation_key:"partial-confirm"});
    const blocked=await call(clients[0],"hetu.execution.execute",{plan_ref:partial_ref});
    expect(blocked.status).toBe("blocked");expect(blocked.error.code).toBe("revision_conflict");
    await clients[0].close();
    clients[0]=new Client({name:"hetu-execution-stable-reopened",version:"1"},{});
    await clients[0].connect(new StdioClientTransport({command:binary("hetu-mcp"),args:["--client","codex"],env,stderr:"pipe"}));
    const progress=cli("hetu.execution.get_plan",{plan_ref:partial_ref}).data;
    expect(progress.state).toBe("blocked");expect(progress.results).toHaveLength(1);
    expect(await call(clients[0],"hetu.execution.execute",{plan_ref:partial_ref})).toEqual(blocked);
    const changed=await bound("hetu.execution.invoke",{workspace_path:workspace,command:command("hetu.documents.get",{document_id})});
    expect(changed.data.result.data.document.title).toBe("只执行一次的改名");
    expect(changed.data.result.data.content).toBe(original.content);
    await closeSettings(page);
    await app!.evaluate(({dialog},workspace)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[workspace]});},workspace);
    const main=await app!.firstWindow();
    await main.getByRole("button",{name:"打开作品",exact:true}).first().click();
    await main.getByRole("button",{name:/统一模式隔离验收/}).click();
    await expect(main.getByRole("heading",{name:"作品资料",exact:true})).toBeVisible();
    const desktopRecovered=await main.evaluate(request=>window.hetuDesktop.execution(request),command("hetu.execution.execute",{plan_ref:partial_ref}));
    expect(desktopRecovered).toEqual(blocked);
    const afterRecovery=await bound("hetu.execution.invoke",{workspace_path:workspace,command:command("hetu.documents.get",{document_id})});
    expect(afterRecovery.data.result.data.revision).toEqual(changed.data.result.data.revision);
    const wrong=await call(clients[0],"hetu.execution.get_plan",{plan_ref:{...partial_ref,sha256:"0".repeat(64)}});
    expect(wrong.error.code).toBe("forbidden");
    const altered=await call(clients[0],"hetu.execution.prepare",{workspace_path:workspace,commands:[write("不应追加的章节")],summary:"修改旧键输入",operation_key:"partial-batch"});
    expect(altered.status).not.toBe("succeeded");
    await info.attach("partial-execution-recovery",{body:JSON.stringify({plan_ref:partial_ref,completed_steps:progress.results.length,blocked_code:blocked.error.code,successful_revision:changed.data.result.data.revision.revision_id,desktop_same_result:true}),contentType:"application/json"});
    page=await openSettings(app!,main);await page.getByRole("tab",{name:"通用",exact:true}).click();
    await mode().selectOption("auto");
    await expect.poll(async () => (await bound("hetu.execution.get_mode")).data.execution_mode).toBe("auto");
    expect((await bound("hetu.execution.invoke", {workspace_path: workspace, command: write("自动第三章")})).data.result.status).toBe("succeeded");
    await closeApplication(app!); app = undefined;
    page = await launch();
    await expect(mode()).toHaveValue("auto");
    expect(cli("hetu.execution.get_mode", {}).data).toEqual((await call(clients[0], "hetu.execution.get_mode")).data);
    expect(errors).toEqual([]);
    await page.screenshot({path: info.outputPath("auto-settings-reopened.png"), scale: "css"});
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    if (app) await closeApplication(app);
    await info.attach("renderer-errors", {body: JSON.stringify(errors), contentType: "application/json"});
  }
});
