import {test, expect, _electron as electron} from "@playwright/test";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir, cpus, totalmem} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {AppServer} from "../src/main/rpc.ts";
import {documentAction} from "./navigation.ts";
import {manuscriptFormat, manuscriptVisibleText} from "../../../packages/workbench-ui/src/manuscript-format.ts";

test("十万汉字章真实输入到绘制p95及保存字节回读", async ({}, info) => {
  test.setTimeout(120000);
  const root = path.resolve("../.."), directory = await mkdtemp(path.join(tmpdir(), "hetu-editor-performance-")), workspace = path.join(directory, "work"), profile = path.join(directory, "profile");
  await mkdir(profile);
  const made = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, path.join(directory, "collaboration")], {encoding: "utf8"});
  expect(made.status, made.stderr).toBe(0); const refs = JSON.parse(made.stdout), id = refs.document.document.document_id;
  const paragraph = "江岚把旧日记放回书袋沿着海岸寻找灯塔每一封信都有自己的来处".repeat(4).slice(0, 100), source = Array.from({length: 1000}, () => paragraph).join("\n\n");
  expect((source.match(/\p{Script=Han}/gu) ?? []).length).toBe(100000);
  const core = await AppServer.open(path.join(root, "target/debug/hetu-app-server"), workspace);
  try {
    const saved = await core.request("workspace/request", {action: "hetu.documents.save", input: {document_id: id, base_revision_id: refs.document.revision.revision_id, source_format: "markdown", content: source, operation_key: "performance-source"}, contract_revision: "1"});
    expect(saved.status).toBe("succeeded");
  } finally {await core.close();}
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: refs.novel.workspace_id, works: [{work_ref: refs.novel, title: "默认小说"}]}]}));
  const executable = process.env.HETU_PACKAGED_APP;
  const app = await electron.launch({...executable ? {executablePath: executable} : {args: [path.join(root, "apps/desktop")]}, env: {...process.env, HETU_DESKTOP_PROFILE: profile, HETU_PLUGIN_STATE_DIR: profile, HETU_COLLABORATION_DIR: path.join(directory, "collaboration"), HETU_APP_SERVER: executable ? undefined : path.join(root, "target/debug/hetu-app-server")}});
  try {
    const page = await app.firstWindow(); await page.setViewportSize({width: 1440, height: 940});
    const start = performance.now(); await page.getByRole("button", {name: "打开作品 默认小说", exact: true}).click();
    await page.getByRole("button", {name: "小说", exact: true}).click();
    const editor = page.getByRole("textbox", {name: "文稿编辑", exact: true}); await expect(editor).toBeVisible(); const openedMs = performance.now() - start;
    await page.evaluate(async () => {const api = (window as any).hetuDesktop, state = await api.settings("preferences"); await api.settings("update", {expected_revision: state.revision, patch: {autosave: false}});});
    await documentAction(page, "编辑");
    await editor.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await editor.evaluate(node => {
      (window as any).hetuPaintSamples = [];
      node.addEventListener("beforeinput", () => {const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => (window as any).hetuPaintSamples.push(performance.now() - start)));});
    });
    for (let i = 0; i < 35; i++) {
      await page.keyboard.insertText("续");
      await expect.poll(() => page.evaluate(() => (window as any).hetuPaintSamples.length)).toBe(i + 1);
    }
    const all: number[] = await page.evaluate(() => (window as any).hetuPaintSamples), measured = all.slice(5).sort((a, b) => a - b), p95 = measured[Math.ceil(measured.length * .95) - 1];
    await editor.press("ControlOrMeta+b"); await page.evaluate(() => {(window as any).hetuPaintSamples = [];});
    for (let i = 0; i < 35; i++) {
      await page.keyboard.insertText("续");
      await expect.poll(() => page.evaluate(() => (window as any).hetuPaintSamples.length)).toBe(i + 1);
    }
    const formatted: number[] = await page.evaluate(() => (window as any).hetuPaintSamples), formattedMeasured = formatted.slice(5).sort((a, b) => a - b), formattedP95 = formattedMeasured[Math.ceil(formattedMeasured.length * .95) - 1];
    await page.locator('summary[aria-label="文字操作"]').click();
    const panel = page.locator(".editor-command-menu"); await panel.getByRole("button", {name: "红色", exact: true}).click(); await panel.getByRole("button", {name: "等宽字体", exact: true}).click();
    await editor.press("Escape"); await editor.focus(); await page.evaluate(() => {(window as any).hetuPaintSamples = [];});
    for (let i = 0; i < 35; i++) {await page.keyboard.insertText("续"); await expect.poll(() => page.evaluate(() => (window as any).hetuPaintSamples.length)).toBe(i + 1);}
    const styled: number[] = await page.evaluate(() => (window as any).hetuPaintSamples), styledMeasured = styled.slice(5).sort((a, b) => a - b), styledP95 = styledMeasured[Math.ceil(styledMeasured.length * .95) - 1];
    const result = {platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logical_cpus: cpus().length, memory_bytes: totalmem(), viewport: {width: 1440, height: 940}, han_characters: 100000, source_utf8_bytes: Buffer.byteLength(source), paragraphs: 1000, opened_ms: openedMs, samples_ms: all, warmup_samples: 5, p95_ms: p95, formatted_samples_ms: formatted, formatted_p95_ms: formattedP95, styled_samples_ms: styled, styled_p95_ms: styledP95, rendered_lines: await page.locator(".cm-line").count(), method: "beforeinput到第二次requestAnimationFrame；真实Chromium文本输入，非真实输入法组合或屏幕光子测量"};
    await info.attach("editor-input-performance", {contentType: "application/json", body: JSON.stringify(result, null, 2)});
    await writeFile(info.outputPath("editor-input-performance.json"), JSON.stringify(result, null, 2));
    expect(p95).toBeLessThanOrEqual(100);
    expect(formattedP95).toBeLessThanOrEqual(100);
    expect(styledP95).toBeLessThanOrEqual(100);
    await documentAction(page, "复制原稿"); const draft = await app.evaluate(({clipboard}) => clipboard.readText());
    expect(draft.startsWith(source + "续".repeat(35))).toBe(true);
    expect(manuscriptVisibleText(draft)).toBe(source + "续".repeat(105));
    const colored = manuscriptFormat(draft).lines.flatMap(line => line.runs).filter(run => run.attributes?.color === "red" && run.attributes.font === "mono");
    expect(colored.map(run => draft.slice(run.from, run.to)).join("")).toBe("续".repeat(35));
    await page.getByRole("button", {name: "保存修订", exact: true}).click();
    await expect(page.locator(".notice")).toContainText("已保存新修订");
    const actual = await page.evaluate(async id => (await (window as any).hetuDesktop.read("hetu.documents.get", {document_id: id})).data.content, id);
    expect(actual).toBe(draft);
  } finally {await app.close();}
});
