import {test,expect as baseExpect,type Page} from "@playwright/test";
import {readFile,writeFile} from "node:fs/promises";
import {launchExecutionWorkspace,createExecutionChat} from "./fixtures/execution-workspace.ts";
import {closeApplication,openSettings,closeSettings,terminalHeightUsage} from "./navigation.ts";
import {renderedContrast} from "./fixtures/rendered-contrast.ts";
const expect=baseExpect.configure({timeout:30000});

async function workspaceAction(page:Page,name:string) {
  const menu=page.getByLabel("工作区布局",{exact:true});
  if(!await menu.evaluate(element=>(element.closest("details") as HTMLDetailsElement).open))await menu.click();
  await page.getByRole("button",{name,exact:true}).click();
}

test("Orca工作面保持导航、标签、逐项设置和原GUI/PTY，浅暗宽窄可读",async({},info)=>{
  test.setTimeout(240000);test.skip(process.platform==="win32","协议夹具使用Unix可执行入口。");
  const r=await launchExecutionWorkspace({seedWork:true,evidence:info.outputDir}),errors:string[]=[],captures:any[]=[];
  r.page.on("pageerror",error=>errors.push(error.message));
  const scope={work_ref:r.work};let botSession:any;
  const runtime=async(input:Record<string,unknown>)=>{
    const result=await r.page.evaluate(({scope,input})=>window.hetuDesktop.agentSession("runtime",{...scope,domain:"bots",input}),{scope,input});
    expect(result.status,JSON.stringify(result)).toBe("succeeded");return result.data;
  };
  const get=(id?:string)=>r.page.evaluate(({scope,id})=>window.hetuDesktop.agentSession("get",{...scope,...(id?{session_id:id}:{})}),{scope,id});
  const identity=(value:any)=>({session_id:value.session_id,thread_id:value.thread_id,generation:value.generation});
  const capture=async(name:string)=>{
    await r.page.screenshot({path:info.outputPath(name+".png")});
    const value=await r.page.evaluate(()=>{
      const visible=(selector:string)=>[...document.querySelectorAll<HTMLElement>(selector)].filter(element=>element.checkVisibility({visibilityProperty:true}));
      const main=visible(".bot-main,.codex-session-main")[0],column=main?.querySelector<HTMLElement>(".agent-chat-column"),composer=main?.querySelector<HTMLElement>(".codex-composer"),textarea=composer?.querySelector("textarea"),navigation=visible(".execution-navigation")[0];
      const rect=(element:Element|undefined|null)=>{if(!element)return;const value=element.getBoundingClientRect();return {x:value.x,y:value.y,width:value.width,height:value.height,right:value.right,bottom:value.bottom};};
      return {viewport:{width:innerWidth,height:innerHeight},appearance:document.documentElement.dataset.effectiveAppearance,navigation_count:visible(".execution-navigation").length,navigation:rect(navigation),main:rect(main),column:rect(column),composer:rect(composer),textarea:textarea&&{...rect(textarea),min_height:getComputedStyle(textarea).minHeight,height:getComputedStyle(textarea).height,padding:getComputedStyle(textarea).padding},header:rect(main?.querySelector(".bot-chat-header,.codex-session-header")),horizontal_overflow:document.documentElement.scrollWidth>innerWidth+1,main_overflow:main?main.scrollWidth>main.clientWidth+1:false};
    });
    captures.push({name,...value});await writeFile(info.outputPath("captures.json"),JSON.stringify(captures,null,2)+"\n");
    expect(value.horizontal_overflow,name).toBe(false);expect(value.main_overflow,name).toBe(false);expect(value.navigation_count).toBeLessThanOrEqual(1);
    if(value.column&&value.composer){expect(Math.abs(value.column.x-value.composer.x),name).toBeLessThanOrEqual(1);expect(Math.abs(value.column.width-value.composer.width),name).toBeLessThanOrEqual(1);}
  };
  try {
    await r.page.getByRole("dialog",{name:"创建会话",exact:true}).getByRole("combobox",{name:"会话作品",exact:true}).selectOption({label:"外部执行隔离小说"});
    await createExecutionChat(r.page,"kilo");
    const input=r.page.getByRole("textbox",{name:"发送给 Agent",exact:true});
    await input.fill("核对当前材料，保留作者已经选择的表达。");await r.page.getByRole("button",{name:"发送",exact:true}).click();
    await r.page.getByRole("button",{name:"允许一次",exact:true}).click();await expect(r.page.getByText("ACP运行完成🌿",{exact:true})).toBeVisible();
    const draft="保留GUI草稿。\n沿固定材料继续。 ";await input.fill(draft);const gui=await get();
    await expect(r.page.locator(".agent-chat-column .external-session-settings")).toHaveCount(0);
    await r.page.setViewportSize({width:2560,height:1283});await capture("session-light-reference-viewport");
    await r.page.getByRole("button",{name:"关闭标签 "+gui.title,exact:true}).click();await expect(r.page.getByText("打开会话继续",{exact:true})).toBeVisible();
    const closed=await get();expect(identity(closed)).toEqual(identity(gui));expect(closed.draft).toBe(draft);expect(closed.state).toBe("ready");
    await r.page.getByRole("complementary",{name:"会话导航",exact:true}).getByRole("button",{name:gui.title,exact:true}).click();await expect(input).toHaveValue(draft);expect(identity(await get())).toEqual(identity(gui));
    await r.page.getByRole("button",{name:"新建会话",exact:true}).click();const creation=r.page.getByRole("dialog",{name:"创建会话",exact:true});await creation.getByRole("button",{name:/^引擎(?: |$)/}).click();await creation.getByRole("tab",{name:"终端",exact:true}).click();await creation.getByRole("button",{name:"打开终端",exact:true}).click();await expect(creation).toHaveCount(0);
    await expect.poll(async()=>(await get()).terminal_connected).toBe(true);const shell=await get();
    captures.push({name:"shell-height",...await terminalHeightUsage(r.page)});
    await r.page.getByRole("button",{name:"查找",exact:true}).click();await expect(r.page.getByRole("textbox",{name:"查找终端内容",exact:true})).toBeVisible();captures.push({name:"shell-height-with-search",...await terminalHeightUsage(r.page)});await r.page.getByRole("button",{name:"关闭查找",exact:true}).click();
    await r.page.locator(".xterm-helper-textarea").focus();await r.page.keyboard.type("printf 'UI-PTY-RETAINED\\n'");await r.page.keyboard.press("Enter");await expect(r.page.locator(".xterm-accessibility-tree")).toContainText("UI-PTY-RETAINED");
    await r.page.getByRole("button",{name:"关闭标签 "+shell.title,exact:true}).click();await expect(input).toHaveValue(draft);expect(identity(await get(shell.session_id))).toEqual(identity(shell));expect((await get(shell.session_id)).terminal_connected).toBe(true);
    await r.page.getByRole("complementary",{name:"会话导航",exact:true}).getByRole("button",{name:shell.title,exact:true}).click();await expect(r.page.locator(".xterm-accessibility-tree")).toContainText("UI-PTY-RETAINED");expect(identity(await get())).toEqual(identity(shell));
    await capture("shell-light-reference-viewport");
    const tabs=r.page.getByRole("tablist",{name:"会话标签",exact:true});const currentTab=tabs.getByRole("tab",{name:shell.title,exact:true});await currentTab.focus();await currentTab.press("Home");expect(identity(await get())).toEqual(identity(shell));await r.page.keyboard.press("Enter");await expect(input).toHaveValue(draft);
    const original=await get();await r.page.getByLabel("聊天设置",{exact:true}).click();await r.page.getByRole("group",{name:"聊天宽度",exact:true}).getByRole("button",{name:"宽",exact:true}).click();await expect(r.page.locator(".agent-chat-column")).toHaveCSS("max-width","960px");expect(identity(await get())).toEqual(identity(original));await expect(input).toHaveValue(draft);
    await r.page.getByLabel("聊天设置",{exact:true}).click();await r.page.getByRole("group",{name:"聊天宽度",exact:true}).getByRole("button",{name:"舒适",exact:true}).click();await expect(r.page.locator(".agent-chat-column")).toHaveCSS("max-width","736px");
    const bot=await runtime({method:"create",config:{name:"材料审阅助手",purpose:"核对当前作品的材料与作者意见，保留已经选择的表达。",execution:{provider_id:"kilo",surface:"gui",model_id:"test-model"}},operation_key:"ui-bot-create"});
    const created=(await runtime({method:"session_create",expected_ref:bot.bot_ref,operation_key:"ui-bot-session"})).result;
    botSession=(await runtime({method:"session_start",session_id:created.session_id,generation:created.generation,operation_key:"ui-bot-start"})).result;
    await r.page.getByRole("button",{name:"刷新会话导航",exact:true}).click();await expect(r.page.locator(".external-bot-row")).toContainText("材料审阅助手");
    await r.page.getByRole("searchbox",{name:"搜索 bots、作品和会话",exact:true}).fill("材料审阅");await r.page.locator(".external-bot-row").click();let bots=r.page.getByRole("region",{name:"Bots",exact:true});
    await expect(bots.getByRole("searchbox",{name:"搜索 bots、作品和会话",exact:true})).toHaveValue("材料审阅");await bots.getByRole("searchbox",{name:"搜索 bots、作品和会话",exact:true}).fill("");
    const botInput=bots.getByRole("textbox",{name:"发送给助手",exact:true});await botInput.fill("核对材料中的人物选择，保留已有意见。");await bots.getByRole("button",{name:"发送",exact:true}).click();await bots.getByRole("region",{name:"会话记录",exact:true}).getByRole("button",{name:"固定工具",exact:true}).click();await bots.getByRole("button",{name:"允许一次",exact:true}).click();await expect(bots.getByText("ACP运行完成🌿",{exact:true})).toBeVisible();
    const botDraft="保留原Bot草稿与会话。 ";await botInput.fill(botDraft);await capture("bot-home-light-reference-viewport");
    const chatSettings=bots.getByLabel("聊天设置",{exact:true});await chatSettings.click();await expect(bots.getByRole("group",{name:"聊天宽度",exact:true})).toBeVisible();await r.page.keyboard.press("Escape");await expect(bots.getByRole("group",{name:"聊天宽度",exact:true})).not.toBeVisible();await expect(bots).toBeVisible();await expect(chatSettings).toBeFocused();await expect(botInput).toHaveValue(botDraft);
    await bots.getByRole("button",{name:"Bot 设置",exact:true}).click();await expect(bots.getByText(/材料审阅助手 \/ 设置$/)).toBeVisible();await expect(r.page.getByRole("dialog",{name:"Bot 设置",exact:true})).toHaveCount(0);await capture("bot-settings-light-reference-viewport");
    await bots.getByRole("button",{name:"返回 Bot 主页",exact:true}).click();const beforePicker=await runtime({method:"session_read",session_id:botSession.session_id,format:"conversation"});
    await bots.locator(".bot-composer-model .agent-engine-trigger").click();const picker=bots.getByRole("dialog",{name:"选择引擎与模型",exact:true});await expect(picker).toBeVisible();await expect(r.page.getByRole("dialog",{name:"新建 bot",exact:true})).toHaveCount(0);await picker.getByRole("textbox",{name:"助手模型",exact:true}).fill("review-model");await capture("bot-model-picker");await r.page.keyboard.press("Escape");
    expect((await runtime({method:"get",bot_id:bot.bot_ref.bot_id})).bot.config.execution.model_id).toBe("test-model");await expect(botInput).toHaveValue(botDraft);
    await bots.locator(".bot-composer-model .agent-engine-trigger").click();await picker.getByRole("textbox",{name:"助手模型",exact:true}).fill("review-model");await picker.getByRole("button",{name:"保存配置",exact:true}).click();await expect(picker).toHaveCount(0);
    const configured=await runtime({method:"get",bot_id:bot.bot_ref.bot_id});expect(configured.bot.config.execution.model_id).toBe("review-model");expect(configured.bot.config.name).toBe("材料审阅助手");expect(configured.bot.config.purpose).toBe("核对当前作品的材料与作者意见，保留已经选择的表达。");
    const retained=await runtime({method:"session_read",session_id:botSession.session_id,format:"conversation"});expect(identity(retained)).toEqual(identity(beforePicker));expect(retained.bot_ref).toEqual(beforePicker.bot_ref);expect(retained.draft).toBe(botDraft);await expect(bots.getByRole("button",{name:"发送",exact:true})).toBeDisabled();await expect(bots.locator(".bot-original-model")).toContainText("test-model");
    await bots.getByRole("button",{name:"Bot 设置",exact:true}).click();await bots.locator(".bot-settings-profile").click();const name=bots.getByRole("textbox",{name:"Bot 名称",exact:true});await name.fill("保留冲突中的名称");
    await runtime({method:"update",expected_ref:configured.bot_ref,patch:{purpose:"另一个已固定的角色修订。"},operation_key:"ui-bot-concurrent-update"});await bots.locator(".bot-field-editor").getByRole("button",{name:"保存",exact:true}).click();await expect(bots.locator(".bot-field-editor").getByRole("alert")).toContainText("Bot配置已变化");await expect(name).toHaveValue("保留冲突中的名称");await capture("bot-name-conflict");await name.press("Escape");
    const latest=await runtime({method:"get",bot_id:bot.bot_ref.bot_id});expect(latest.bot.config.name).toBe("材料审阅助手");expect(latest.bot.config.purpose).toBe("另一个已固定的角色修订。");
    for(const appearance of ["light","dark"] as const)for(const width of [1200,520,360]) {
      const state=await r.page.evaluate(()=>window.hetuDesktop.settings("get"));await r.page.evaluate(({revision,appearance})=>window.hetuDesktop.settings("update",{expected_revision:revision,patch:{appearance}}),{revision:state.revision,appearance});await r.page.setViewportSize({width,height:850});
      if(width>=760&&!await bots.getByRole("complementary",{name:"会话导航",exact:true}).isVisible())await bots.getByRole("button",{name:"展开左侧栏",exact:true}).click();
      if(width>=760&&!await bots.getByRole("complementary",{name:"Bot 详情",exact:true}).isVisible())await bots.getByRole("button",{name:"切换 Bot 详情",exact:true}).click();
      if(width>=760){for(const selector of [".execution-group-toggle span",".execution-search kbd",".external-bot-row small",".bot-inspector-toolbar button"]){const node=bots.locator(selector).first();const contrast=await node.evaluate(renderedContrast);expect(contrast.unresolved).toEqual([]);expect(contrast.contrast,selector+" "+appearance).toBeGreaterThanOrEqual(4.5);}}
      await expect(r.page.locator("html")).toHaveAttribute("data-effective-appearance",appearance);await capture("bot-"+appearance+"-"+width);await expect(botInput).toHaveValue(botDraft);
      if(width===520){await r.page.keyboard.press(process.platform==="darwin"?"Meta+k":"Control+k");await expect(bots.getByRole("searchbox",{name:"搜索 bots、作品和会话",exact:true})).toBeFocused();await r.page.keyboard.press("Escape");await expect(bots.getByRole("complementary",{name:"会话导航",exact:true})).not.toBeVisible();await expect(bots).toBeVisible();}
    }
    await r.page.setViewportSize({width:1200,height:850});await bots.getByLabel("聊天操作",{exact:true}).click();await bots.getByRole("button",{name:"关闭外部工作面",exact:true}).click();await expect(bots).toHaveCount(0);await expect(input).toHaveValue(draft);
    const settings=await openSettings(r.application,r.page);await settings.setViewportSize({width:1200,height:850});await settings.screenshot({path:info.outputPath("settings-dark-1200.png")});await settings.getByRole("searchbox",{name:"搜索设置",exact:true}).fill("写作");await expect(settings.getByRole("tab")).toHaveCount(1);await settings.getByRole("tab",{name:"写作",exact:true}).click();await expect(settings.locator(".settings-tools")).toContainText("写作");await settings.getByRole("searchbox",{name:"搜索设置",exact:true}).press("Escape");await expect(settings.getByRole("tab")).toHaveCount(7);
    await settings.setViewportSize({width:520,height:850});await settings.screenshot({path:info.outputPath("settings-dark-520.png")});expect(await settings.locator(".settings-panel").evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);await closeSettings(settings);expect(identity(await get())).toEqual(identity(gui));await expect(input).toHaveValue(draft);
    expect(errors).toEqual([]);await writeFile(info.outputPath("result.json"),JSON.stringify({packaged:!!process.env.HETU_PACKAGED_APP,paid_model_calls:0,protocol_fixtures:true,real_shell_pty:true,checks:["shared navigation and search","close/reopen retains GUI draft and original PTY","tab arrows focus without dispatch","width preference retains identity and draft","Bot home/settings and direct model picker","cancel/commit preserves original Bot session","CAS conflict retains field input","light/dark 2560/1200/520/360 screenshots","settings search/return and narrow layout"],gui:identity(gui),shell:identity(shell),bot:identity(retained),captures,page_errors:errors},null,2)+"\n");
  } catch(error) {await r.page.screenshot({path:info.outputPath("failure.png")}).catch(()=>{});await writeFile(info.outputPath("failure.json"),JSON.stringify({error:String(error),captures,page_errors:errors},null,2)+"\n");throw error;}
  finally {if(botSession){const current=await runtime({method:"session_read",session_id:botSession.session_id,format:"conversation"});if(current.state!=="stopped")await runtime({method:"session_stop",session_id:current.session_id,generation:current.generation,operation_key:"ui-cleanup-"+current.generation});}await closeApplication(r.application);}
});
