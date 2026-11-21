import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AppServer } from "../src/main/rpc.ts";
import { documentAction, navigate } from "./navigation.ts";

test("两类排版、即时正文预览、纸色、缩放和重排锚点保持原稿及撤销", async ({}, info) => {
  test.setTimeout(180000);
  const root = path.resolve("../.."), directory = await mkdtemp(path.join(tmpdir(), "hetu-reading-experience-"));
  const workspace = path.join(directory, "work"), profile = path.join(directory, "profile");
  await mkdir(profile);
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, path.join(directory, "collaboration")], { encoding: "utf8" });
  expect(fixture.status, fixture.stderr).toBe(0);
  const refs = JSON.parse(fixture.stdout), documentId = refs.document.document.document_id;
  const source = Array.from({ length: 180 }, (_, i) => `第${i + 1}段：清晨的雾气沿着山谷缓缓流动。江岚把旧日记放回书袋，沿海岸寻找灯塔。每一封信，都有自己的来处。🌿`).join("\r\n");
  const core = await AppServer.open(path.join(root, "target/debug/hetu-app-server"), workspace);
  try {
    const result = await core.request("workspace/request", { action: "hetu.documents.save", contract_revision: "1", input: {
      document_id: documentId, base_revision_id: refs.document.revision.revision_id, source_format: "markdown", content: source, operation_key: "reading-fixture",
    } });
    expect(result.status, JSON.stringify(result)).toBe("succeeded");
  } finally { await core.close(); }
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({ schema_version: 1, roots: [{ path: workspace, workspace_id: refs.novel.workspace_id, works: [
    { work_ref: refs.novel, title: "默认小说" }, { work_ref: refs.drama, title: "默认剧本" },
  ] }] }));
  const executable = process.env.HETU_PACKAGED_APP;
  const app = await electron.launch({ ...(executable ? {executablePath: executable} : {args: [path.join(root, "apps/desktop")]}), env: {
    ...process.env, HETU_DESKTOP_PROFILE: profile, HETU_PLUGIN_STATE_DIR: profile,
    HETU_COLLABORATION_DIR: path.join(directory, "collaboration"), HETU_APP_SERVER: executable ? undefined : path.join(root, "target/debug/hetu-app-server"),
  } });
  try {
    await app.evaluate(({dialog}) => { dialog.showMessageBoxSync = () => 1; dialog.showMessageBox = async () => ({response: 1, checkboxChecked: false}); });
    const page = await app.firstWindow(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 940 });
    await page.getByRole("button", { name: "打开作品 默认小说", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "文稿编辑", exact: true });
    await expect(editor).toBeVisible();
    await expect(page.locator(".author-editor")).toHaveCSS("font-size", "16px");
    await expect(page.locator(".cm-scroller")).toHaveCSS("line-height", "24px");
    await expect(page.locator(".manuscript-footer > span").last()).toHaveText(`${source.match(/\p{Script=Han}/gu)!.length} 字`);
    await page.screenshot({path: info.outputPath("novel-default-16.png")});
    await page.evaluate(async () => { const state = await (window as any).hetuDesktop.settings("preferences"); await (window as any).hetuDesktop.settings("update", {expected_revision: state.revision, patch: {autosave: false}}); });
    await editor.press("ControlOrMeta+End"); await editor.type("保留撤销。");
    const primary = page.getByRole("button", {name: "保存修订", exact: true});
    await expect(primary).toBeEnabled();
    const contrasts: any[] = [];
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({colorScheme: theme});
      await expect(page.locator("html")).toHaveAttribute("data-effective-appearance", theme);
      for (const state of ["normal", "hover", "pressed"] as const) {
        if (state === "normal") await page.mouse.move(0, 0); else await primary.hover();
        if (state === "pressed") await page.mouse.down();
        const palette = await primary.evaluate(element => {
          const style = getComputedStyle(element), context = document.createElement("canvas").getContext("2d")!;
          function rgb(value: string) { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; }
          const background = rgb(style.backgroundColor), foreground = rgb(style.color);
          const luminance = (channels: number[]) => channels.slice(0, 3).map(value => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
          const [a, b] = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
          return {raw: {background: style.backgroundColor, foreground: style.color}, background, foreground, contrast: (b + .05) / (a + .05), opacity: style.opacity};
        });
        console.log("button-contrast", JSON.stringify({theme, state, ...palette}));
        if (state === "pressed") { await page.mouse.move(0, 0); await page.mouse.up(); }
        expect(palette.background[3]).toBe(255); expect(palette.foreground[3]).toBe(255); expect(palette.opacity).toBe("1");
        expect(palette.contrast).toBeGreaterThanOrEqual(4.5); contrasts.push({theme, state, ...palette});
      }
    }
    const contrastPath = info.outputPath("button-contrast.json"); await writeFile(contrastPath, JSON.stringify(contrasts, null, 2));
    await info.attach("rendered-button-contrast", {path: contrastPath, contentType: "application/json"});
    await page.emulateMedia({colorScheme: "light"}); await page.mouse.move(0, 0);
    await page.locator('summary[aria-label="阅读排版"]').click();
    const media = await page.context().newCDPSession(page);
    await media.send("Emulation.setEmulatedMedia", {features: [
      {name: "prefers-color-scheme", value: "light"},
      {name: "prefers-reduced-transparency", value: "reduce"},
    ]});
    await expect(page.locator(".reading-panel")).toHaveCSS("backdrop-filter", "none");
    await page.locator('summary[aria-label="阅读排版"]').press("Escape");
    await page.locator('summary[aria-label="文字操作"]').click();
    await expect(page.locator(".editor-command-menu")).toHaveCSS("backdrop-filter", "none");
    await page.locator('summary[aria-label="文字操作"]').press("Escape");
    await media.send("Emulation.setEmulatedMedia", {features: [
      {name: "prefers-color-scheme", value: "light"},
      {name: "prefers-contrast", value: "more"},
    ]});
    await page.locator('summary[aria-label="阅读排版"]').click();
    await expect(page.locator(".reading-panel")).toHaveCSS("backdrop-filter", "none");
    await page.locator('summary[aria-label="阅读排版"]').press("Escape");
    await media.detach();
    await page.emulateMedia({colorScheme: "light"});
    await page.locator('summary[aria-label="阅读排版"]').click();
    await page.getByRole("spinbutton", { name: "文字大小", exact: true }).fill("26");
    await page.getByRole("spinbutton", { name: "文字大小", exact: true }).press("Enter");
    await expect(page.locator(".author-editor")).toHaveCSS("font-size", "26px");
    await expect(page.locator(".cm-scroller")).toHaveCSS("line-height", "39px");
    await expect(page.getByRole("group", { name: "纸色", exact: true }).getByRole("button", {name: "暖纸", exact: true})).toBeEnabled({timeout: 15000});
    const currentPreferences = await page.evaluate(() => (window as any).hetuDesktop.settings("preferences"));
    await app.evaluate(({BrowserWindow}, state) => BrowserWindow.getAllWindows()[0]!.webContents.send("desktop:preferences", {
      ...state.preferences, settings_revision: state.revision - 1,
      reading_profiles: {...state.preferences.reading_profiles, novel: {...state.preferences.reading_profiles.novel, font_size: 14}},
    }), currentPreferences);
    await expect(page.locator(".author-editor")).toHaveCSS("font-size", "26px");
    await page.getByRole("combobox", { name: "文稿缩放", exact: true }).selectOption("150");
    await expect(page.locator(".author-editor")).toHaveCSS("font-size", "39px");
    await page.getByRole("combobox", { name: "文稿缩放", exact: true }).selectOption("100");
    await page.locator('summary[aria-label="阅读排版"]').click();
    await editor.focus(); await editor.press("ControlOrMeta+z");
    const saved = await page.evaluate(async id => (window as any).hetuDesktop.read("hetu.documents.get", { document_id: id }), documentId);
    expect(saved.data.content).toBe(source);
    await expect(page.locator(".save-state")).not.toContainText("有未保存修改");
    await page.evaluate(async () => { const state = await (window as any).hetuDesktop.settings("preferences"); await (window as any).hetuDesktop.settings("update", {expected_revision: state.revision, patch: {autosave: false, focus_paragraph: true, typewriter_scroll: true, smart_pairs: true}}); });
    await expect(page.locator(".author-editor")).toHaveAttribute("data-focus-paragraph", "true");
    await editor.press("ControlOrMeta+End");
    await editor.type("(");
    await expect(page.locator(".cm-line").last()).toContainText("()");
    await editor.press("Backspace");
    await expect(page.locator(".cm-line").last()).not.toContainText("()");
    await editor.type("测试");
    await expect.poll(() => page.evaluate(() => { const range = getSelection()!.getRangeAt(0), stage = document.querySelector(".manuscript-stage")!; return Math.abs(range.getBoundingClientRect().top - stage.getBoundingClientRect().top - stage.clientHeight * .45); })).toBeLessThanOrEqual(2);
    await editor.press("ControlOrMeta+z");
    await expect(page.locator(".save-state")).not.toContainText("有未保存修改");
    await page.evaluate(async () => { const state = await (window as any).hetuDesktop.settings("preferences"); await (window as any).hetuDesktop.settings("update", {expected_revision: state.revision, patch: {focus_paragraph: false, typewriter_scroll: false, smart_pairs: false}}); });
    await documentAction(page, "阅读");
    const reader = page.locator(".reader"), stage = page.locator(".manuscript-stage");
    await expect(reader).toBeVisible();
    await expect(reader).toHaveCSS("line-height", "39px");
    const marker = "第60段";
    const markerTop = () => reader.evaluate((element, marker) => {
      const span = [...element.querySelectorAll("[data-source-from]")].find(span => span.textContent!.includes(marker))!;
      const range = document.createRange(), offset = span.textContent!.indexOf(marker);
      range.setStart(span.firstChild!, offset); range.setEnd(span.firstChild!, offset + marker.length);
      return range.getBoundingClientRect().top - element.closest(".manuscript-stage")!.getBoundingClientRect().top;
    }, marker);
    await stage.evaluate((element, top) => { element.scrollTop += top - 16; }, await markerTop());
    await expect.poll(async () => Math.abs(await markerTop() - 16)).toBeLessThanOrEqual(1);
    await page.locator('summary[aria-label="阅读排版"]').click();
    await page.getByRole("group", { name: "行宽", exact: true }).getByRole("button", {name: "窄", exact: true}).click();
    await expect(page.getByRole("group", { name: "行宽", exact: true }).getByRole("button", {name: "窄", exact: true})).toBeEnabled();
    await expect.poll(async () => Math.abs(await markerTop() - 16)).toBeLessThanOrEqual(1);
    await page.getByRole("group", { name: "纸色", exact: true }).getByRole("button", {name: "暖纸", exact: true}).click();
    await expect(page.getByRole("group", { name: "纸色", exact: true }).getByRole("button", {name: "暖纸", exact: true})).toBeEnabled();
    const paper = await page.locator(".manuscript-paper").evaluate(el => getComputedStyle(el).backgroundColor);
    expect(paper).not.toBe("rgba(0, 0, 0, 0)");
    await page.getByRole("combobox", { name: "文稿缩放", exact: true }).selectOption("150");
    await expect(reader).toHaveCSS("font-size", "39px");
    await expect.poll(async () => Math.abs(await markerTop() - 16)).toBeLessThanOrEqual(1);
    await page.locator('summary[aria-label="阅读排版"]').click();
    await page.screenshot({ path: info.outputPath("novel-warm-150.png") });
    await page.setViewportSize({ width: 800, height: 900 });
    await expect.poll(async () => Math.abs(await markerTop() - 16)).toBeLessThanOrEqual(1);
    expect(await stage.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await navigate(page, "返回创作库");
    await page.getByRole("button", { name: "打开作品 默认剧本", exact: true }).click();
    await expect(page.locator(".screenplay-reader")).toHaveCSS("font-size", "18px");
    await page.locator('summary[aria-label="阅读排版"]').click();
    await expect(page.getByRole("spinbutton", { name: "文字大小", exact: true })).toHaveValue("18");
    await expect(page.getByRole("combobox", { name: "文稿缩放", exact: true })).toHaveValue("100");
    await page.locator('summary[aria-label="阅读排版"]').click();
    expect(errors).toEqual([]);
    await info.attach("profile-location", { body: directory, contentType: "text/plain" });
  } finally { await app.close(); }
});
