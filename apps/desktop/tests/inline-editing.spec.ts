import {test, expect, _electron as electron} from "@playwright/test";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {AppServer} from "../src/main/rpc.ts";
import {documentAction} from "./navigation.ts";

test("光标格式、组合文字、删除清理与列表键盘在实际编辑和保存后保持一致", async ({}, info) => {
  test.setTimeout(120000);
  const root = path.resolve("../.."), directory = await mkdtemp(path.join(tmpdir(), "hetu-inline-editing-"));
  const workspace = path.join(directory, "work"), profile = path.join(directory, "profile"); await mkdir(profile);
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, path.join(directory, "collaboration")], {encoding: "utf8"});
  expect(fixture.status, fixture.stderr).toBe(0); const refs = JSON.parse(fixture.stdout);
  const source = "段首。\r\n\r\n";
  const core = await AppServer.open(path.join(root, "target/debug/hetu-app-server"), workspace);
  try {
    const result = await core.request("workspace/request", {action: "hetu.documents.save", input: {document_id: refs.document.document.document_id,
      base_revision_id: refs.document.revision.revision_id, content: source, source_format: "markdown", operation_key: "inline-fixture"}, contract_revision: "1"});
    expect(result.status).toBe("succeeded");
  } finally {await core.close();}
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: refs.novel.workspace_id, works: [{work_ref: refs.novel, title: "默认小说"}]}]}));
  const executable = process.env.HETU_PACKAGED_APP;
  const app = await electron.launch({...executable ? {executablePath: executable} : {args: [path.join(root, "apps/desktop")]}, env: {...process.env,
    HETU_DESKTOP_PROFILE: profile, HETU_PLUGIN_STATE_DIR: profile, HETU_COLLABORATION_DIR: path.join(directory, "collaboration"),
    HETU_APP_SERVER: executable ? undefined : path.join(root, "target/debug/hetu-app-server")}});
  try {
    await app.evaluate(({dialog}) => {dialog.showMessageBoxSync = () => 1;});
    const page = await app.firstWindow(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({width: 1440, height: 940});
    await page.getByRole("button", {name: "打开作品 默认小说", exact: true}).click();
    await page.getByRole("button", {name: "小说", exact: true}).click();
    await page.evaluate(async () => {
      const api = (window as any).hetuDesktop, state = await api.settings("preferences");
      await api.settings("update", {expected_revision: state.revision, patch: {autosave: false}});
    });
    await documentAction(page, "编辑");
    const editor = page.getByRole("textbox", {name: "文稿编辑", exact: true});
    const read = () => page.evaluate(async id => (window as any).hetuDesktop.read("hetu.documents.get", {document_id: id}), refs.document.document.document_id);
    const copiedSource = async () => {
      await documentAction(page, "复制原稿"); const value = await app.evaluate(({clipboard}) => clipboard.readText());
      await editor.focus(); return value;
    };
    await editor.press("ControlOrMeta+End");
    await editor.press("ControlOrMeta+b");
    expect(await copiedSource()).toBe(source);
    await expect(page.locator(".save-state")).not.toContainText("有未保存修改");
    await page.keyboard.insertText("粗体");
    expect(await copiedSource()).toBe(source + "**粗体**");
    await editor.press("ControlOrMeta+i"); await page.keyboard.insertText("粗斜");
    await editor.press("ControlOrMeta+b"); await page.keyboard.insertText("斜体");
    await editor.press("ControlOrMeta+i"); await page.keyboard.insertText("普通");
    expect(await editor.locator(".cm-line").last().textContent()).toBe("粗体粗斜斜体普通");
    const styles = await editor.locator(".cm-line").last().evaluate(line => {
      const result: Record<string, {weight: string; italic: string}> = {};
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode, style = getComputedStyle(node.parentElement!);
        result[node.textContent!] = {weight: style.fontWeight, italic: style.fontStyle};
      }
      return result;
    });
    expect(styles["粗体"]).toEqual({weight: "700", italic: "normal"});
    expect(styles["粗斜"]).toEqual({weight: "700", italic: "italic"});
    expect(styles["斜体"]).toEqual({weight: "400", italic: "italic"});
    expect(styles["普通"]).toEqual({weight: "400", italic: "normal"});
    await editor.press("ControlOrMeta+z"); expect(await editor.locator(".cm-line").last().textContent()).toBe("粗体粗斜斜体");
    await editor.press("ControlOrMeta+Shift+z");
    await editor.evaluate(element => {
      const locks: string[] = []; (window as any).__saveInputLocks = locks;
      const observer = new MutationObserver(records => {
        if (records.some(record => record.oldValue === "false") || element.getAttribute("contenteditable") === "false") locks.push("保存期间编辑器进入只读");
      });
      observer.observe(element, {attributes: true, attributeOldValue: true, attributeFilter: ["contenteditable"]});
      (window as any).__stopSaveInputObserver = () => {observer.disconnect(); return locks;};
    });
    await app.evaluate(({ipcMain}) => {
      const handlers = (ipcMain as any)._invokeHandlers, buffer = handlers.get("desktop:buffer");
      handlers.set("desktop:buffer", async (...args: any[]) => {
        const value = await buffer(...args);
        if (args[2] === null) {
          handlers.set("desktop:buffer", buffer);
          await new Promise<void>(resolve => {(globalThis as any).__resumeSaveFinalization = resolve;});
        }
        return value;
      });
    });
    await editor.press("ControlOrMeta+s");
    await expect.poll(() => app.evaluate(() => !!(globalThis as any).__resumeSaveFinalization)).toBe(true);
    try {
      await editor.press("Shift+F10");
      await page.getByRole("menuitem", {name: "样式", exact: true}).hover();
      await expect(page.getByRole("menu", {name: "样式", exact: true}).getByRole("menuitemcheckbox", {name: "加粗", exact: true})).toBeEnabled();
      await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
      await expect(editor).toHaveAttribute("contenteditable", "true");
    } finally {await app.evaluate(() => (globalThis as any).__resumeSaveFinalization?.());}
    const formatted = await copiedSource();
    await expect.poll(async () => (await read()).data.content).toBe(formatted);
    await editor.press("ControlOrMeta+End"); await editor.press("Enter"); await editor.press("ControlOrMeta+b");
    await page.keyboard.insertText("字"); await editor.press("Backspace");
    expect(await copiedSource()).toBe(formatted + "\r\n");
    await page.keyboard.insertText("续");
    expect(await copiedSource()).toBe(formatted + "\r\n**续**");
    expect(await page.evaluate(() => (window as any).__stopSaveInputObserver())).toEqual([]);
    expect(await editor.locator(".cm-line").last().evaluate(line => {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) if (walker.currentNode.textContent === "续") return getComputedStyle(walker.currentNode.parentElement!).fontWeight;
    })).toBe("700");
    await editor.press("ControlOrMeta+b"); await editor.press("Enter");
    await page.keyboard.insertText("- 项目"); await editor.press("Enter"); await page.keyboard.insertText("第二项");
    expect(await copiedSource()).toContain("- 项目\r\n- 第二项");
    await editor.press("Enter"); await editor.press("Enter"); await page.keyboard.insertText("退出列表");
    expect(await copiedSource()).toContain("- 第二项\r\n退出列表");
    await editor.press("Enter"); await page.keyboard.insertText("- [x] 已完成"); await editor.press("Enter");
    const lastTask = editor.locator(".cm-line").last().getByRole("checkbox", {name: "任务列表", exact: true});
    await expect(lastTask).not.toBeChecked();
    await page.keyboard.insertText("待办");
    expect(await copiedSource()).toContain("- [x] 已完成\r\n- [ ] 待办");
    await editor.press("Home"); await editor.press("Backspace");
    expect(await editor.locator(".cm-line").last().textContent()).toBe("待办");
    await editor.press("End"); await editor.press("Enter"); await editor.press("ControlOrMeta+b");
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.imeSetComposition", {text: "zhongwen", selectionStart: 8, selectionEnd: 8});
      await expect(editor.locator(".cm-line").last()).toHaveText("zhongwen");
      await expect(page.getByRole("button", {name: "保存修订", exact: true})).toBeDisabled();
      await expect(page.locator(".save-state")).toHaveText("正在输入…");
      await cdp.send("Input.imeSetComposition", {text: "中文", selectionStart: 2, selectionEnd: 2});
      await cdp.send("Input.insertText", {text: "中文"});
      await expect(editor.locator(".cm-line").last()).toHaveText("中文");
      await expect.poll(copiedSource).toMatch(/\r\n\*\*中文\*\*$/);
    } finally {await cdp.detach();}
    await editor.press("ControlOrMeta+z"); expect(await copiedSource()).not.toContain("中文");
    await editor.press("ControlOrMeta+Shift+z");
    await editor.press("Home"); await editor.press("Shift+End");
    const formatTrigger = page.locator('summary[aria-label="文字操作"]'); await formatTrigger.click();
    const formatPanel = page.locator(".editor-command-menu");
    await formatPanel.getByRole("button", {name: "红色", exact: true}).click();
    await formatPanel.getByRole("button", {name: "衬线字体", exact: true}).click();
    await expect(formatPanel.getByRole("button", {name: "红色", exact: true})).toHaveAttribute("aria-pressed", "true");
    await expect(formatPanel.getByRole("button", {name: "衬线字体", exact: true})).toHaveAttribute("aria-pressed", "true");
    await editor.press("ControlOrMeta+c"); expect(await app.evaluate(({clipboard}) => clipboard.readText())).toBe("中文");
    await editor.press("ControlOrMeta+z"); expect(await copiedSource()).not.toContain('data-hetu-font="serif"');
    await editor.press("ControlOrMeta+Shift+z");
    await formatTrigger.click(); await page.screenshot({path: info.outputPath("inline-color-and-font.png")});
    await editor.press("Escape");
    await editor.press("ControlOrMeta+s"); const finalSource = await copiedSource();
    await expect.poll(async () => (await read()).data.content).toBe(finalSource);
    expect(finalSource).toContain('data-hetu-color="red"'); expect(finalSource).toContain('data-hetu-font="serif"');
    await page.screenshot({path: info.outputPath("inline-input-and-lists.png")});
    await documentAction(page, "阅读"); await expect(page.locator(".reader")).toContainText("粗体粗斜斜体普通");
    const styled = page.locator(".reader").getByText("中文", {exact: true});
    await expect(styled).toHaveCSS("color", "rgb(206, 44, 49)"); await expect(styled).toHaveCSS("font-family", /Songti SC/);
    await page.evaluate(async () => {const api = (window as any).hetuDesktop, settings = await api.settings("preferences"); await api.settings("update", {expected_revision: settings.revision, patch: {appearance: "dark"}});});
    await expect(styled).toHaveCSS("color", "rgb(255, 149, 146)");
    expect((await read()).data.content).toBe(finalSource);
    await page.screenshot({path: info.outputPath("inline-color-and-font-dark.png")});
    expect(errors).toEqual([]);
  } finally {await app.close();}
});
