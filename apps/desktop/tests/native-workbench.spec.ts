import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { openSettings, closeSettings, openDirectory, documentAction, closeApplication, navigate } from "./navigation.ts";
import { PluginPackage } from "../../../packages/plugin-host/src/package.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test("Mac工作台布局、正文操作与阅读位置在真实Core中贯通", async ({}, info) => {
  test.setTimeout(300000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-native-workbench-"));
  const workspace = path.join(folder, "作品"), access = path.join(folder, "access");
  const pkg = await PluginPackage.inspect(path.join(root, "plugins/relationships/dist"));
  const fixture = spawnSync(path.join(root, "target/debug/examples/plugin_fixture"),
    [workspace, access, path.join(pkg.source, "plugin.json"), pkg.sha256, "18"], { encoding: "utf8" });
  expect(fixture.status, fixture.stderr).toBe(0);
  const context = JSON.parse(fixture.stdout);
  const executable = process.env.HETU_PACKAGED_APP;
  const application = await electron.launch({ ...(executable ? { executablePath: executable, args: [] } : { args: [path.join(root, "apps/desktop")] }), env: {
    ...process.env, HETU_DESKTOP_PROFILE: path.join(folder, "profile"),
    HETU_COLLABORATION_DIR: path.join(folder, "collaboration"), HETU_PLUGIN_ACCESS_DIR: access,
    ...(!executable ? { HETU_PLUGIN_NODE: process.execPath, HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server") } : {}),
  }});
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, workspace);
    await page.getByRole("button", { name: "打开作品", exact: true }).first().click();
    await page.screenshot({ path: path.join(root, "output/desktop-native-qa/library.png") });
    await page.getByRole("button", { name: /插件集成测试/ }).click();
    await expect(page.getByRole("button", { name: "打开章节目录", exact: true })).toBeEnabled({ timeout: 30000 });
    await page.getByRole("button", { name: "打开章节目录", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "文稿编辑", exact: true })).toBeVisible({ timeout: 30000 });
    await expect(page.locator('summary[aria-label="外部 Agent 写作工具"]')).toBeVisible();
    await page.locator('summary[aria-label="外部 Agent 写作工具"]').click();
    await expect(page.getByRole("menu", { name: "写作工具", exact: true })).toContainText("扩写润色");
    await expect(page.getByRole("menu", { name: "写作工具", exact: true })).toContainText("章纲");
    await expect(page.getByRole("menu", { name: "写作工具", exact: true }).getByRole("menuitem", { name: /章纲/ })).toBeVisible();
    await page.keyboard.press("Escape");
    const maximized = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized());
    const initiallyMaximized = await maximized();
    await page.getByRole("button", { name: "缩放窗口", exact: true }).click();
    await expect.poll(maximized).toBe(!initiallyMaximized);
    await page.getByRole("button", { name: "缩放窗口", exact: true }).click();
    await expect.poll(maximized).toBe(initiallyMaximized);
    await page.setViewportSize({ width: 1600, height: 1000 });
    const read = (action: string, input: any) => page.evaluate(({ action, input }) => (window as any).hetuDesktop.read(action, input), { action, input });
    const original = (await read("hetu.documents.get", { document_id: context.document.document_id })).data;
    const content = Array.from({length: 90}, (_, i) => `第${i + 1}段：清晨的雾气沿着山谷缓缓流动。江岚把旧日记放回书袋，沿海岸寻找灯塔。每一封信，都有自己的来处。`).join("\n");
    expect((await read("hetu.documents.save", { document_id: context.document.document_id,
      base_revision_id: original.revision.revision_id, source_format: "markdown", content, operation_key: "native-workbench-sample" })).status).toBe("succeeded");
    await openDirectory(page);
    await page.getByRole("button", { name: "第一章 雾港", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "文稿编辑", exact: true });
    await expect(editor).toBeVisible();
    await expect(page.getByRole("tab", { name: "打开文稿 第一章 雾港", exact: true })).toBeVisible();
    await application.evaluate(({ipcMain}) => {
      const handlers = (ipcMain as any)._invokeHandlers, read = handlers.get("desktop:read");
      handlers.set("desktop:read", async (...args: any[]) => {
        const value = await read(...args);
        if (args[1] === "hetu.documents.list") {
          handlers.set("desktop:read", read);
          await new Promise<void>(resolve => {(globalThis as any).__resumeDirectoryRefresh = resolve;});
        }
        return value;
      });
    });
    await page.locator('summary[aria-label="目录操作"]').click();
    await page.getByRole("button", { name: "刷新目录", exact: true }).click();
    await expect.poll(() => application.evaluate(() => !!(globalThis as any).__resumeDirectoryRefresh)).toBe(true);
    await expect(page.getByRole("button", { name: "目录试读第001章", exact: true })).toBeVisible();
    try {
      await page.getByRole("button", { name: "目录试读第001章", exact: true }).click();
      await expect(page.getByRole("tab", { name: "打开文稿 目录试读第001章", exact: true })).toHaveAttribute("aria-selected", "true");
    } finally { await application.evaluate(() => (globalThis as any).__resumeDirectoryRefresh?.()); }
    await expect(page.getByRole("navigation", {name: "文稿目录", exact: true})).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("tab", { name: "打开文稿 目录试读第001章", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "打开文稿 目录试读第001章", exact: true }).locator(".." )).toHaveAttribute("data-preview", "true");
    await page.getByRole("tab", { name: "打开文稿 目录试读第001章", exact: true }).dblclick();
    await expect(page.getByRole("tab", { name: "打开文稿 目录试读第001章", exact: true }).locator(".." )).toHaveAttribute("data-preview", "false");
    await page.getByRole("button", { name: "第一章 雾港", exact: true }).click();
    await expect(page.getByRole("tab", { name: "打开文稿 第一章 雾港", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "打开文稿 第一章 雾港", exact: true }).locator(".." )).toHaveAttribute("data-preview", "true");
    await expect(page.getByRole("tab", { name: "打开文稿 目录试读第001章", exact: true }).locator(".." )).toHaveAttribute("data-preview", "false");
    await page.getByRole("tab", { name: "打开文稿 第一章 雾港", exact: true }).click();
    await expect(page.getByRole("tab", { name: "打开文稿 第一章 雾港", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".cm-line").first()).toContainText("第1段");
    await page.getByRole("tab", { name: "打开文稿 第一章 雾港", exact: true }).press("ArrowRight");
    await expect(page.getByRole("tab", { name: "打开文稿 目录试读第001章", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".cm-line").first()).toContainText("江岚在第1个清晨抵达雾港");
    await page.getByRole("tab", { name: "打开文稿 第一章 雾港", exact: true }).click();
    await expect(page.getByRole("tab", { name: "打开文稿 第一章 雾港", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".cm-line").first()).toContainText("第1段");
    await page.locator('.document-tab[data-active="true"] .document-tab-close').click();
    await expect(page.getByRole("tab", { name: "打开文稿 第一章 雾港", exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "打开文稿 目录试读第001章", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.locator('.document-tab[data-active="true"] .document-tab-close').click();
    for (let index = 0; index < 3; index++) {
      const closes = page.locator(".document-tab-close");
      if (!await closes.count()) break;
      await closes.first().click();
    }
    await expect(page.getByRole("region", { name: "当前作品资料", exact: true })).toBeVisible();
    await navigate(page, "小说");
    await openDirectory(page);
    await page.getByRole("button", { name: "第一章 雾港", exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(page.locator(".cm-line").first()).toContainText("第1段");
    const size = async (selector: string) => page.locator(selector).evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
    expect((await size(".workbench-topbar")).height).toBe(52);
    expect((await size(".project-navigation")).width).toBe(280);
    const navigationInnerWidth = await page.locator(".project-navigation").evaluate(element => {
      const style = getComputedStyle(element); return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    });
    expect((await size(".manuscript-directory")).width).toBe(navigationInnerWidth - 8);
    await expect(page.locator(".project-navigation .manuscript-directory")).toHaveCount(1);
    const stage=page.locator(".manuscript-stage");
    const assertFullWorkspace=async()=>{
      const geometry=await page.locator(".manuscript-workspace").evaluate(el=>{
        const stage=el.querySelector<HTMLElement>(".manuscript-stage")!,paper=el.querySelector<HTMLElement>(".manuscript-paper")!,header=el.querySelector<HTMLElement>(".manuscript-header")!,inner=el.querySelector<HTMLElement>(".manuscript-scroll")!,editor=el.querySelector<HTMLElement>(".author-editor")!,cm=el.querySelector<HTMLElement>(".cm-scroller")!;
        const work=el.getBoundingClientRect(),body=stage.getBoundingClientRect(),sheet=paper.getBoundingClientRect();
        return {width:work.width,height:work.height,stageWidth:body.width,stageHeight:body.height,paperWidth:sheet.width,paperHeight:sheet.height,left:body.left-work.left,right:work.right-body.right,header:header.getBoundingClientRect().height,headerTop:header.getBoundingClientRect().top-work.top,border:getComputedStyle(paper).borderTopWidth,radius:getComputedStyle(paper).borderTopLeftRadius,padding:getComputedStyle(stage).paddingLeft,innerOverflow:getComputedStyle(inner).overflowY,cmOverflow:getComputedStyle(cm).overflowY,cmScroll:cm.scrollTop,editorWidth:editor.getBoundingClientRect().width};
      });
      expect(geometry.stageWidth).toBe(geometry.width);expect(geometry.stageHeight).toBeCloseTo(geometry.height-geometry.header,0);expect(geometry.paperWidth).toBe(geometry.width);expect(geometry.paperHeight).toBeGreaterThanOrEqual(geometry.stageHeight);
      expect(geometry.left).toBe(0);expect(geometry.right).toBe(0);expect(geometry.border).toBe("0px");expect(geometry.radius).toBe("0px");expect(geometry.padding).toBe("0px");expect(geometry.header).toBeLessThanOrEqual(72);expect(geometry.headerTop).toBe(0);expect(geometry.innerOverflow).toBe("visible");expect(geometry.cmOverflow).toBe("visible");expect(geometry.cmScroll).toBe(0);expect(geometry.editorWidth).toBeLessThanOrEqual(880);
    };
    await assertFullWorkspace();
    await page.setViewportSize({width:2560,height:1280});await assertFullWorkspace();await page.screenshot({path:info.outputPath("novel-full-workspace-2560.png")});await page.setViewportSize({width:1600,height:1000});

    const proseLayout = await page.locator(".author-editor").evaluate(element => {
      const style = getComputedStyle(element);
      return { width: element.getBoundingClientRect().width, available: element.parentElement!.clientWidth,
        border: style.borderTopWidth, padding: style.paddingLeft,
        indent: getComputedStyle(element.querySelector(".cm-line")!).textIndent, fontSize: style.fontSize };
    });
    expect(proseLayout.width).toBeLessThanOrEqual(proseLayout.available);
    expect(proseLayout.width).toBeLessThanOrEqual(880);
    expect(proseLayout.border).toBe("0px");
    expect(proseLayout.padding).toBe("0px");
    expect(proseLayout.indent).toBe("0px");
    expect(proseLayout.fontSize).toBe("16px");
    const typography = await page.evaluate(() => [...new Set([...document.querySelectorAll<HTMLElement>("body *")]
      .filter(element => element.checkVisibility() && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()))
      .map(element => parseFloat(getComputedStyle(element).fontSize)))].sort((a, b) => a - b));
    expect(typography).toEqual([12, 13, 14, 16, 20]);
    expect(await page.locator('.sidebar-project button').filter({hasText:"小说"}).evaluate(element => getComputedStyle(element, "::before").content)).toBe("none");
    expect(await page.locator(".manuscript-paper").evaluate(element => getComputedStyle(element).boxShadow)).toBe("none");
    expect(await page.locator(".workbench-topbar").innerText()).not.toContain("·");
    await page.screenshot({ path: path.join(root, "output/desktop-native-qa/manuscript-light.png") });
    // 显示偏好不能影响保存原文，也不能令搜索选区自动展开检查器。
    await page.getByRole("button", { name: "搜索正文", exact: true }).click();
    await page.getByRole("textbox", { name: "搜索正文内容" }).fill("第70段");
    await expect(page.locator(".document-search")).toContainText("1 处");
    await expect(page.getByRole("complementary", { name: "检查器", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "关闭正文搜索", exact: true }).click();
    await page.locator(".manuscript-stage").evaluate((element) => { element.scrollTop = 1000; });
    await expect.poll(() => page.locator(".manuscript-stage").evaluate((element) => element.scrollTop)).toBeGreaterThan(900);
    await page.getByRole("button", { name: "作品资料", exact: true }).click();
    await expect(page.getByRole("region", { name: "当前作品资料", exact: true }).getByRole("heading", { name: "插件集成测试", exact: true })).toBeVisible();
    await expect.poll(() => page.locator(".default-cover img").first().evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    expect(await size(".profile-cover .work-cover")).toEqual({ width: 168, height: 252 });
    expect(await page.evaluate(async () => (await (window as any).hetuDesktop.read("hetu.covers.get", {})).data.cover)).toBeNull();
    await page.locator('summary[aria-label="更多封面操作"]').click();
    await page.getByRole("button", { name: "封面历史", exact: true }).click();
    await expect(page.getByRole("tab", { name: "历史", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "关闭封面窗口", exact: true }).click();
    await page.screenshot({ path: path.join(root, "output/desktop-native-qa/work-profile.png") });
    await navigate(page, "小说"); await openDirectory(page);
    await expect(editor).toBeVisible();
    await expect.poll(() => stage.evaluate((element) => element.scrollTop)).toBeGreaterThan(900);
    await documentAction(page,"阅读");await expect(page.locator(".reader")).toBeVisible();await expect.poll(()=>stage.evaluate(el=>el.scrollTop)).toBeGreaterThan(900);
    expect(await page.locator(".manuscript-scroll").evaluate(el=>getComputedStyle(el).overflowY)).toBe("visible");
    await documentAction(page,"编辑");await expect(editor).toBeVisible();await expect.poll(()=>stage.evaluate(el=>el.scrollTop)).toBeGreaterThan(900);
    await page.locator('summary[aria-label="更多操作"]').click();
    await page.getByRole("button", { name: "专注阅读", exact: true }).click();
    await expect(page.locator(".project-navigation")).toBeHidden();
    await expect(page.locator(".manuscript-directory")).toBeHidden();
    await page.locator('summary[aria-label="更多操作"]').click();
    await page.getByRole("button", { name: "退出专注", exact: true }).click();
    await page.getByRole("button", { name: "卷章目录", exact: true }).click();
    await expect(page.locator(".manuscript-directory")).toBeHidden();
    await page.getByRole("button", { name: "卷章目录", exact: true }).click();
    await expect(page.locator(".manuscript-directory")).toBeVisible();
    await documentAction(page,"比较修订与定稿");
    await expect(page.getByRole("dialog",{name:"文稿详情",exact:true})).toBeVisible();
    await expect(page.locator(".manuscript-inspector")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "比较修订", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "比较修订", exact: true }).selectOption(original.revision.revision_id);
    const comparison = page.locator("dialog.revision-comparison");
    await expect(comparison).toBeVisible();
    await expect(comparison.getByRole("heading", { name: "历史修订", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭修订比较", exact: true }).click();
    await page.getByRole("combobox", { name: "比较修订", exact: true }).selectOption(original.revision.revision_id);
    await expect(comparison).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "关闭文稿详情", exact: true }).click();
    await editor.focus();
    await editor.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await page.keyboard.insertText("\n作者继续保留的结尾。");
    await expect(page.getByRole("button", { name: "保存修订", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "作品资料", exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(page.locator(".notice")).toContainText("请先保存");
    await page.getByRole("button", { name: "保存修订", exact: true }).click();
    await expect(page.locator(".save-state")).toContainText("修订已保存");
    expect((await read("hetu.documents.get", { document_id: context.document.document_id })).data.content).toBe(content + "\n作者继续保留的结尾。");
    await editor.focus();
    await editor.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
    await editor.press("Shift+ArrowRight");
    await editor.press("Shift+ArrowRight");
    await expect(page.getByRole("toolbar",{name:"选区操作",exact:true})).toBeVisible();
    await expect(page.getByRole("dialog",{name:"文稿详情",exact:true})).toHaveCount(0);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+m" : "Control+Alt+m");
    await page.getByRole("textbox", { name: "原文批注意见", exact: true }).fill("保留这个开头。");
    await page.getByRole("button", { name: "保存批注", exact: true }).click();
    await expect(page.locator(".notice")).toContainText("已记录固定原文批注");
    const notes = (await read("hetu.annotations.list", { document_id: context.document.document_id })).data.items;
    expect(notes[0].source_ref.quote).toBe("第1");
    expect(notes[0].source_ref.byte_start).toBe(0);
    expect(notes[0].source_ref.byte_end).toBe(4);
    await expect(page.getByRole("button",{name:"查看原文批注 1",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"查看原文批注 1",exact:true}).click();
    await expect(page.getByRole("dialog",{name:"原文批注",exact:true})).toContainText("保留这个开头。");
    expect(await page.locator(".annotation-popover").evaluate(el=>getComputedStyle(el).backgroundColor)).toBe(await page.locator(".manuscript-paper").evaluate(el=>getComputedStyle(el).backgroundColor));
    const markerBounds=await page.locator(".annotation-marker").boundingBox(),editorBounds=await page.locator(".author-editor").boundingBox();
    expect(markerBounds!.x).toBeGreaterThanOrEqual(editorBounds!.x+editorBounds!.width);
    await page.screenshot({path:info.outputPath("novel-comment-light.png")});
    await page.getByRole("button",{name:"编辑意见",exact:true}).click();
    await page.getByRole("textbox",{name:"原文批注意见",exact:true}).fill("保留开头，核对后文。");
    await page.getByRole("button",{name:"保存批注",exact:true}).click();
    await page.getByRole("button",{name:"查看原文批注 1",exact:true}).click();
    await page.getByRole("button",{name:"标为已处理",exact:true}).click();
    await expect(page.locator(".annotation-list")).toContainText("已处理");
    await expect(page.locator(".annotation-marker")).toHaveCount(0);
    await page.locator(".annotation-list > button").click();
    await page.getByRole("button",{name:"重新打开",exact:true}).click();
    await page.getByRole("button",{name:"关闭批注",exact:true}).click();
    await expect(page.locator(".annotated-source")).toBeVisible();
    expect((await read("hetu.annotations.list",{document_id:context.document.document_id})).data.items[0]).toMatchObject({text:"保留开头，核对后文。",resolved:false,source_ref:notes[0].source_ref});
    await editor.press("ControlOrMeta+a");await editor.press("Backspace");
    await expect(page.locator(".annotation-marker")).toHaveCount(0);await expect(page.locator(".annotated-source")).toHaveCount(0);
    await editor.press("ControlOrMeta+z");await expect(page.locator(".annotated-source")).toBeVisible();
    await editor.press("ControlOrMeta+Home");await expect(page.locator(".annotation-marker")).toBeVisible();
    await page.locator(".manuscript-stage").hover();await page.mouse.wheel(0,1200);
    await expect.poll(()=>page.locator(".manuscript-stage").evaluate(el=>el.scrollTop)).toBeGreaterThanOrEqual(1199);
    await expect.poll(()=>page.locator(".annotation-marker").count()).toBe(0);
    await page.locator(".manuscript-stage").evaluate(el=>el.scrollTop=0);
    await expect(page.locator(".annotation-marker")).toBeVisible();
    // 实际保存成功后丢失回执，恢复必须使用原操作键，不能新增第二条批注。
    await application.evaluate(({ipcMain})=>{
      const handlers=(ipcMain as any)._invokeHandlers, original=handlers.get("desktop:read");
      (globalThis as any).__annotationKeys=[]; let fail=true;
      ipcMain.removeHandler("desktop:read");
      ipcMain.handle("desktop:read",async(event,action,input)=>{
        const result=await original(event,action,input);
        if(action==="hetu.annotations.save"){
          (globalThis as any).__annotationKeys.push(input.operation_key);
          if(fail){fail=false;throw new Error("验收：保存完成后回执中断");}
        }
        return result;
      });
    });
    await page.locator(".annotated-source").click();
    await page.getByRole("button",{name:"编辑意见",exact:true}).click();
    await page.getByRole("textbox",{name:"原文批注意见",exact:true}).fill("回执恢复后仍保留开头。");
    await page.getByRole("button",{name:"保存批注",exact:true}).click();
    await expect(page.getByRole("button",{name:"恢复原批注",exact:true})).toBeVisible();
    await expect(page.locator(".notice")).toContainText("原批注输入已保留");
    await page.getByRole("button",{name:"恢复原批注",exact:true}).click();
    await expect(page.getByRole("button",{name:"恢复原批注",exact:true})).toHaveCount(0);
    const keys=await application.evaluate(()=>(globalThis as any).__annotationKeys);
    expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
    const recoveredNotes=(await read("hetu.annotations.list",{document_id:context.document.document_id})).data.items;
    expect(recoveredNotes).toHaveLength(1);expect(recoveredNotes[0].text).toBe("回执恢复后仍保留开头。");
    await page.getByRole("button",{name:"关闭批注",exact:true}).click();
    const settingsPage = await openSettings(application, page);
    await expect(settingsPage.getByRole("tab", { name: "通用", exact: true })).toHaveAttribute("aria-selected", "true");
    await settingsPage.screenshot({ path: path.join(root, "output/desktop-native-qa/settings.png") });
    await settingsPage.getByRole("tab", { name: "写作", exact: true }).click();
    await expect(settingsPage.locator(".reading-preview")).toBeVisible();
    await settingsPage.locator(".reading-preview").scrollIntoViewIfNeeded();
    await settingsPage.screenshot({ path: path.join(root, "output/rea-mac-ui-20261116/settings-writing.png") });
    await settingsPage.getByRole("tab", { name: "通用", exact: true }).click();
    await settingsPage.getByRole("radio", { name: "深色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
    await closeSettings(settingsPage);
    await expect(page.locator(".manuscript-paper")).toHaveCSS("background-color", "rgb(34, 34, 34)");
    await page.screenshot({ path: path.join(root, "output/desktop-native-qa/manuscript-dark.png") });
    await page.setViewportSize({ width: 760, height: 800 });
    await expect(page.locator(".manuscript-directory")).toBeHidden();
    await page.getByRole("button", { name: "卷章目录", exact: true }).click();
    await expect(page.locator(".manuscript-directory")).toBeVisible();
    await expect(page.getByRole("button", { name: "关闭导航浮层", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".manuscript-directory")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(root, "output/desktop-native-qa/manuscript-narrow.png") });
    await page.setViewportSize({width:760,height:800});await assertFullWorkspace();
    await page.getByRole("button",{name:"原文批注",exact:true}).click();
    await page.locator(".annotation-list > button").click();
    const annotation=page.getByRole("dialog",{name:"原文批注",exact:true});await expect(annotation).toContainText("回执恢复后仍保留开头。");
    const floating=await annotation.boundingBox(),bounds=await page.getByRole("region",{name:"正文工作区",exact:true}).boundingBox();
    expect(floating!.x).toBeGreaterThanOrEqual(bounds!.x);expect(floating!.x+floating!.width).toBeLessThanOrEqual(bounds!.x+bounds!.width);
    await page.screenshot({path:info.outputPath("novel-comment-dark-760.png")});await page.keyboard.press("Escape");await expect(annotation).toHaveCount(0);
    await page.setViewportSize({width:1600,height:1000});
    if(!await page.getByRole("button", { name: "显示项目导航", exact: true }).isVisible()) await page.getByRole("button",{name:"项目导航",exact:true}).click();
    await navigate(page, "返回创作库");
    await page.getByRole("button", { name: /独立剧本/ }).click();
    await expect(page.getByRole("button", { name: "第一集", exact: true })).toBeEnabled({ timeout: 30000 });
    await page.getByRole("button", { name: "第一集", exact: true }).click();
    await expect(page.getByRole("article", { name: "分集剧本", exact: true })).toBeVisible();
    expect(await page.evaluate(async () => { try { await (window as any).hetuDesktop.read("hetu.covers.get", {}); return false; } catch { return true; } })).toBe(true);
    expect(errors).toEqual([]);
  } finally { await closeApplication(application); }
});
