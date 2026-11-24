import {test, expect, _electron as electron} from "@playwright/test";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {AppServer} from "../src/main/rpc.ts";
import {documentAction} from "./navigation.ts";

test("卡片真实预览、取消、五种布局、背景、独立撤销和保存阅读保持同一原稿", async ({}, info) => {
  test.setTimeout(120000);
  const root = path.resolve("../.."), folder = await mkdtemp(path.join(tmpdir(), "hetu-card-"));
  const workspace = path.join(folder, "work"), profile = path.join(folder, "profile"); await mkdir(profile);
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, path.join(folder, "collaboration")], {encoding: "utf8"});
  expect(fixture.status, fixture.stderr).toBe(0); const refs = JSON.parse(fixture.stdout);
  const source = '前言。\r\n\r\n<div data-hetu-block="card">\r\n\r\n守塔人的信\r\n\r\n每一封信，都有自己的来处。🌿\r\n\r\n</div>\r\n\r\n后记。';
  const core = await AppServer.open(path.join(root, "target/debug/hetu-app-server"), workspace);
  try {expect((await core.request("workspace/request", {action: "hetu.documents.save", contract_revision: "1", input: {document_id: refs.document.document.document_id, base_revision_id: refs.document.revision.revision_id, content: source, source_format: "markdown", operation_key: "card-fixture"}})).status).toBe("succeeded");}
  finally {await core.close();}
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: refs.novel.workspace_id, works: [{work_ref: refs.novel, title: "默认小说"}]}]}));
  const executable = process.env.HETU_PACKAGED_APP;
  const app = await electron.launch({...executable ? {executablePath: executable} : {args: [path.join(root, "apps/desktop")]}, env: {...process.env,
    HETU_DESKTOP_PROFILE: profile, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "local-settings"), HETU_PLUGIN_STATE_DIR: profile,
    HETU_COLLABORATION_DIR: path.join(folder, "collaboration"), HETU_APP_SERVER: executable ? undefined : path.join(root, "target/debug/hetu-app-server")}});
  try {
    await app.evaluate(({dialog}) => {dialog.showMessageBoxSync = () => 0;});
    const page = await app.firstWindow(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({width: 1440, height: 875});
    await page.getByRole("button", {name: "打开作品 默认小说", exact: true}).click();
    await page.getByRole("button", {name: "小说", exact: true}).click();
    await page.evaluate(async () => {const api = (window as any).hetuDesktop, state = await api.settings("preferences"); await api.settings("update", {expected_revision: state.revision, patch: {autosave: false}});});
    await documentAction(page, "编辑");
    const editor = page.getByRole("textbox", {name: "文稿编辑", exact: true}), card = page.locator(".cm-card-preview > .manuscript-group-link"), dialog = page.getByRole("dialog", {name: "配置卡片", exact: true});
    const copied = async () => {await documentAction(page, "复制原稿"); return app.evaluate(({clipboard}) => clipboard.readText());};
    const open = async () => {await card.hover(); await page.locator(".cm-card-preview").getByRole("button", {name: "配置卡片", exact: true}).click(); await expect(dialog).toBeVisible();};
    await open(); await expect(dialog.locator(".card-configuration-preview")).toContainText("守塔人的信"); await expect(dialog.locator(".card-configuration-preview")).toContainText("每一封信");
    for (const [name, layout] of [["紧凑卡片", "compact"], ["横向卡片", "landscape"], ["方形卡片", "square"], ["通栏卡片", "wide"], ["大幅卡片", "large"]]) {
      await dialog.getByRole("button", {name, exact: true}).click(); await expect(dialog.locator(".card-configuration-preview > span")).toHaveAttribute("data-card-layout", layout);
    }
    await dialog.getByRole("button", {name: "自定义", exact: true}).click(); await dialog.getByRole("button", {name: "渐变", exact: true}).click();
    await expect(dialog.getByLabel("开始颜色", {exact: true})).toBeVisible();
    await page.keyboard.press("Escape"); await expect(dialog).toBeVisible(); await expect(dialog.getByLabel("开始颜色", {exact: true})).not.toBeVisible();
    await page.keyboard.press("Escape"); await expect(dialog).not.toBeVisible(); expect(await copied()).toBe(source);
    await open(); await dialog.getByRole("button", {name: "方形卡片", exact: true}).click();
    await dialog.getByRole("button", {name: "双页预览", exact: true}).click();
    await dialog.getByRole("button", {name: "自定义", exact: true}).click(); await dialog.getByRole("button", {name: "纯色", exact: true}).click();
    await dialog.getByRole("button", {name: "蓝色", exact: true}).click();
    await page.screenshot({path: info.outputPath("card-configuration-light.png")});
    await dialog.getByRole("button", {name: "套用样式", exact: true}).click(); await expect(dialog).not.toBeVisible();
    await expect(card).toHaveAttribute("data-card-layout", "square"); await expect(card).toHaveAttribute("data-card-preview", "pages");
    await editor.press("ControlOrMeta+z"); expect(await copied()).toBe(source);
    await editor.press("ControlOrMeta+Shift+z");
    await open(); await dialog.getByRole("button", {name: "自定义", exact: true}).click();
    await dialog.getByRole("button", {name: "图片背景", exact: true}).click();
    await expect(dialog.getByRole("button", {name: "上传图片", exact: true})).toBeVisible();
    await dialog.getByLabel("上传图片", {exact: true}).setInputFiles({name: "invalid.png", mimeType: "image/png", buffer: Buffer.from("invalid image")});
    await expect(dialog.getByRole("alert")).toContainText("请选择可读取的");
    const png = await page.evaluate(() => {const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 160; const context = canvas.getContext("2d")!; context.fillStyle = "#527d9a"; context.fillRect(0, 0, 240, 160); return canvas.toDataURL("image/png").split(",")[1];});
    await dialog.getByLabel("上传图片", {exact: true}).setInputFiles({name: "background.png", mimeType: "image/png", buffer: Buffer.from(png, "base64")});
    await expect(dialog.locator(".card-background-image")).toBeVisible();
    await dialog.getByRole("button", {name: "套用样式", exact: true}).click();
    await editor.press("ControlOrMeta+s"); const saved = await copied();
    expect(saved).toContain('data-hetu-card-layout="square"'); expect(saved).toContain('data-hetu-card-image="data:image/webp;base64,'); expect(saved).not.toContain("data-hetu-card-color");
    expect(saved).toContain("前言。\r\n\r\n"); expect(saved).toContain("每一封信，都有自己的来处。🌿\r\n\r\n</div>\r\n\r\n后记。");
    await expect.poll(() => page.evaluate(async id => (await (window as any).hetuDesktop.read("hetu.documents.get", {document_id: id})).data.content, refs.document.document.document_id)).toBe(saved);
    await open(); await page.setViewportSize({width: 600, height: 720}); await expect(dialog.getByRole("button", {name: "套用样式", exact: true})).toBeInViewport();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({path: info.outputPath("card-configuration-narrow.png")});
    await dialog.getByRole("button", {name: "关闭卡片配置", exact: true}).click();
    await page.setViewportSize({width: 1440, height: 875}); await documentAction(page, "阅读");
    const readCard = page.locator(".reader .manuscript-group-card > summary"); await expect(readCard).toHaveAttribute("data-card-layout", "square");
    await expect(readCard).toHaveAttribute("data-card-preview", "pages"); expect(await readCard.evaluate(element => getComputedStyle(element).backgroundImage)).toContain("data:image/webp;base64,");
    await readCard.click(); await expect(page.locator(".reader")).toContainText("每一封信，都有自己的来处。🌿");
    await page.getByRole("button", {name: "返回上一级", exact: true}).click();
    await page.evaluate(async () => {const api = (window as any).hetuDesktop, state = await api.settings("preferences"); await api.settings("update", {expected_revision: state.revision, patch: {appearance: "dark"}});});
    await page.screenshot({path: info.outputPath("card-reading-dark.png")});
    expect(errors).toEqual([]);
  } finally {await app.close();}
});
