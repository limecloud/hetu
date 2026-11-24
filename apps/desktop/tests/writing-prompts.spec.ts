import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { navigate, closeApplication } from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const labels = ["写作", "扩写润色", "续写", "章纲", "审稿纠错", "剧本改编"];
test("写作工具逐项预览与复制，固定原文且不直接执行Agent", async ({}, info) => {
  test.setTimeout(180000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-writing-prompts-"));
  const workspace = path.join(folder, "作品"), profile = path.join(folder, "profile"), collaboration = path.join(folder, "collaboration");
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, collaboration], {encoding: "utf8"});
  expect(fixture.status, fixture.stderr).toBe(0);
  const context = JSON.parse(fixture.stdout);
  await mkdir(profile);
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: context.novel.workspace_id, works: [{work_ref: context.novel, title: "默认小说"}, {work_ref: context.drama, title: "默认剧本"}]}]}));
  const executable = process.env.HETU_PACKAGED_APP;
  const app = await electron.launch({...(executable ? {executablePath: executable, args: []} : {args: [path.join(root, "apps/desktop")]}), env: {
    ...process.env, HETU_DESKTOP_PROFILE: profile, HETU_COLLABORATION_DIR: collaboration, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "local-settings"), HETU_CODEX_BIN: path.join(folder, "no-agent-installed"),
    ...(!executable ? {HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server"), HETU_CLI: path.join(root, "target/debug/hetu")} : {}),
  }});
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({width: 1200, height: 800});
    await app.evaluate(({clipboard, ipcMain}) => {
      clipboard.writeText("保留原剪贴板");
      const handlers = (ipcMain as any)._invokeHandlers;
      (globalThis as any).__agentCalls = 0;
      handlers.set("desktop:agent-session", async () => { (globalThis as any).__agentCalls++; throw new Error("写作工具不得启动Agent"); });
    });
    const clipboard = () => app.evaluate(({clipboard}) => clipboard.readText());
    await page.getByRole("button", {name: "刷新创作库", exact: true}).click();
    await expect(page.getByRole("button", {name: "打开作品 默认小说", exact: true})).toBeEnabled({timeout: 30000});
    await page.getByRole("button", {name: "打开作品 默认小说", exact: true}).click();
    await navigate(page, "小说");
    const editor = page.getByRole("textbox", {name: "文稿编辑", exact: true});
    await expect(editor).toContainText("灯塔在黎明前亮起", {timeout: 30000});
    const doc = context.document.document.document_id;
    const read = () => page.evaluate(id => (window as any).hetuDesktop.read("hetu.documents.get", {document_id: id}), doc);
    const before = (await read()).data;
    const menu = page.locator('summary[aria-label="外部 Agent 写作工具"]');
    for (const label of labels) {
      const previousClipboard = await clipboard();
      await menu.click();
      if (label === "写作") {
        const item = page.getByRole("menuitem", {name: /^扩写润色/});
        const title = await item.locator("strong").boundingBox(), description = await item.locator("span").boundingBox();
        expect(description!.y).toBeGreaterThanOrEqual(title!.y + title!.height - 1);
        await page.screenshot({path: info.outputPath("tools-menu.png")});
      }
      await page.getByRole("menuitem", {name: new RegExp("^" + label)}).click();
      const dialog = page.getByRole("dialog", {name: label + "提示词", exact: true});
      const field = dialog.getByRole("textbox", {name: "外部 Agent 提示词", exact: true});
      await expect(field).toHaveValue(/请协助我完成/, {timeout: 30000});
      const prompt = await field.inputValue();
      expect(prompt).toContain("请协助我完成" + label + "任务");
      expect(prompt).toContain(doc); expect(prompt).toContain(before.revision.revision_id); expect(prompt).toContain(context.novel.object_id);
      expect(prompt).not.toContain("management_ref");expect(prompt).not.toContain("workspace_path");
      expect(prompt).not.toContain("writing_goal"); expect(prompt).not.toContain("writing_tool");
      expect(await clipboard()).toBe(previousClipboard);
      if (label === "章纲") await page.screenshot({path: info.outputPath("prompt-light.png")});
      await dialog.getByRole("button", {name: "复制提示词", exact: true}).click();
      await expect(dialog.getByRole("status")).toHaveText("提示词已复制，请在外部 Agent 中粘贴。");
      expect(await clipboard()).toBe(prompt);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    }
    // 中文和Emoji选区沿真实编辑器固定到UTF-8来源。
    await editor.click(); await page.keyboard.press("Meta+End"); await page.keyboard.press("Meta+Shift+Home");
    await menu.click(); await page.getByRole("menuitem", {name: /^扩写润色/}).click();
    const selectedPrompt = page.getByRole("textbox", {name: "外部 Agent 提示词", exact: true});
    await expect(selectedPrompt).toHaveValue(/source_range/, {timeout: 30000});
    const selectionText = await selectedPrompt.inputValue();
    expect(selectionText).toContain("🌿"); expect(selectionText).toContain('"byte_start": 0');
    expect(selectionText).toContain('"byte_end": ' + Buffer.byteLength(before.content));
    await page.getByRole("button", {name: "关闭提示词", exact: true}).click();
    // 失败必须就地可见，原固定引用可重试；关闭后迟到回包不重新打开。
    await app.evaluate(({ipcMain}) => {
      const handlers = (ipcMain as any)._invokeHandlers, original = handlers.get("desktop:writing-prompt");
      handlers.set("desktop:writing-prompt", async (...args: any[]) => {handlers.set("desktop:writing-prompt", original); throw new Error("隔离验收：读取暂时中断");});
    });
    await menu.click(); await page.getByRole("menuitem", {name: /^章纲/}).click();
    await expect(page.getByRole("alert")).toContainText("读取暂时中断");
    await page.getByRole("button", {name: "重试", exact: true}).click();
    await expect(selectedPrompt).toHaveValue(/请协助我完成章纲任务/, {timeout: 30000});
    await page.emulateMedia({colorScheme: "dark"});
    await page.screenshot({path: info.outputPath("prompt-dark.png")});
    await page.setViewportSize({width: 720, height: 560});
    const rect = await page.getByRole("dialog", {name: "章纲提示词", exact: true}).boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(720);
    await page.screenshot({path: info.outputPath("prompt-narrow.png")});
    await page.keyboard.press("Escape"); await page.setViewportSize({width: 1200, height: 800});
    await app.evaluate(({ipcMain}) => {
      const handlers = (ipcMain as any)._invokeHandlers, original = handlers.get("desktop:writing-prompt");
      handlers.set("desktop:writing-prompt", async (...args: any[]) => {
        handlers.set("desktop:writing-prompt", original);
        await new Promise<void>(resolve => {(globalThis as any).__releasePrompt = resolve;});
        return original(...args);
      });
    });
    await menu.click(); await page.getByRole("menuitem", {name: /^章纲/}).click();
    await expect(page.getByRole("status")).toHaveText("正在准备固定上下文…");
    await expect.poll(() => app.evaluate(() => !!(globalThis as any).__releasePrompt)).toBe(true);
    await page.keyboard.press("Escape");
    await app.evaluate(() => (globalThis as any).__releasePrompt());
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // 错误作品、额外字段和伪造选区不能生成可执行交接。
    const invalid = await page.evaluate(async ({work, object}) => {
      const bridge = (window as any).hetuDesktop;
      const inputs = [
        {work_ref: {...work, object_id: "other"}, tool_id: "write", object_ref: object},
        {work_ref: work, tool_id: "write", object_ref: {...object, writing_goal: "不能进入Core"}},
        {work_ref: work, tool_id: "write", object_ref: {...object, byte_start: 0, byte_end: 3, quote: "错"}},
        {work_ref: work, tool_id: "write", object_ref: {...object, byte_start: 1, byte_end: 3, quote: "灯"}},
      ];
      return Promise.all(inputs.map(async input => {try {await bridge.writingPrompt(input); return "unexpected success";} catch (error) {return (error as Error).message;}}));
    }, {work: context.novel, object: {document_id: doc, revision_id: before.revision.revision_id}});
    for (const result of invalid) expect(result).not.toBe("unexpected success");
    expect((await read()).data).toEqual(before);
    // 未保存正文不能被冒充为已固定的来源。
    await editor.click(); await page.keyboard.press("ArrowRight"); await page.keyboard.type("未保存测试");
    await menu.click(); await expect(page.getByText("请先保存正文，再生成提示词", {exact: true})).toBeVisible();
    await expect(page.getByRole("menuitem", {name: /^章纲/})).toBeDisabled();
    await page.keyboard.press("Escape"); await editor.click(); await page.keyboard.press("Meta+z");
    expect(await app.evaluate(() => (globalThis as any).__agentCalls)).toBe(0);
    expect(errors).toEqual([]);
  } finally {await closeApplication(app);}
});
