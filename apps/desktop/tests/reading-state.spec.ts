import {test, expect, _electron as electron} from "@playwright/test";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {AppServer} from "../src/main/rpc.ts";
import {documentAction, openDirectory, closeApplication} from "./navigation.ts";

test("关闭重开恢复同一作品章节和固定锚点，新修订从头阅读", async () => {
  const root = path.resolve("../.."), directory = await mkdtemp(path.join(tmpdir(), "hetu-reading-restart-")), workspace = path.join(directory, "work"), profile = path.join(directory, "profile");
  await mkdir(profile);
  const made = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, path.join(directory, "collaboration")], {encoding: "utf8"});
  expect(made.status, made.stderr).toBe(0); const refs = JSON.parse(made.stdout);
  const content = Array.from({length: 100}, (_, index) => `第${index + 1}段：江岚把旧日记放回书袋，沿海岸寻找灯塔。`).join("\n\n");
  const core = await AppServer.open(path.join(root, "target/debug/hetu-app-server"), workspace);
  let second: any;
  try {
    const saved = await core.request("workspace/request", {action: "hetu.documents.create", input: {kind: "novel_chapter", title: "第二章 归航", source_format: "markdown", content, operation_key: "reading-state-second"}, contract_revision: "1"});
    expect(saved.status).toBe("succeeded"); second = saved.data;
  } finally {await core.close();}
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: refs.novel.workspace_id, works: [{work_ref: refs.novel, title: "默认小说"}]}]}));
  const launch = () => electron.launch({args: [path.join(root, "apps/desktop")], env: {...process.env, HETU_DESKTOP_PROFILE: profile, HETU_PLUGIN_STATE_DIR: profile, HETU_COLLABORATION_DIR: path.join(directory, "collaboration"), HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server")}});
  let app = await launch();
  const open = async () => {const page = await app.firstWindow(); await page.setViewportSize({width: 1440, height: 940}); await page.getByRole("button", {name: "打开作品 默认小说", exact: true}).click(); return page;};
  try {
    let page = await open();
    await openDirectory(page); await page.getByRole("button", {name: "第二章 归航", exact: true}).click();
    await documentAction(page, "阅读");
    await page.locator(".manuscript-stage").evaluate(node => {node.scrollTop = 2000;});
    const read = () => page.evaluate(async work => (window as any).hetuDesktop.readingState("get", {work_ref: work}), refs.novel);
    await expect.poll(async () => Object.values((await read()).positions).some((position: any) => position.top > 1500 && position.quote?.quote)).toBe(true);
    const initial = await read(); expect(initial.selected_document_id).toBe(second.document.document_id);
    await closeApplication(app); app = await launch(); page = await open();
    await expect(page.locator(".manuscript-title h1")).toHaveText("第二章 归航");
    await documentAction(page, "阅读");
    await expect.poll(() => page.locator(".manuscript-stage").evaluate(node => node.scrollTop)).toBeGreaterThan(1500);
    await closeApplication(app, "app");
    const update = await AppServer.open(path.join(root, "target/debug/hetu-app-server"), workspace);
    try {
      const saved = await update.request("workspace/request", {action: "hetu.documents.save", input: {document_id: second.document.document_id, base_revision_id: second.revision.revision_id, source_format: "markdown", content: content + "\n新修订的结尾。", operation_key: "reading-state-new-revision"}, contract_revision: "1"});
      expect(saved.status).toBe("succeeded");
    } finally {await update.close();}
    app = await launch(); page = await open();
    await expect(page.locator(".manuscript-title h1")).toHaveText("第二章 归航");
    await documentAction(page, "阅读");
    await expect.poll(() => page.locator(".manuscript-stage").evaluate(node => node.scrollTop)).toBeLessThan(100);
  } finally {await closeApplication(app);}
});
