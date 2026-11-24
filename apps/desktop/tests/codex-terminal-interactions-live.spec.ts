import {createTerminal,switchAgentSurface} from "./navigation.ts";
import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {openSettings,closeSettings} from "./navigation.ts";

const root=path.resolve(import.meta.dirname,"../../..");
test("终端查找的快捷键、菜单、无匹配和关闭保持输入焦点与原会话",async({},testInfo)=>{
  test.skip(process.env.HETU_LIVE_CODEX!=="1","需显式启用真实本机Codex验收");test.setTimeout(120000);
  const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-terminal-interactions-")),executable=process.env.HETU_PACKAGED_APP;
  const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:path.join(profile,"collaboration")};
  for(const key of ["HETU_APP_SERVER","HETU_CLI","HETU_MCP","HETU_PLUGIN_NODE","ELECTRON_RUN_AS_NODE"])delete (env as Record<string,string|undefined>)[key];
  const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...env,...(!executable?{HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}: {})}});
  try{
    const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});
    await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled({timeout:30000});
    await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();
    await createTerminal(page);
    const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));
    await expect.poll(async()=>{const s=await get();return s.terminal_connected&&s.terminal_replay?.includes("]7501;state=idle");},{timeout:45000}).toBe(true);
    const before=await get(),input=page.locator(".xterm-helper-textarea"),query=page.getByRole("textbox",{name:"查找终端内容",exact:true});
    const shortcut=process.platform==="darwin"?"Meta+f":"Control+Shift+f";
    await input.focus();await page.keyboard.press(shortcut);await expect(query).toBeFocused();await query.fill("Codex");
    // 面板已经打开时再次查找，仍须返回查询，不把快捷键留在终端。
    await input.focus();await page.keyboard.press(shortcut);await expect(query).toBeFocused();
    expect(await query.evaluate(element=>{const input=element as HTMLInputElement;return input.selectionStart===0&&input.selectionEnd===input.value.length;})).toBe(true);
    await query.evaluate(element=>element.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",isComposing:true,bubbles:true,cancelable:true})));
    await expect(query).toBeFocused();
    await query.press("Escape");await expect(query).toHaveCount(0);await expect(input).toBeFocused();
    await page.getByRole("button",{name:"查找",exact:true}).click();await expect(query).toBeFocused();
    await query.fill("找不到的终端内容-unique");await expect(page.locator(".codex-terminal-search").getByRole("status")).toHaveText("未找到");
    await page.screenshot({path:testInfo.outputPath("terminal-search-no-match.png")});
    await query.fill("");await expect(page.getByRole("button",{name:"上一个",exact:true})).toBeDisabled();await expect(page.getByRole("button",{name:"下一个",exact:true})).toBeDisabled();
    await page.getByRole("button",{name:"关闭查找",exact:true}).click();await expect(input).toBeFocused();
    const anchor=page.getByRole("button",{name:"新建会话",exact:true}),terminal=page.locator(".codex-terminal");
    const hover=async()=>{await anchor.hover();await terminal.hover({position:{x:120,y:120}});};
    const preferences=await page.evaluate(()=>window.hetuDesktop.settings("preferences"));
    expect(preferences.preferences.agent_session.terminal_focus_on_hover).toBe(false);
    await anchor.focus();await hover();await expect(anchor).toBeFocused();
    const focusPreference=async(enabled:boolean)=>{
      await page.evaluate(async enabled=>{const api=window.hetuDesktop,p=await api.settings("preferences");await api.settings("update",{expected_revision:p.revision,patch:{agent_session:{terminal_focus_on_hover:enabled}}});},enabled);
      await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].focus());
    };
    const settings=await openSettings(app,page);await settings.getByRole("tab",{name:"AI 协作",exact:true}).click();
    const hoverSetting=settings.getByRole("checkbox",{name:"焦点随鼠标移动",exact:true});await expect(hoverSetting).not.toBeChecked();await hoverSetting.check();await expect(hoverSetting).toBeChecked();await closeSettings(settings);
    await anchor.focus();await hover();await expect(input).toBeFocused();
    await page.getByRole("button",{name:"查找",exact:true}).click();await expect(query).toBeFocused();await hover();await expect(query).toBeFocused();
    await query.press("Escape");
    await page.getByLabel("会话操作",{exact:true}).click();await page.getByRole("button",{name:"重命名",exact:true}).click();
    const name=page.getByRole("textbox",{name:"会话名称",exact:true});await expect(name).toBeFocused();await hover();await expect(name).toBeFocused();
    await page.getByRole("button",{name:"取消",exact:true}).click();
    await page.getByLabel("会话操作",{exact:true}).click();await page.getByRole("button",{name:"移除会话记录",exact:true}).click();
    const cancel=page.getByRole("alertdialog",{name:"移除会话记录",exact:true}).getByRole("button",{name:"取消",exact:true});await cancel.focus();await hover();await expect(cancel).toBeFocused();await cancel.click();
    await terminal.click({button:"right"});const menuFind=page.getByRole("menuitem",{name:"查找",exact:true});await menuFind.focus();await hover();await expect(menuFind).toBeFocused();await page.keyboard.press("Escape");
    await focusPreference(false);await anchor.focus();await hover();await expect(anchor).toBeFocused();await input.focus();
    await page.getByRole("button",{name:"查找",exact:true}).click();await expect(query).toBeFocused();
    await expect(page.getByRole("button",{name:"查找",exact:true})).toHaveAttribute("aria-expanded","true");
    await page.getByRole("button",{name:"查找",exact:true}).click();await expect(query).toHaveCount(0);await expect(input).toBeFocused();
    await page.locator(".codex-terminal").click({button:"right"});await page.getByRole("menuitem",{name:"查找",exact:true}).click();await expect(query).toBeFocused();
    await query.fill("Codex");await expect(page.locator(".codex-terminal-search").getByRole("status")).toHaveCount(0);
    await query.press("Enter");await query.press("Shift+Enter");await expect(query).toBeFocused();
    await page.screenshot({path:testInfo.outputPath("terminal-search.png")});
    await page.getByRole("button",{name:"关闭查找",exact:true}).click();await expect(input).toBeFocused();
    // 关闭后直接输入必须进入原生输入框，且没有自动提交。
    await page.keyboard.type("search-return-marker");await expect(page.locator(".xterm-accessibility-tree")).toContainText("search-return-marker");
    await page.keyboard.press("Control+u");
    const after=await get();expect(after.thread_id).toBe(before.thread_id);expect(after.generation).toBe(before.generation);expect(after.messages).toHaveLength(0);
    await writeFile(testInfo.outputPath("result.json"),JSON.stringify({packaged:!!executable,thread_id:after.thread_id,generation:after.generation,messages:after.messages.length,checks:["shortcut-refocus","query-selection","simulated-composition-escape-guard","escape-return","empty-query-disabled","no-match","button-return","toolbar-toggle-return","context-menu-focus","next-previous","native-input-after-close","hover-default-off","hover-enabled-live","hover-preserves-search-form-and-dialog","hover-disabled-live"],limits:["composition事件模拟只验证界面边界，不替代系统原生输入法实测"]},null,2)+"\n");
  }catch(error){await app.windows()[0]?.screenshot({path:testInfo.outputPath("failure.png"),timeout:5000}).catch(()=>{});throw error;}
  finally{await app.close();}
});
