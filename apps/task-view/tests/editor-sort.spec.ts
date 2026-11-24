import {test, expect} from "@playwright/test";
import {Client} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {build} from "esbuild";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createServer} from "node:http";
import {AppServer} from "../../desktop/src/main/rpc.ts";
import {codexWorkbench} from "./codex-workbench.ts";
import {navigate} from "../../desktop/tests/navigation.ts";

for (const transport of ["stdio", "codex"] as const) test(`${transport} 块字母排序、固定源保存、浅暗窄窗及单次撤销`, async ({page}, info) => {
  test.skip(transport === "codex" && !process.env.HETU_ACCEPT_CODEX_BINARY, "需指定官方Codex CLI"); test.setTimeout(120000);
  const root = path.resolve("../.."), directory = await mkdtemp(path.join(tmpdir(), "hetu-sort-ui-"));
  const workspace = path.join(directory, "work"), profile = path.join(directory, "profile"), collaboration = path.join(directory, "collaboration");
  await mkdir(profile);
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, collaboration], {encoding: "utf8"});
  expect(fixture.status, fixture.stderr).toBe(0); const refs = JSON.parse(fixture.stdout);
  const source = "apple\r\nApple\néclair\r\nEclair\r\nÉclair\neclair\nss\r\nß\na 10\r\na 2\nZebra\r\nzebra";
  const ordered = ["a 10", "a 2", "apple", "Apple", "éclair", "Éclair", "Eclair", "eclair", "ss", "ß", "Zebra", "zebra"];
  const breaks = source.match(/\r\n?|\n/g)!;
  const expectedSource = ordered.map((line, index) => line + (breaks[index] ?? "")).join("");
  const author = await AppServer.open(path.join(root, "target/debug/hetu-app-server"), workspace);
  try {
    const saved = await author.request("workspace/request", {action: "hetu.documents.save", contract_revision: "1", input: {document_id: refs.document.document.document_id, base_revision_id: refs.document.revision.revision_id, source_format: "markdown", content: source, operation_key: "sort-source"}});
    expect(saved.status).toBe("succeeded");
  } finally {await author.close();}
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: refs.novel.workspace_id, works: [{work_ref: refs.novel, title: "排序验收"}]}]}));
  const env = {HETU_DESKTOP_PROFILE: profile, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "local-settings"), HETU_PLUGIN_STATE_DIR: profile, HETU_PLUGIN_NODE: process.execPath, HETU_COLLABORATION_DIR: collaboration};
  const binary = process.env.HETU_ACCEPT_MCP_BINARY ?? path.join(root, "target/debug/hetu-mcp");
  const direct = new Client({name: "block-sort-acceptance", version: "1"}, {capabilities: {extensions: {"io.modelcontextprotocol/ui": {mimeTypes: ["text/html;profile=mcp-app"]}}}});
  const client = transport === "codex" ? await codexWorkbench(process.env.HETU_ACCEPT_CODEX_BINARY!, binary, env) : direct;
  if (transport === "stdio") await direct.connect(new StdioClientTransport({command: binary, args: ["--client", "codex", "--collaboration-dir", collaboration], stderr: "pipe", env: {...process.env, ...env}}));
  const initial = await client.callTool({name: "hetu_open_app", arguments: {}});
  const tools = await client.listTools(), entry = tools.tools.find((tool: any) => tool.name === "hetu_open_app") as {_meta: {ui: {resourceUri: string}}};
  const uri = entry._meta.ui;
  const resource = await client.readResource({uri: uri.resourceUri}), html = (resource.contents[0] as {text: string}).text;
  const host = await build({entryPoints: ["tests/host.ts"], bundle: true, write: false, format: "esm", target: "es2022"});
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/rpc") {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const {method, params} = JSON.parse(Buffer.concat(chunks).toString());
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(method === "tools/call" ? await client.callTool(params) : await client.readResource(params)));
      } else if (request.url === "/host.js") {response.setHeader("Content-Type", "application/javascript"); response.end(host.outputFiles[0].text);}
      else {response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><meta charset="utf-8"><script type="module" src="/host.js"></script>');}
    } catch (error) {response.writeHead(500); response.end(String(error));}
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("验收宿主未启动。");
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({width: 1440, height: 797});
    await page.addInitScript(value => Object.assign(window, value), {viewHtml: html, initialTask: initial, realTask: true, workbenchMode: true, testMessages: true, testExtensions: true});
    await page.goto("http://127.0.0.1:" + address.port);
    const view = page.frameLocator("iframe");
    await view.getByRole("button", {name: "打开作品 默认小说", exact: true}).click();
    await navigate(view,"小说");
    const editor = view.getByRole("textbox", {name: "文稿编辑", exact: true}); await expect(editor).toBeVisible();
    await view.locator("#root").evaluate(async () => {const api = (window as any).hetuDesktop, state = await api.settings("preferences"); await api.settings("update", {expected_revision: state.revision, patch: {autosave: false}});});
    const sort = async (label: string) => {
      await editor.press("ControlOrMeta+a"); await editor.press("Shift+F10");
      await view.getByRole("menuitem", {name: "排序", exact: true}).hover();
      await view.getByRole("menu", {name: "排序", exact: true}).getByRole("menuitem", {name: label, exact: true}).click();
    };
    await sort("排序 A → Z"); await expect(editor.locator(".cm-line")).toHaveText(ordered);
    await page.screenshot({path: info.outputPath(`${transport}-sort-light.png`)});
    await editor.press("ControlOrMeta+s");
    const read = () => view.locator("#root").evaluate(async (_element, id) => (window as any).hetuDesktop.read("hetu.documents.get", {document_id: id}), refs.document.document.document_id);
    await expect.poll(async () => (await read()).data.content).toBe(expectedSource);
    await view.locator("#root").evaluate(async () => {const api = (window as any).hetuDesktop, state = await api.settings("preferences"); await api.settings("update", {expected_revision: state.revision, patch: {appearance: "dark"}});});
    await page.setViewportSize({width: 760, height: 700});
    await sort("排序 Z → A");
    await expect(editor.locator(".cm-line")).toHaveText([...ordered].reverse());
    await page.screenshot({path: info.outputPath(`${transport}-sort-dark-narrow.png`)});
    await editor.press("ControlOrMeta+z"); await expect(editor.locator(".cm-line")).toHaveText(ordered);
    await expect(view.getByRole("button", {name: "保存修订", exact: true})).toBeDisabled();
    expect((await read()).data.content).toBe(expectedSource);
    expect(await page.evaluate(() => window.harness.invalidToolArguments)).toBe(0); expect(errors).toEqual([]);
    await page.evaluate(() => window.harness.teardown());
  } finally {await client.close(); await new Promise<void>(resolve => server.close(() => resolve()));}
});
