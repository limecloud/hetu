import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { navigate } from "../../desktop/tests/navigation.ts";

test.use({actionTimeout: 15000});

for (const mode of ["extensions", "standard", "none"] as const) test(`MCP写作工具 ${mode} 按宿主能力预览、复制与交给当前Agent`, async ({page}, info) => {
  test.setTimeout(180000);
  const root = path.resolve("../.."), folder = await mkdtemp(path.join(tmpdir(), "hetu-mcp-writing-prompts-"));
  const workspace = path.join(folder, "work"), profile = path.join(folder, "profile"), collaboration = path.join(folder, "collaboration");
  await mkdir(profile);
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, collaboration], {encoding: "utf8"});
  expect(fixture.status, fixture.stderr).toBe(0);
  const context = JSON.parse(fixture.stdout);
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: context.novel.workspace_id, works: [{work_ref: context.novel, title: "默认小说"}, {work_ref: context.drama, title: "默认剧本"}]}]}));
  const client = new Client({name: "writing-prompts-acceptance", version: "1"}, {capabilities: {extensions: {"io.modelcontextprotocol/ui": {mimeTypes: ["text/html;profile=mcp-app"]}}}});
  await client.connect(new StdioClientTransport({command: process.env.HETU_ACCEPT_MCP_BINARY ?? path.join(root, "target/debug/hetu-mcp"), args: ["--client", "codex", "--collaboration-dir", collaboration], stderr: "pipe", env: {...process.env, HETU_DESKTOP_PROFILE: profile, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "local-settings"), HETU_PLUGIN_STATE_DIR: profile, HETU_PLUGIN_NODE: process.execPath, HETU_COLLABORATION_DIR: collaboration}}));
  const initial = await client.callTool({name: "hetu_open_app", arguments: {}});
  const tools = await client.listTools();
  const uri = (tools.tools.find(tool => tool.name === "hetu_open_app") as any)._meta.ui.resourceUri;
  const resource = await client.readResource({uri}), html = (resource.contents[0] as {text: string}).text;
  const host = await build({entryPoints: ["tests/host.ts"], bundle: true, write: false, format: "esm", target: "es2022"});
  const copies: string[] = [], generated: any[] = [];
  let nativeCopyCount = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/rpc") {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const {method, params} = JSON.parse(Buffer.concat(chunks).toString());
        // macOS首次复制走真实原生通道；其余复制隔离系统副作用并核对完整参数。
        const copying = params.arguments?.method === "copy";
        if (copying) copies.push(params.arguments.args[0]);
        const nativeCopy = copying && nativeCopyCount === 0 && process.platform === "darwin";
        if (nativeCopy) nativeCopyCount++;
        const result = copying && !nativeCopy ? {content: [], structuredContent: {value: null, events: []}} : method === "tools/call" ? await client.callTool(params) : await client.readResource(params);
        if (params.arguments?.method === "writingPrompt") generated.push(result);
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
      } else if (request.url === "/host.js") {response.setHeader("Content-Type", "application/javascript"); response.end(host.outputFiles[0].text);}
      else {response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><meta charset="utf-8"><script type="module" src="/host.js"></script>');}
    } catch (error) {response.writeHead(500); response.end(String(error));}
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as {port: number};
  try {
    await page.addInitScript(value => Object.assign(window, value), {viewHtml: html, initialTask: initial, realTask: true, workbenchMode: true, testMessages: mode !== "none", testExtensions: mode === "extensions"});
    await page.goto("http://127.0.0.1:" + address.port);
    const view = page.frameLocator("iframe");
    for (const [kind, title, pageName] of [["novel", "默认小说", "小说"], ["drama", "默认剧本", "剧本"]] as const) {
      if (kind === "drama") await navigate(view, "返回创作库");
      const card = view.getByRole("button", {name: "打开作品 " + title, exact: true});
      await expect(card).toBeEnabled({timeout: 60000}); await card.click();
      // 独立桌面偏好另一引擎时，App交接仍绑定当前MCP宿主的真实身份。
      if (mode === "extensions" && kind === "novel") await view.locator("#root").evaluate(() => window.hetuDesktop.library("client", {client: "claude-code"}));
      await navigate(view, pageName);
      if (kind === "novel") await expect(view.getByRole("textbox", {name: "文稿编辑", exact: true})).toBeVisible({timeout: 30000});
      else await expect(view.getByRole("article", {name: "分集剧本", exact: true})).toContainText("船还没来", {timeout: 30000});
      const tools = ["写作", "扩写润色", "续写", "章纲", "审稿纠错", ...(kind === "novel" ? ["剧本改编"] : [])];
      for (const label of tools) {
        await view.locator('summary[aria-label="外部 Agent 写作工具"]').click();
        if (kind === "drama") await expect(view.getByRole("menuitem", {name: /^剧本改编/})).toHaveCount(0);
        await view.getByRole("menuitem", {name: new RegExp("^" + label)}).click();
        await expect(view.getByRole("button", {name: "发送给当前 Agent", exact: true})).toHaveCount(mode === "none" ? 0 : 1);
        await expect(view.getByRole("button", {name: "放入对话草稿", exact: true})).toHaveCount(mode === "extensions" ? 1 : 0);
        const field = view.getByRole("textbox", {name: "外部 Agent 提示词", exact: true});
        await expect(field).toHaveValue(new RegExp("请协助我完成" + label + "任务"), {timeout: 30000});
        const prompt = await field.inputValue();
        expect(prompt).toContain(context[kind].object_id);
        const fixed = JSON.parse(prompt.slice(prompt.indexOf("\n{") + 1));
        expect(fixed.client_adapter).toBe("codex");
        const copyCount = copies.length;
        expect((generated.at(-1) as any).structuredContent.copied).toBeNull();
        expect(await page.evaluate(() => window.harness.messages)).toEqual([]);
        expect(await page.evaluate(() => window.harness.wireMessages)).toEqual([]);
        if (label === "章纲") await page.screenshot({path: info.outputPath("mcp-" + kind + "-prompt.png")});
        expect(copies).toHaveLength(copyCount);
        await view.getByRole("button", {name: "复制提示词", exact: true}).click();
        await expect(view.getByRole("status")).toHaveText("提示词已复制，请在外部 Agent 中粘贴。");
        expect(copies.at(-1)).toBe(prompt);
        if (copies.length === 1 && process.platform === "darwin") expect(spawnSync("/usr/bin/pbpaste", [], {encoding: "utf8"}).stdout).toBe(prompt);
        expect(await page.evaluate(() => window.harness.messages)).toEqual([]);
        await view.getByRole("button", {name: "关闭提示词", exact: true}).click();
      }
    }
    expect(generated).toHaveLength(11); expect(copies).toHaveLength(11);
    if (mode !== "none") {
      const open = async () => {
        await view.locator('summary[aria-label="外部 Agent 写作工具"]').click();
        await view.getByRole("menuitem", {name: /^章纲/}).click();
        const field = view.getByRole("textbox", {name: "外部 Agent 提示词", exact: true});
        await expect(field).toHaveValue(/请协助我完成章纲任务/, {timeout: 30000});
        return field.inputValue();
      };
      const prompt = await open();
      await view.getByRole("button", {name: "发送给当前 Agent", exact: true}).click();
      await expect(view.getByRole("status")).toHaveText("宿主已接收请求，等待 Agent 处理。");
      await expect(view.getByRole("button", {name: "发送给当前 Agent", exact: true})).toBeDisabled();
      let messages = await page.evaluate(() => window.harness.messages) as any[];
      expect(messages).toHaveLength(1); expect(messages[0].role).toBe("user"); expect(messages[0].content[0].text).toBe(prompt);
      expect(messages[0]._meta).toBeUndefined();
      await page.screenshot({path: info.outputPath("request-accepted.png")});
      await view.getByRole("button", {name: "关闭提示词", exact: true}).click();
      if (mode === "extensions") {
        const draft = await open();
        await view.getByRole("button", {name: "放入对话草稿", exact: true}).click();
        await expect(view.getByRole("status")).toHaveText("已放入当前对话草稿，请在对话中发送。");
        messages = await page.evaluate(() => window.harness.messages) as any[];
        expect(messages.at(-1).content[0].text).toBe(draft);
        const wire = await page.evaluate(() => window.harness.wireMessages) as any[];
        expect(wire.at(-1)._meta["openai/message"]).toEqual({target: "active", send: false});
        await expect(view.getByRole("button", {name: "发送给当前 Agent", exact: true})).toBeDisabled();
        await page.setViewportSize({width: 560, height: 620});
        const box = await view.getByRole("button", {name: "发送给当前 Agent", exact: true}).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(560);
        await page.screenshot({path: info.outputPath("request-narrow.png")});
        await page.setViewportSize({width: 1280, height: 720});
        await view.getByRole("button", {name: "关闭提示词", exact: true}).click();
      }
      for (const status of ["rejected", "lost"] as const) {
        await page.evaluate(status => {window.harness.messageMode = status;}, status);
        await open();
        const previous = await page.evaluate(() => window.harness.messages.length);
        await view.getByRole("button", {name: "发送给当前 Agent", exact: true}).click();
        await expect(view.getByRole("status")).toHaveText(status === "rejected" ? "宿主未接收请求，可复制提示词后继续。" : "发送结果尚未确认，请先查看当前对话，避免重复执行。");
        expect(await page.evaluate(() => window.harness.messages.length)).toBe(previous + 1);
        await expect(view.getByRole("button", {name: "发送给当前 Agent", exact: true})).toBeDisabled();
        await expect(view.getByRole("button", {name: "复制提示词", exact: true})).toBeEnabled();
        await view.getByRole("button", {name: "关闭提示词", exact: true}).click();
      }
    }
    expect(await page.evaluate(() => window.harness.invalidToolArguments)).toBe(0);
  } finally {await client.close(); await new Promise<void>(resolve => server.close(() => resolve()));}
});
