import {test, expect, _electron as electron} from "@playwright/test";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {AppServer} from "../src/main/rpc.ts";
import {documentAction, navigate} from "./navigation.ts";

test("片段混合格式、段落对齐与嵌套分组在阅读编辑搜索和整篇保存间保持", async ({}, info) => {
  test.setTimeout(150000);
  const root = path.resolve("../.."), directory = await mkdtemp(path.join(tmpdir(), "hetu-presentation-"));
  const workspace = path.join(directory, "work"), profile = path.join(directory, "profile"); await mkdir(profile);
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, path.join(directory, "collaboration")], {encoding: "utf8"});
  expect(fixture.status, fixture.stderr).toBe(0); const refs = JSON.parse(fixture.stdout);
  const source = '前言。\r\n\r\n<div data-hetu-block="page">\r\n\r\n第一组\r\n\r\n甲<span data-hetu-color="red">红</span>乙。\r\n\r\n<div data-hetu-block="card">\n\n第二组\n\n卡片内文。\n\n</div>\r\n\r\n尾段。\r\n\r\n</div>\r\n\r\n后记。';
  const core = await AppServer.open(path.join(root, "target/debug/hetu-app-server"), workspace);
  try {
    const result = await core.request("workspace/request", {action: "hetu.documents.save", input: {document_id: refs.document.document.document_id,
      base_revision_id: refs.document.revision.revision_id, content: source, source_format: "markdown", operation_key: "presentation-fixture"}, contract_revision: "1"});
    expect(result.status).toBe("succeeded");
  } finally {await core.close();}
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: refs.novel.workspace_id, works: [{work_ref: refs.novel, title: "默认小说"}]}]}));
  const executable = process.env.HETU_PACKAGED_APP;
  const app = await electron.launch({...executable ? {executablePath: executable} : {args: [path.join(root, "apps/desktop")]}, env: {...process.env,
    HETU_DESKTOP_PROFILE: profile, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "local-settings"), HETU_PLUGIN_STATE_DIR: profile, HETU_COLLABORATION_DIR: path.join(directory, "collaboration"),
    HETU_APP_SERVER: executable ? undefined : path.join(root, "target/debug/hetu-app-server")}});
  try {
    await app.evaluate(({dialog}) => {dialog.showMessageBoxSync = () => 1;});
    const page = await app.firstWindow(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({width: 1440, height: 875});
    await page.getByRole("button", {name: "打开作品 默认小说", exact: true}).click();
    await navigate(page, "小说");
    await page.evaluate(async () => {const api = (window as any).hetuDesktop, state = await api.settings("preferences"); await api.settings("update", {expected_revision: state.revision, patch: {autosave: false}});});
    await documentAction(page, "编辑");
    const editor = page.getByRole("textbox", {name: "文稿编辑", exact: true}), preview = page.locator(".manuscript-group-link");
    const read = () => page.evaluate(async id => (window as any).hetuDesktop.read("hetu.documents.get", {document_id: id}), refs.document.document.document_id);
    const copied = async () => {await documentAction(page, "复制原稿"); return app.evaluate(({clipboard}) => clipboard.readText());};
    await expect(preview).toHaveCount(1); await expect(preview).toContainText("第一组");
    expect(await preview.evaluate(element => {
      const icon = element.querySelector(".manuscript-group-icon")!, bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
      return Math.abs(icon.getBoundingClientRect().left - bounds.left - parseFloat(style.paddingLeft) - parseFloat(style.borderLeftWidth));
    })).toBeLessThan(1);
    expect(await copied()).toBe(source);
    await preview.click(); await expect(editor).toContainText("甲红乙。"); await expect(editor).not.toContainText("前言");
    await expect(preview).toHaveCount(1); await expect(preview).toContainText("第二组");
    await preview.click(); await expect(editor).toContainText("卡片内文"); await expect(editor).not.toContainText("尾段");
    await expect(page.locator(".manuscript-group-back")).toBeVisible();
    const inner = editor.locator(".cm-line").filter({hasText: "卡片内文。"}); await inner.click(); await editor.press("End"); await page.keyboard.insertText("修改");
    await expect(page.locator(".manuscript-group-back")).toBeVisible();
    await editor.press("ControlOrMeta+z"); await expect(page.locator(".manuscript-group-back")).toBeVisible();
    expect(await copied()).toBe(source); await expect(page.locator(".manuscript-group-back")).toBeVisible();
    await page.locator(".manuscript-group-back").click(); await expect(editor).toContainText("尾段");
    await expect(editor.locator(".cm-line").filter({hasText: "第一组"})).toHaveCSS("font-size", "20px");
    expect(await preview.evaluate(element => {
      const title = element.querySelector("strong")!, bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
      return Math.abs(title.getBoundingClientRect().left - bounds.left - parseFloat(style.paddingLeft) - parseFloat(style.borderLeftWidth));
    })).toBeLessThan(1);
    const paragraph = editor.locator(".cm-line").filter({hasText: "甲红乙。"}); await paragraph.click({position: {x: 10, y: 10}});
    await editor.press("Home"); await editor.press("Shift+End");
    await page.screenshot({path: info.outputPath("paragraph-selection.png")});
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("甲红乙。");
    const trigger = page.locator('summary[aria-label="文字操作"]'), panel = page.locator(".editor-command-menu"); await trigger.click();
    for (const swatch of await panel.locator(".editor-color-swatch").all()) await expect(swatch).toHaveAttribute("aria-pressed", "false");
    await panel.getByRole("button", {name: "蓝色", exact: true}).click(); await panel.getByRole("button", {name: "衬线字体", exact: true}).click();
    await expect(paragraph).toHaveText("甲红乙。");
    await panel.getByRole("button", {name: "居中", exact: true}).click(); await expect(paragraph).toHaveCSS("text-align", "center");
    await panel.getByRole("button", {name: "默认颜色", exact: true}).click(); await panel.getByRole("button", {name: "恢复默认字体", exact: true}).click();
    expect(await copied()).not.toContain("data-hetu-color"); expect(await copied()).not.toContain("data-hetu-font");
    await editor.press("Escape"); await editor.press("ControlOrMeta+s"); const saved = await copied();
    await expect.poll(async () => (await read()).data.content).toBe(saved); expect(saved).toContain("前言。\r\n\r\n"); expect(saved).toContain("后记。"); expect(saved).toContain("卡片内文。\n\n</div>");
    await page.locator(".manuscript-group-back").click();
    const ending = editor.locator(".cm-line").filter({hasText: "后记。"}); await ending.click({position: {x: 10, y: 10}}); await editor.press("Home"); await editor.press("Shift+End");
    await trigger.click(); await panel.getByRole("button", {name: "页面", exact: true}).click();
    await expect(preview).toHaveCount(2);
    await panel.getByRole("button", {name: "取消分组", exact: true}).click();
    expect(await copied()).toBe(saved); await editor.press("Escape");
    await documentAction(page, "阅读");
    const group = page.locator(".reader details.manuscript-group").first(); if (!await group.evaluate(element => (element as HTMLDetailsElement).open)) await group.locator(":scope > summary").click();
    await expect(page.locator(".reader").getByText("前言。", {exact: true})).not.toBeVisible();
    await expect(page.locator(".reader").getByText("甲红乙。", {exact: true})).toHaveCSS("text-align", "center");
    await page.screenshot({path: info.outputPath("group-page-light.png")});
    await group.getByRole("button", {name: "返回上一级", exact: true}).first().click();
    await expect(page.locator(".reader").getByText("后记。", {exact: true})).toBeVisible();
    await page.keyboard.press("ControlOrMeta+f"); await page.getByRole("textbox", {name: "搜索正文内容", exact: true}).fill("卡片内文");
    await expect(page.locator(".reader [data-source-from]").filter({hasText: /^卡片内文。$/})).toBeVisible();
    await expect(page.locator(".reader details.manuscript-group[open]")).toHaveCount(2);
    await page.getByRole("button", {name: "关闭正文搜索", exact: true}).click();
    await page.evaluate(async () => {const api = (window as any).hetuDesktop, settings = await api.settings("preferences"); await api.settings("update", {expected_revision: settings.revision, patch: {appearance: "dark"}});});
    await page.screenshot({path: info.outputPath("group-nested-dark.png")});
    expect((await read()).data.content).toBe(saved); expect(errors).toEqual([]);
  } finally {await app.close();}
});
