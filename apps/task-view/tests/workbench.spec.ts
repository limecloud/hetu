import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";

let server: Server, origin: string, html: string;
const work = { workspace_id: "workspace_11111111-1111-4111-8111-111111111111", kind: "novel", object_id: "novel_11111111-1111-4111-8111-111111111111" };
const management = { scope_ref: { kind: "workspace", id: work.workspace_id }, grant_id: "a".repeat(64), grant_revision: 1 };
const actions = {
  "hetu.works.get": { summary: { title: "雾港", work_ref: work }, record: { metadata: { title: "雾港", synopsis: "循着旧灯塔寻找失踪的人。" } } },
  "hetu.novels.get": { novel: { metadata: { title: "雾港" }, volumes: [{ title: "第一卷" }], chapters: [{ title: "潮水", document_id: "doc_first", current_revision_id: "rev_first" }] } },
  "hetu.documents.get": { document: { title: "潮水" }, content: "潮水退后，石阶上留下了一盏灯。", revision: { revision_id: "rev_first", sha256: "b".repeat(64) } },
  "hetu.outlines.get": { outline: { title: "灯塔的秘密", content: "失踪与归来。" } },
  "hetu.blueprints.get": { blueprint: { characters: [{ name: "沈砚", description: "旧灯塔的守护人。" }] } },
  "hetu.creative_tasks.list": { tasks: [] }, "hetu.resources.list": { resources: [{ title: "港口考据", body: "潮汐与航运。" }] },
  "hetu.assets.list": { assets: [] }, "hetu.cues.list": { cues: [] }, "hetu.reviews.list": { reviews: [] },
  "hetu.reports.list": { reports: [] }, "hetu.work_links.list": { links: [] }, "hetu.git.status": { dirty: false },
  "hetu.agent_operations.list": { operations: [{ summary: "固定交付方案", state: "pending" }] },
  "hetu.plugins.inspect": { packages: [{ name: "山海", version: "0.2.0", enabled: true }] },
  "hetu.local_settings.get": { preferences: { appearance: "dark", font_size: 18 } },
  "hetu.model_settings.inspect": { channels: [{ name: "作者渠道", configured: true }] },
};
test.beforeAll(async () => {
  html = await readFile("../mcp/resources/workbench.html", "utf8");
  const host = await build({ entryPoints: ["tests/host.ts"], bundle: true, write: false, format: "esm", target: "es2022" });
  server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/host.js" ? "application/javascript" : "text/html"); res.end(req.url === "/host.js" ? host.outputFiles[0].text : '<!doctype html><meta charset="utf-8"><script type="module" src="/host.js"></script>'); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No host"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
async function open(page: Page, bound = true, deepLink?: string, entries: Record<string, unknown>[] = [{ title: "雾港", work_ref: work }], overrides: Record<string,unknown> = {}) {
  await page.addInitScript(value => Object.assign(window, value), { viewHtml: html, initialTask: { content: [], structuredContent: { status: "succeeded", data: { app: bound ? { route: "works", management_ref: management } : { route: "home" }, ...(bound ? { works: entries } : {}) } } }, testActions: {...actions,...overrides}, testExtensions: true, testMessages: true, testDeepLink: deepLink, testTheme: await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") });
  await page.goto(origin);
  const view = page.frameLocator("iframe"); await expect(view.getByRole("heading", { name: "河图洛书", exact: true })).toBeVisible(); return view;
}
test("empty global entry does not enumerate works, grants or files", async ({ page }) => {
  const view = await open(page, false);
  await expect(view.getByText(/尚未打开获权作品/)).toBeVisible();
  expect(await page.evaluate(() => window.harness.calls)).toEqual([]);
  await expect(view.getByRole("button", { name: "本机设置", exact: true })).toBeVisible();
});
test("global library keeps desktop registrations visible and selects each exact grant without authorizing other works",async({page})=>{
  const drama={...work,kind:"drama",object_id:"drama_registered"};
  const another={...work,workspace_id:"workspace_22222222-2222-4222-8222-222222222222",object_id:"novel_22222222-2222-4222-8222-222222222222"};
  const anotherGrant={...management,grant_id:"d".repeat(64),scope_ref:{kind:"workspace",id:another.workspace_id}};
  const rows=[{title:"雾港",work_ref:work,authorized:true,management_ref:management},{title:"持械入宋 全书改编",work_ref:drama,authorized:false},{title:"长河",work_ref:another,authorized:true,management_ref:anotherGrant}];
  await page.addInitScript(value=>Object.assign(window,value),{viewHtml:html,initialTask:{content:[],structuredContent:{status:"succeeded",data:{app:{route:"library"},works:rows,total:3}}},testActions:{...actions,"hetu.collaboration.library":{works:rows,total:3,next_cursor:null}},testMessages:true,testExtensions:true});
  await page.goto(origin);const view=page.frameLocator("iframe");
  await expect(view.getByRole("button",{name:/^打开作品 /})).toHaveCount(3);
  await expect(view.getByText("尚未打开获权作品")).toHaveCount(0);
  await view.getByRole("button",{name:"打开作品 持械入宋 全书改编",exact:true}).click();
  await expect(view.getByRole("status")).toContainText("尚未授权");
  expect((await page.evaluate(()=>window.harness.calls)).filter(call=>call.arguments?.action==="hetu.works.get")).toHaveLength(0);
  await view.getByRole("button",{name:"放入当前草稿",exact:true}).click();
  await expect.poll(async()=>JSON.stringify(await page.evaluate(()=>window.harness.wireMessages))).toContain("drama_registered");
  expect(JSON.stringify(await page.evaluate(()=>window.harness.wireMessages))).not.toContain("grant_id");
  await view.getByRole("button",{name:"打开作品 雾港",exact:true}).click();
  await expect(view.getByText("循着旧灯塔寻找失踪的人。",{exact:true})).toBeVisible();
  await view.getByRole("button",{name:"返回创作库",exact:true}).click();
  await view.getByRole("button",{name:"打开作品 长河",exact:true}).click();
  const calls=await page.evaluate(()=>window.harness.calls);
  expect(calls.filter(call=>call.name==="hetu_call_action"&&call.arguments?.action==="hetu.works.get").map(call=>call.arguments?.input)).toEqual([
    {work_ref:work,management_ref:management},{work_ref:another,management_ref:anotherGrant},
  ]);
  await view.getByRole("button",{name:"返回创作库",exact:true}).click();
  await page.evaluate(()=>{window.testActions!["hetu.collaboration.library"]={works:[],total:0,next_cursor:null};});
  await view.getByRole("button",{name:"刷新创作库",exact:true}).click();
  await expect(view.getByRole("button",{name:/^打开作品 /})).toHaveCount(0);
  await expect(view.getByText("还没有登记的作品",{exact:true})).toBeVisible();
});
test("a failed global catalog read shows recovery instead of reporting an empty library",async({page})=>{
  await page.addInitScript(value=>Object.assign(window,value),{viewHtml:html,initialTask:{content:[],structuredContent:{status:"blocked",data:{app:{route:"library"}},error:{code:"hetu.integrity_failure",message:"创作库登记损坏"}}}});
  await page.goto(origin);const view=page.frameLocator("iframe");
  await expect(view.getByRole("alert")).toContainText("创作库登记损坏");
  await expect(view.getByText("尚未打开获权作品",{exact:true})).toHaveCount(0);
  await expect(view.getByRole("button",{name:"重新读取创作库",exact:true})).toBeVisible();
});
test("workbench follows exact work and fixed document references across domain views", async ({ page }) => {
  test.setTimeout(60_000); // 本例连续核对作品、正文、固定引用及多次鼠标与键盘菜单交互。
  const view = await open(page);
  await view.getByRole("button", { name: "打开作品 雾港", exact: true }).click();
  await expect(view.locator("h2", { hasText: "作品资料" })).toBeVisible();
  await expect(view.getByRole("tablist", { name: "打开的文稿", exact: true })).toHaveCount(0);
  await expect(view.getByText("循着旧灯塔寻找失踪的人。", { exact: true })).toBeVisible();
  const fixedRecord = view.locator("[data-mcp-context]").first();
  await fixedRecord.click({button:"right"});
  await expect(view.getByRole("menu", {name:"雾港", exact:true})).toBeVisible();
  await page.keyboard.press("Escape");
  await view.getByText("循着旧灯塔寻找失踪的人。", {exact: true}).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  });
  const titleField = view.locator('.record-field[data-mcp-context-label="雾港"]').last();
  await titleField.focus(); await titleField.press("Shift+F10");
  await expect(view.getByRole("menuitem", {name:"让 AI 处理当前成果", exact:true})).toBeVisible();
  await expect(view.getByRole("menuitem", {name:"让 AI 处理选区", exact:true})).toHaveCount(0);
  await page.keyboard.press("Escape");
  await view.getByRole("button", { name: "小说", exact: true }).click();
  await expect(view.getByText("第一卷", { exact: true })).toBeVisible();
  await view.getByRole("button", { name: "阅读正文", exact: true }).click();
  await expect(view.getByText("潮水退后，石阶上留下了一盏灯。", { exact: true })).toBeVisible();
  await expect(view.getByRole("tablist", { name: "打开的文稿", exact: true })).toBeVisible();
  const tab = view.getByRole("tab", { name: "打开文稿 潮水", exact: true });
  await expect(tab).toBeVisible();
  await expect(tab.locator(".." )).toHaveAttribute("data-preview", "true");
  await tab.dblclick();
  await expect(tab.locator(".." )).toHaveAttribute("data-preview", "false");
  const manuscript = view.getByRole("article", {name:"固定正文", exact:true});
  await manuscript.click({button:"right"});
  await expect(view.getByRole("menu", {name:"固定正文", exact:true})).toBeVisible();
  await view.getByRole("menuitem", {name:"全选", exact:true}).click();
  await manuscript.focus();
  await manuscript.press("Shift+F10");
  await expect(view.getByRole("menu", {name:"固定正文", exact:true})).toBeVisible();
  await page.keyboard.press("Escape");
  await view.locator('.document-tab[data-active="true"] .document-tab-close').click();
  await expect(view.getByRole("tab", { name: "打开文稿 潮水", exact: true })).toHaveCount(0);
  await expect(view.locator("h2", { hasText: "作品资料" })).toBeVisible();
  const calls = await page.evaluate(() => window.harness.calls);
  const read = calls.find(c => c.name === "hetu_call_action" && c.arguments?.action === "hetu.documents.get");
  expect(read?.arguments?.input).toMatchObject({ document_id: "doc_first", revision_id: "rev_first", management_ref: management, work_ref: work });
});
test("drama episode with an empty author draft displays its fixed submitted reference", async ({ page }) => {
  const drama = { ...work, kind: "drama", object_id: "drama_fixture" };
  const reference = { kind: "submitted", title: "渡口参考稿", draft_ref: { draft_id: "draft_fixed", revision: 1 }, sha256: "b".repeat(64) };
  await page.addInitScript(value => Object.assign(window, value), {
    viewHtml: html, initialTask: { content: [], structuredContent: { status: "succeeded", data: { app: { route: "works", management_ref: management }, works: [{ title: "渡口剧本", work_ref: drama }] } } },
    testActions: { ...actions,
      "hetu.drama.projects.get": { episodes: [{ episode: { title: "渡口", episode_id: "depisode_fixed" } }] },
      "hetu.drama.episodes.get": { episode: { title: "渡口" }, manuscript: { author_has_content: false, author_state: "empty", references: [reference] } },
      "hetu.drafts.get": { draft: { revision: 1, content_sha256: reference.sha256 }, content: "INT. 渡口 - 夜\n\n江岚\n船还没来。" },
    },
  });
  await page.goto(origin); const view = page.frameLocator("iframe");
  await view.getByRole("button", { name: "打开作品 渡口剧本", exact: true }).click();
  await view.getByRole("button", { name: "剧本", exact: true }).click();
  await view.getByRole("button", { name: "阅读分集", exact: true }).click();
  await expect(view.getByText(/船还没来/)).toBeVisible();
  await expect(view.getByRole("article", { name: "最新提交参考稿", exact: true })).toBeVisible();
  expect((await page.evaluate(() => window.harness.calls)).every(call => !/save|adopt|finalize/.test(String(call.arguments?.action)))).toBe(true);
});
test("all work areas use existing reads and explicit AI drafts without exposing grants", async ({ page }) => {
  test.setTimeout(60_000); // 本例顺序覆盖15个工作面及真实消息桥接。
  const view = await open(page);
  await view.getByRole("button", { name: "打开作品 雾港", exact: true }).click();
  for (const name of ["大纲", "设定", "任务与参考稿", "资料", "图片与素材", "创作线索", "审核", "检查", "关联作品", "版本", "导入与交付", "操作方案", "插件", "本机设置", "模型渠道"]) {
    const labels: Record<string,string>={"大纲":"作品大纲","设定":"作品设定","任务与参考稿":"参考稿审核","资料":"资料与素材","图片与素材":"图片成果","创作线索":"素材与线索","审核":"审核记录","检查":"检查报告","版本":"文稿版本","导入与交付":"作品交付","操作方案":"管理方案"};
    const label=labels[name]??name;
    const target=view.getByRole("complementary").getByRole("button",{name:label,exact:true,includeHidden:true});
    const group=target.locator("xpath=ancestor::details[1]");if(await group.count() && await group.getAttribute("open")===null)await group.locator(":scope > summary").click();
    await target.click();
    await expect(view.locator(".workbench-content > h2")).toHaveText(name);
    await expect(view.getByRole("alert")).toHaveCount(0);
  }
  await view.getByRole("button", { name: "让 AI 处理", exact: true }).click();
  await view.getByLabel("创作目标").fill("检查连接状态，保留现有渠道。");
  await view.getByRole("button", { name: "放入当前草稿", exact: true }).click();
  await expect(view.getByText("请求已放入草稿，尚未发送。", { exact: true })).toBeVisible();
  const messages = await page.evaluate(() => window.harness.wireMessages);
  expect(messages).toHaveLength(1);
  expect(JSON.stringify(messages)).not.toContain("grant_id");
  expect(JSON.stringify(messages)).not.toContain(management.grant_id);
  expect(messages[0]).toMatchObject({ _meta: { "openai/message": { target: "active", send: false } } });
});
test("malicious deep links never become task or file access", async ({ page }) => {
  const view = await open(page, false, "/tasks/workspace/../../private?management_ref=secret");
  await expect(view.getByText(/尚未打开获权作品/)).toBeVisible();
  expect(await page.evaluate(() => window.harness.calls)).toEqual([]);
});
for (const width of [375, 1180]) test(`workbench at ${width}px keeps scoped navigation and content in bounds`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
  const view = await open(page);
  await view.getByRole("button", { name: "打开作品 雾港", exact: true }).click();
  expect(await view.locator("body").evaluate(node => node.scrollWidth <= innerWidth)).toBe(true);
  await mkdir("../../build/task-view/acceptance", { recursive: true });
  await page.screenshot({ path: `../../build/task-view/acceptance/workbench-${width}.png`, fullPage: true });
});

test("shared library filters intersect and clear without reading another work or pre-filling a request", async ({page}) => {
  const entries=[
    {title:"雾港",work_ref:work,status:"writing",author_name:"甲"},
    {title:"灯塔剧本",work_ref:{...work,kind:"drama",object_id:"drama_lighthouse"},status:"planning"},
    {title:"雾港视频",work_ref:{...work,kind:"video",object_id:"video_harbor"},status:"completed"},
  ];
  const view=await open(page,true,undefined,entries);
  await expect(view.locator(".library-works .work")).toHaveCount(3);
  await expect(view.locator(".agent-request")).toHaveCount(0);
  await view.getByLabel("搜索作品",{exact:true}).fill("雾港");
  await expect(view.locator(".library-works .work")).toHaveCount(2);
  await view.getByLabel("创作状态筛选").selectOption("writing");
  await expect(view.getByRole("button",{name:"打开作品 雾港",exact:true})).toBeVisible();
  await view.getByRole("button",{name:"剧本",exact:true}).click();
  await expect(view.getByText("没有匹配的作品",{exact:true})).toBeVisible();
  await view.getByRole("button",{name:"清除筛选",exact:true}).click();
  await expect(view.locator(".library-works .work")).toHaveCount(3);
  await view.getByRole("button",{name:"列表视图",exact:true}).click();
  await expect(view.locator(".library-works")).not.toHaveClass(/library-grid/);
  await view.getByRole("button",{name:"封面视图",exact:true}).click();
  await expect(view.locator(".library-works")).toHaveClass(/library-grid/);
  expect(await page.evaluate(()=>window.harness.calls)).toEqual([]);
});

test("MCP library objects expose the shared context menu", async ({page}) => {
  const view = await open(page);
  const workButton = view.getByRole("button", {name:"打开作品 雾港", exact:true});
  await workButton.click({button:"right"});
  await expect(view.getByRole("menu", {name:"雾港", exact:true})).toBeVisible();
  await view.getByRole("menuitem", {name:"作品资料", exact:true}).click();
  await expect(view.getByRole("heading", {name:"作品资料", exact:true})).toBeVisible();
});
for(const theme of ["light","dark"]) for(const width of [375,1440]) test(`shared library ${theme} ${width}px uses embedded artwork and readable controls`, async({page})=>{
  await page.setViewportSize({width,height:960});await page.emulateMedia({colorScheme:theme as "light"|"dark"});
  const view=await open(page);
  await expect(view.locator(".library-intro-art")).toHaveCount(0);
  await expect(view.getByRole("heading",{name:"创作库",exact:true})).toBeVisible();
  await expect.poll(()=>view.locator(".work-cover img").evaluate((node:HTMLImageElement)=>node.complete&&node.naturalWidth>0)).toBe(true);
  expect(await view.locator("body").evaluate(node=>node.scrollWidth<=innerWidth)).toBe(true);
  const metrics=await view.locator(".library-topbar").evaluate(node=>({height:node.getBoundingClientRect().height,border:getComputedStyle(node).borderBottomWidth,font:getComputedStyle(node.querySelector("strong")!).fontSize}));
  expect(metrics.height).toBe(52);expect(parseFloat(metrics.border)).toBeLessThanOrEqual(1);expect(parseFloat(metrics.font)).toBeGreaterThanOrEqual(12);
  await mkdir("../../build/task-view/acceptance",{recursive:true});await page.screenshot({path:`../../build/task-view/acceptance/shared-library-${theme}-${width}.png`,fullPage:true});
});

async function navigate(view: ReturnType<Page["frameLocator"]>, name:string) {
  const target=view.getByRole("complementary").getByRole("button",{name,exact:true,includeHidden:true});
  const group=target.locator("xpath=ancestor::details[1]");
  if(await group.count()&&await group.getAttribute("open")===null)await group.locator(":scope > summary").click();
  await target.click();
}
test("version history opens its exact managed manuscript and snapshot comparison",async({page})=>{
  const commit="c".repeat(40),snapshot="gitsnapshot_fixture";
  const view=await open(page,true,undefined,undefined,{
    "hetu.git.status":{initialized:true,changes:[]},
    "hetu.git.log":{commits:[{commit_id:commit,message:"港口初稿"}]},
    "hetu.git.read_version":{commit_id:commit,message:"港口初稿",files:[{title:"潮水",path:"documents/chapter.md"}],content:"旧稿原文"},
    "hetu.git.list_snapshots":{snapshots:[{snapshot_id:snapshot,message:"修订快照"}]},
    "hetu.git.get_snapshot":{snapshot:{snapshot_id:snapshot,message:"修订快照",selection:[{path:"documents/chapter.md"}]},snapshot_sha256:"d".repeat(64),is_current:true},
    "hetu.git.snapshot_diff":{before:"旧稿原文",after:"新稿原文"},
  });
  await view.getByRole("button",{name:"打开作品 雾港",exact:true}).click();
  await navigate(view,"文稿版本");
  await view.getByRole("button",{name:"查看版本历史",exact:true}).click();
  await view.getByRole("button",{name:"阅读历史版本",exact:true}).click();
  await view.getByRole("button",{name:"潮水",exact:true}).click();
  await expect(view.getByRole("article",{name:"固定正文"})).toHaveText("旧稿原文");
  await navigate(view,"文稿版本");await view.getByRole("button",{name:"查看待审快照",exact:true}).click();
  await view.getByRole("button",{name:"审阅文稿快照",exact:true}).click();
  await view.getByRole("button",{name:"比较快照文稿 1",exact:true}).click();
  await expect(view.getByText("新稿原文",{exact:true})).toBeVisible();
  const calls=await page.evaluate(()=>window.harness.calls);
  const read=calls.find(call=>call.arguments?.action==="hetu.git.read_version"&&(call.arguments?.input as any)?.path);
  expect(read?.arguments?.input).toMatchObject({commit_id:commit,path:"documents/chapter.md",management_ref:management,work_ref:work});
  expect(calls.some(call=>/execute|approve|save/.test(String(call.arguments?.action)))).toBe(false);
});
test("a stale submitted reference is rejected while the original task link remains exact",async({page})=>{
  const view=await open(page,true,undefined,undefined,{
    "hetu.resources.list":{resources:[{title:"参考稿",draft_ref:{draft_id:"draft_fixed",revision:2},sha256:"b".repeat(64)}]},
    "hetu.drafts.get":{draft:{revision:3,content_sha256:"c".repeat(64)},content:"不能误当成旧版的新稿"},
  });
  await view.getByRole("button",{name:"打开作品 雾港",exact:true}).click();await navigate(view,"资料与素材");
  await view.getByRole("button",{name:"阅读参考稿",exact:true}).click();
  await expect(view.getByRole("alert")).toContainText("固定版本不一致");
  await expect(view.getByText("不能误当成旧版的新稿",{exact:true})).toHaveCount(0);
});
test("video feedback keeps its fixed time base and prepares an explicit host request",async({page})=>{
  const video={...work,kind:"video",object_id:"video_fixture"},mediaRef={media_id:"vmedia_fixture",revision:1,sha256:"e".repeat(64)};
  const view=await open(page,true,undefined,[{title:"雾港影像",work_ref:video}],{
    "hetu.video.projects.get":{project:{title:"雾港影像"},episodes:[{episode:{title:"码头",video_episode_id:"vepisode_fixture"}}]},
    "hetu.video.media.list":{items:[{media_ref:mediaRef,media:{title:"码头预演"}}]},
    "hetu.video.media.get":{media_ref:mediaRef,media:{title:"码头预演",time_base:{numerator:1,denominator:1000},duration_ticks:5000,stream_index:0}},
  });
  await view.getByRole("button",{name:"打开作品 雾港影像",exact:true}).click();
  await navigate(view,"视频");await view.getByRole("button",{name:"查看分集成果",exact:true}).click();
  await view.getByRole("button",{name:"查看固定媒体",exact:true}).click();
  await view.getByRole("textbox",{name:"视频修改意见",exact:true}).fill("保留脚步声，延后切镜。");
  await view.getByLabel("指定片段",{exact:true}).check();await view.getByLabel("意见开始秒数").fill("1");await view.getByLabel("意见结束秒数").fill("6");
  await view.getByRole("button",{name:"交给 Agent 保存意见",exact:true}).click();await expect(view.getByRole("alert")).toContainText("固定视频时长内");
  await view.getByLabel("意见结束秒数").fill("2");await view.getByRole("button",{name:"交给 Agent 保存意见",exact:true}).click();
  await view.getByRole("button",{name:"放入当前草稿",exact:true}).click();
  await expect(view.getByText("请求已放入草稿，尚未发送。",{exact:true})).toBeVisible();
  const messages=await page.evaluate(()=>window.harness.wireMessages);expect(messages).toHaveLength(1);
  const text=JSON.stringify(messages);expect(text).toContain("start_tick");expect(text).toContain("1000");expect(text).toContain(mediaRef.sha256);expect(text).not.toContain(management.grant_id);
  expect((await page.evaluate(()=>window.harness.calls)).some(call=>call.arguments?.action==="hetu.video.feedback.save")).toBe(false);
});
