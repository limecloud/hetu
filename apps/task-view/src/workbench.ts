import { createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { LibraryHeader, LibraryNavigation, LibraryContent, NavigationGroup, WorkspaceHeader, DocumentTabs, WorkCoverPreview, Icon, ContextMenuProvider, type IconName, type LibraryWork, type DocumentTab, type ContextMenuItem } from "@hetu/workbench-ui";
import { libraryAssets } from "./workbench/assets.ts";
import { createAppHost } from "./host/bridge.ts";
import { mountTaskReview } from "./task-review.ts";
import { WorkbenchGateway, result, object, type RecordValue, type WorkRef } from "./workbench/gateway.ts";
import { sections, localSections, sectionById, sectionsInOrder, localSectionsInOrder, WORK_CONTENT_SECTION_ID, WORK_PROFILE_SECTION_ID, LOCAL_PLUGINS_SECTION_ID, LOCAL_SETTINGS_SECTION_ID, type Section, type DetailLink } from "./workbench/domains.ts";
import { element, button, renderData } from "./workbench/render.ts";
import { readMedia } from "./workbench/media.ts";
import { relatedViews } from "./workbench/navigation.ts";
import {VideoFeedback} from "./workbench/video-feedback.tsx";
import {ManuscriptContextSurface} from "./workbench/manuscript-context.tsx";
import {copyText} from "./workbench/clipboard.ts";
import {ContextMenuBridge} from "./workbench/context-bridge.tsx";

const host = createAppHost("Hetu Luoshu workbench");
const gateway = new WorkbenchGateway(host);
const root = document.getElementById("app")!;
const reactRoots = new Map<HTMLElement,Root>();
let libraryKind = "all", navigationVisible = innerWidth > 760;
function unmountReact() { for (const view of reactRoots.values()) view.unmount(); reactRoots.clear(); }
function mountReact(parent: HTMLElement, view: ReturnType<typeof createElement>) { const target=reactRoots.get(parent)??createRoot(parent); reactRoots.set(parent,target); flushSync(() => target.render(view)); }
let connected = false, disposed = false, epoch = 0, busy = false;
let route: Section | undefined, work: WorkRef | undefined, works: RecordValue[] = [];
type Reading = { action: string; input: RecordValue; data: RecordValue; view?: RecordValue; expected?: DetailLink["expected"] };
let current: Reading | undefined;
let history: Reading[] = [];
type WorkbenchTab = DocumentTab & { action: string; input: RecordValue };
let documentTabs: WorkbenchTab[] = [];
let taskView: ReturnType<typeof mountTaskReview> | undefined;
let mediaUrl: string | undefined;
let feedbackDirty=false;
let error = "", notice = "", initialBinding: string | undefined, bindingConsumed = false;
let libraryMode = false, libraryError = "";
let content = element("section"), status = element("p");
let request: { intent: string; references: RecordValue; text: string; delivery: "ready" | "pending" | "accepted" | "drafted" | "unknown" | "rejected" } | undefined;

function live(ticket: number) { return !disposed && ticket === epoch; }
function fail(value: unknown) { error = value instanceof Error ? value.message : String(value); }
function canLeave() {
  if(feedbackDirty){notice="请先交接或清除当前视频意见，再切换成果。";updateStatus();return false;}
  if (taskView && !taskView.canLeave()) { notice = "请先保存当前选择或意见，并查询未确认操作，再切换页面。"; updateStatus(); return false; }
  if (request?.delivery === "pending" || request?.delivery === "unknown") { notice = "消息结果尚未确认，请先核对当前会话。"; updateStatus(); return false; }
  if (request?.delivery === "ready" && request.text.trim()) { notice = "当前目标尚未交接，请先发送、放入草稿或明确放弃。"; updateStatus(); return false; }
  return true;
}
function releaseMedia() { if (mediaUrl) URL.revokeObjectURL(mediaUrl); mediaUrl = undefined; }
function leave() { feedbackDirty=false;releaseMedia(); taskView?.dispose(); taskView = undefined; current = undefined; history = []; request = undefined; error = ""; notice = ""; }
function tabTitle(action: string, data: RecordValue) {
  const value = object(data.document ?? data.episode ?? data.draft ?? data.revision);
  return String(value.title ?? object(data.manuscript).title ?? (action === "hetu.documents.get" ? "正文" : action === "hetu.drama.episodes.get" ? "分集" : "参考稿"));
}
function readingId(reading: {action?: string; input?: RecordValue; data: RecordValue}) {
  const value = object(reading.data.document ?? reading.data.episode ?? reading.data.draft ?? reading.data.revision);
  return String(value.document_id ?? value.episode_id ?? value.draft_id ?? value.revision_id
    ?? reading.input?.document_id ?? reading.input?.episode_id ?? reading.input?.draft_id ?? reading.input?.commit_id ?? "");
}
function registerDocumentTab(action: string, input: RecordValue, data: RecordValue) {
  if (!["hetu.documents.get", "hetu.drama.episodes.get", "hetu.drafts.get", "hetu.working_copies.get", "hetu.git.read_version"].includes(action)) return;
  const id = readingId({action, input, data});
  if (!id) return;
  const next = {id, title: tabTitle(action, data), action, input: {...input}, preview: true};
  const index = documentTabs.findIndex(tab => tab.id === id);
  if (index >= 0) documentTabs = documentTabs.map((tab, position) => position === index ? {...tab, ...next, preview: tab.preview === false ? false : next.preview} : tab);
  else {
    const preview = documentTabs.findIndex(tab => tab.preview);
    documentTabs = preview >= 0 ? documentTabs.map((tab, position) => position === preview ? next : tab) : [...documentTabs, next];
  }
}
function pinDocumentTab(id: string) {
  documentTabs = documentTabs.map(tab => tab.id === id ? {...tab, preview: false} : tab);
  render();
  if (route) showCurrent();
}
function closeDocumentTab(id: string) {
  if (!canLeave()) return;
  const index = documentTabs.findIndex(tab => tab.id === id);
  if (index < 0) return;
  const remaining = documentTabs.filter(tab => tab.id !== id);
  documentTabs = remaining;
  const currentId = current && readingId(current);
  if (current && currentId === id) {
    const next = remaining[index] ?? remaining[index - 1];
    if (next) void load(next.action, next.input, undefined, false);
    else {
      const profile = sectionById(WORK_PROFILE_SECTION_ID);
      if (profile) void showSection(profile);
      else { current = undefined; render(); if (route) showCurrent(); }
    }
  } else { render(); if (route) showCurrent(); }
}
function updateStatus() { const failure=error&&!(!route&&libraryError);status.textContent=failure?error:notice;status.setAttribute("role",failure?"alert":"status"); }

function localPage(id: string) { const section=sectionById(id, localSections); if(section) void showSection(section); }
function openExisting() { prepare("打开已有小说、剧本或视频，确认作者要继续的确切作品并核验当前客户端的精确授权，保留已有任务和成果", {}); }
function newWork(kind: string, title: string) { prepare(`从当前想法筹备${title}，先讨论方向并保留作者选择权`, {kind}); }
function render() {
  unmountReact(); root.replaceChildren(); root.setAttribute("aria-busy", String(busy));
  const chrome=element("div",undefined,"workbench-chrome"); root.append(chrome);
  const toggleNavigation=()=>{navigationVisible=!navigationVisible;root.querySelector(".layout")?.classList.toggle("navigation-hidden",!navigationVisible);};
  const title=String(works.find(item=>JSON.stringify(item.work_ref)===JSON.stringify(work))?.title??"当前作品");
  const header = work&&route ? createElement(WorkspaceHeader,{title,kind:work.kind,onNavigation:toggleNavigation,children:createElement(Fragment,null,createElement(DocumentTabs,{tabs:documentTabs,activeId:current ? readingId(current) : undefined,onSelect:id=>{if(!canLeave())return;const tab=documentTabs.find(item=>item.id===id);if(tab)void load(tab.action,tab.input,undefined,false);},onPin:pinDocumentTab,onClose:closeDocumentTab}),createElement("div",{className:"topbar-actions"},createElement("button",{className:"ai-button",onClick:()=>prepare(route!.intent,references())},"让 AI 处理"),createElement("button",{onClick:()=>localPage(LOCAL_SETTINGS_SECTION_ID)},"本机设置")))}) : createElement(LibraryHeader,{assets:libraryAssets,busy,onOpen:openExisting,onCreate:newWork,onSettings:()=>localPage(LOCAL_SETTINGS_SECTION_ID),onPlugins:()=>localPage(LOCAL_PLUGINS_SECTION_ID),onToggleNavigation:toggleNavigation});
  mountReact(chrome, createElement(Fragment, null, header, createElement(ContextMenuBridge, {onPrepare:selected=>prepare(selected ? `处理当前固定成果中的选区：${selected}` : route?.intent ?? "处理当前固定成果", {...references(), ...(selected ? {selection_text:selected} : {})}), onError:error=>{notice=error.message;updateStatus();}})));
  const layout = element("div", undefined, "layout " + (work && route ? "workspace-layout" : "library-layout") + (navigationVisible ? "" : " navigation-hidden"));
  const nav = element("aside",undefined,"project-navigation"); nav.setAttribute("aria-label", route && work ? "项目导航" : "创作库导航");
  if (!route) renderLibraryNavigation(nav);
  else {
    const back=button("返回创作库",()=>showHome());back.className="back-library";nav.append(back);
    const labels:Record<string,[string,IconName]>={profile:["作品资料","file"],content:[work?.kind==="novel"?"小说":work?.kind==="drama"?"剧本":"视频",work?.kind==="video"?"film":work?.kind==="novel"?"book":"file"],tasks:["参考稿审核","shield"],links:["关联作品","link"],outline:["作品大纲","file"],canon:["作品设定","layers"],assets:["图片成果","image"],resources:["资料与素材","file"],cues:["素材与线索","image"],versions:["文稿版本","branch"],delivery:["作品交付","export"],operations:["管理方案","shield"],reviews:["审核记录","shield"],reports:["检查报告","check"]};
    const item=(section:Section)=>createElement("button",{key:section.id,type:"button",disabled:busy||(!work&&sections.includes(section)),className:route?.id===section.id?"selected":"","aria-current":route?.id===section.id?"page":undefined,onClick:()=>void showSection(section)},createElement(Icon,{name:labels[section.id]?.[1]??"settings"}),createElement("span",null,labels[section.id]?.[0]??section.title));
    const list=element("div",undefined,"navigation-scroll");nav.append(list);
    const groups=[["创作资料",["outline","canon","assets","resources","cues"]],["协作与审核",["tasks","links","reviews","operations"]],["版本与交付",["versions","delivery"]],["检查工具",["reports"]]] as const;
    // 直接工作区连接也拥有当前作品的阅读入口；management_ref 只决定需要管理授权的附加动作。
    const entryIds=[WORK_PROFILE_SECTION_ID];
    const primaryContent=sectionById(WORK_CONTENT_SECTION_ID);
    mountReact(list,createElement("div",null,...(work?sectionsInOrder(entryIds).map(item):[]),...(work?groups.map(([title,ids])=>createElement(NavigationGroup,{key:title,title,active:!!route&&ids.some(id=>id===route!.id),children:sectionsInOrder(ids).map(item)})):[]),...(work&&primaryContent?[item(primaryContent)]:[]),createElement(NavigationGroup,{title:"本机与扩展",active:localSections.some(section=>section.id===route?.id),children:localSectionsInOrder().map(item)})));
  }
  if(work&&route){const currentWork=element("div",undefined,"current-work");nav.append(currentWork);mountReact(currentWork,createElement("div",null,createElement(WorkCoverPreview,{work,title,compact:true,defaultCovers:libraryAssets.covers}),createElement("strong",null,title)));}
  if(innerWidth<=760 && navigationVisible) { const close=button("关闭导航",()=>{navigationVisible=false;root.querySelector(".layout")?.classList.add("navigation-hidden");});close.className="navigation-close";nav.append(close); }
  content=element("main",undefined,"page-main workbench-content");
  layout.append(nav,content);root.append(layout);
  status=element("p",undefined,"status workbench-status");root.append(status);updateStatus();
  if(request)renderRequest();
}
function setLibraryKind(id: string) {
  if(!canLeave())return;
  libraryKind=id;
  if(innerWidth<=760) {navigationVisible=false;root.querySelector(".layout")?.classList.add("navigation-hidden");}
  const nav=root.querySelector<HTMLElement>(".project-navigation");if(nav)renderLibraryNavigation(nav);
  renderHome();
}
function renderLibraryNavigation(nav: HTMLElement) {
  mountReact(nav,createElement(LibraryNavigation,{kind:libraryKind,active:"library",busy,onKind:setLibraryKind,onPlugins:()=>localPage(LOCAL_PLUGINS_SECTION_ID)}));
}
async function selectLibraryWork(item: LibraryWork, target?: string) {
  if (!canLeave()) return;
  if (libraryMode && !gateway.selectLibraryWork(item.work_ref)) {
    work = undefined;
    prepare(`打开已有${({novel:"小说",drama:"剧本",video:"视频"})[item.work_ref.kind]}《${item.title}》。目录已登记，先核对本客户端对此确切作品的授权；尚未授权时引导作者在可信作品接入页授予此作品范围，保留原任务与成果，不重新创建或导入`, {work_ref:item.work_ref});
    notice = "此作品尚未授权给当前 Agent，已准备精确作品接入请求。";
    updateStatus();
    return;
  }
  work = item.work_ref;
  gateway.work = work;
  const section = target ? sectionById(target) : sectionById(WORK_PROFILE_SECTION_ID);
  if (section) await showSection(section);
}
function renderHome() {
  mountReact(content,createElement(ContextMenuProvider,null,createElement(LibraryContent,{works:works as unknown as LibraryWork[],assets:libraryAssets,kind:libraryKind,busy,loading:!connected,error:libraryError,appearance:document.documentElement.dataset.theme??"system",initialListMode:false,emptyTitle:libraryMode?"还没有登记的作品":"尚未打开获权作品",emptyMessage:"打开已有作品，或让当前 Agent 从一个想法开始。",onKind:setLibraryKind,onOpen:openExisting,onCreate:newWork,onSelect:(item:LibraryWork)=>{void selectLibraryWork(item);},contextItems:(item:LibraryWork):ContextMenuItem[]=>[
    {id:"open",label:"打开",disabled:busy||!!item.unavailable,action:()=>selectLibraryWork(item)},
    {id:"profile",label:"作品资料",disabled:busy||!!item.unavailable,action:()=>selectLibraryWork(item,"profile")},
    {id:"copy-title",label:"复制名称",action:async()=>{await copyText(item.title);}},
    {id:"review",separator:true},
    {id:"history",label:"版本历史",disabled:busy||!!item.unavailable||item.work_ref.kind==="video",action:()=>selectLibraryWork(item,"versions")},
    {id:"export",label:"作品交付",disabled:busy||!!item.unavailable||item.work_ref.kind==="video",action:()=>selectLibraryWork(item,"delivery")},
    {id:"ai",label:"让 AI 处理此作品",action:()=>{prepare(`整理作品《${item.title}》的资料、正文与已有成果，保留作者选择权`,{work_ref:item.work_ref});}},
  ],onContextError:error=>{notice=error.message;updateStatus();},onRefresh:()=>{
    if(!canLeave())return;
    if(!libraryMode&&!gateway.management){openExisting();return;}
    busy=true;libraryError="";renderHome();
    void readWorks().catch(value=>{libraryError=value instanceof Error?value.message:String(value);}).finally(()=>{busy=false;renderHome();});
  }})));
}
function showHome() {
  if (!canLeave()) return;
  epoch++; leave(); documentTabs=[]; route=undefined;render();renderHome();
}
async function readWorks() {
  const rows: RecordValue[]=[];let cursor: string|undefined;
  do {
    const data=await gateway.read(libraryMode?"hetu.collaboration.library":"hetu.works.list",{limit:20,...(!libraryMode?{include_archived:true}:{}),...(cursor?{cursor}:{})});
    rows.push(...(Array.isArray(data.works)?data.works.map(object):[]));
    cursor=typeof data.next_cursor==="string"?data.next_cursor:undefined;
  }while(cursor);
  works=libraryMode?gateway.useLibrary(rows):rows;
}
function pageActions() {
  const actions = element("div", undefined, "actions");
  if (route && !work) actions.append(button("让 AI 处理", () => prepare(route!.intent, references())));
  if (current) {
    const source = current;
    actions.append(button("刷新", () => load(source.action, source.input, source.view, false, source.expected)));
  }
  if (history.length) actions.append(button("返回上一项", async () => {
    const previous = history.pop()!; await load(previous.action, previous.input, previous.view, false, previous.expected);
  }));
  return actions;
}
function references(): RecordValue { return current ? { action: current.action, input: current.input, ...fixedReferences(current.data) } : {}; }
function fixedReferences(data: RecordValue) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => /(^sha256$|revision$|_ref$)/.test(key) && !/management|grant/.test(key)));
}
async function showSection(section: Section) {
  if (busy || !canLeave()) return;
  epoch++; leave(); route = section; render();
  const read = section.read(work);
  if (!read) {
    content.append(element("h2", section.title), element("p", "由 Agent 读取已有依据并准备方案。", "empty"), pageActions()); return;
  }
  await load(read.action, read.input ?? {});
}
async function load(action: string, input: RecordValue = {}, view?: RecordValue, navigate = true, expected?: DetailLink["expected"]) {
  if (busy || !connected || disposed) return;
  if (navigate && current) history.push(current);
  const ticket = ++epoch; busy = true; error = ""; notice = "";
  releaseMedia();
  render(); content.append(element("p", "正在读取…", "empty"));
  try {
    const data = await gateway.read(action, input, view);
    if (!live(ticket)) return;
    const fixedRecord = object(action === "hetu.working_copies.get" ? data.revision : data.draft);
    if(expected && ((expected.revision !== undefined && fixedRecord.revision !== expected.revision) || (expected.sha256 !== undefined && (fixedRecord.content_sha256 ?? fixedRecord.sha256) !== expected.sha256))) throw new Error("成果修订或摘要与所选固定版本不一致，请重新读取目录。");
    if(action === "hetu.working_copies.get" && typeof fixedRecord.content === "string") data.content = fixedRecord.content;
    if (action === "hetu.drama.episodes.get" && !view) {
      const manuscript = object(data.manuscript);
      const reference = (Array.isArray(manuscript.references) ? manuscript.references.map(object) : []).find(item => item.kind === "submitted") ?? (Array.isArray(manuscript.references) ? manuscript.references.map(object)[0] : undefined);
      if (manuscript.author_has_content === false && reference) {
        const submitted=reference.kind==="submitted", fixed=object(submitted?reference.draft_ref:reference.working_copy_ref);
        const draft = await gateway.read(submitted?"hetu.drafts.get":"hetu.working_copies.get",submitted?{draft_id:fixed.draft_id}:{task_ref:reference.task_ref,working_copy_ref:fixed});
        if(!live(ticket))return;
        const record=object(submitted?draft.draft:draft.revision);
        if((submitted&&record.revision!==fixed.revision)||(record.content_sha256??record.sha256)!==reference.sha256)throw new Error("参考稿已变化，请刷新分集后重新读取。");
        const text=submitted?draft.content:record.content;if(typeof text==="string")data.reference_content=text;
      }
    }
    current = { action, input, data, view, expected };
    registerDocumentTab(action, input, data);
  } catch (value) { if (live(ticket)) { current = undefined; fail(value); } }
  finally { if (live(ticket)) { busy = false; render(); showCurrent(); } }
}
function showCurrent() {
  // 作品资料页与桌面工作台共享同一个可定位的语义表面，便于
  // MCP App 宿主和无障碍工具沿同一条交互路径读取当前作品。
  const surface = route?.id === WORK_PROFILE_SECTION_ID ? element("section", undefined, "work-profile") : content;
  if (surface !== content) { surface.setAttribute("aria-label", "当前作品资料"); content.append(surface); }
  const append = (node: Node) => surface.append(node);
  append(element("h2", route?.title ?? "固定成果"));
  append(pageActions());
  if (!current) { append(element("p", error ? "读取未完成，可刷新或让 Agent 检查当前授权。" : "暂无成果", "empty")); return; }
  const source = current;
  const prose = source.data.reference_content ?? source.data.content;
  if(typeof prose === "string" && ["hetu.documents.get","hetu.drama.episodes.get","hetu.drafts.get","hetu.working_copies.get","hetu.git.read_version"].includes(source.action)) {
    const stage=element("div",undefined,"manuscript-stage"),paper=element("section",undefined,"manuscript-paper");
    const title=element("div",undefined,"manuscript-title");title.append(element("h1",String(object(source.data.document).title??object(source.data.episode).title??object(source.data.draft).title??"文稿")),element("span",source.data.reference_content?"参考稿":"只读"));
    paper.append(title);
    const text=element("div",undefined,"manuscript-scroll");paper.append(text);
    mountReact(text,createElement(ManuscriptContextSurface,{text:prose,title:String(object(source.data.document).title??object(source.data.episode).title??object(source.data.draft).title??"文稿"),novel:work?.kind==="novel",label:source.data.reference_content?"最新提交参考稿":"固定正文",onPrepare:selected=>prepare(selected?`处理当前固定稿件中的选区：${selected}`:route!.intent,{...references(),...(selected?{selection_text:selected}: {})}),onError:error=>{notice=error.message;updateStatus();}}));
    const footer=element("footer",undefined,"manuscript-footer");footer.append(element("span",String(object(source.data.revision).source_format??object(source.data.draft).source_format??(work?.kind==="novel"?"Markdown":"Fountain"))),element("span",`${Array.from(prose).filter(char=>/\p{Script=Han}/u.test(char)).length} 字`));paper.append(footer);stage.append(paper);append(stage);
    const details=element("details");details.append(element("summary","稿件版本与固定依据"),renderData(Object.fromEntries(Object.entries(source.data).filter(([key])=>key!=="content"&&key!=="reference_content")),link=>{void openDetail(link);}));append(details);
  } else append(renderData(source.data, link => { void openDetail(link); }));
  const related=relatedViews(source.action,source.data,source.input,work);
  if(related.length){const links=element("div",undefined,"actions");for(const link of related)links.append(button(link.label,()=>openDetail(link)));append(links);}

  if (source.action === "hetu.plugins.capabilities" && typeof source.data.capabilities_sha256 === "string") {
    const declared = [...(Array.isArray(source.data.actions) ? source.data.actions : []), ...(Array.isArray(source.data.data_actions) ? source.data.data_actions : [])].map(object);
    for (const capability of declared) {
      const schema = object(capability.input_schema), required = Array.isArray(schema.required) ? schema.required : [];
      if (typeof (capability.id ?? capability.name) !== "string") continue;
      const title=String(capability.title??capability.purpose??"专业创作功能");
      if(capability.effect!=="read"||required.length){append(button(`让 AI ${title}`,()=>prepare(`使用当前专业插件${title}，先读取固定对象与已有成果，按此能力的实际Schema准备完整操作`,{plugin_id:source.data.plugin_id,package_sha256:source.data.package_sha256??source.input.package_sha256,capabilities_sha256:source.data.capabilities_sha256,action:capability.id??capability.name})));continue;}
      append(button(title, () => load("hetu.plugins.invoke", {
        plugin_id: source.data.plugin_id, package_sha256: source.data.package_sha256 ?? source.input.package_sha256,
        capabilities_sha256: source.data.capabilities_sha256, action: capability.id ?? capability.name, arguments: {},
      }, {})));
    }
  }
  const asset = object(source.data.asset), media = object(source.data.media);
  const assetRef = object(media.asset_ref ?? (asset.asset_id && source.data.sha256 ? { asset_id: asset.asset_id, revision: asset.revision, sha256: source.data.sha256 } : undefined));
  if (asset.blob && assetRef.asset_id) {
    const preview = element("div", undefined, "media-preview");
    preview.append(button("预览媒体", async () => {
      const ticket = epoch; error = ""; preview.replaceChildren(element("p", "正在核验固定媒体…"));
      try {
        const value = await readMedia(gateway, asset, assetRef, () => live(ticket));
        if (!live(ticket)) { URL.revokeObjectURL(value.url); return; }
        releaseMedia(); mediaUrl = value.url;
        if (value.mime.startsWith("image/")) { const image = element("img"); image.alt = String(asset.title ?? media.title ?? "固定图片"); image.src = value.url; image.className = "cover"; preview.replaceChildren(image); }
        else { const player = element(value.mime.startsWith("video/") ? "video" : "audio"); player.src = value.url; player.controls = true; player.preload = "metadata"; preview.replaceChildren(player); }
      } catch (value) { if (live(ticket)) { fail(value); preview.replaceChildren(); updateStatus(); } }
    })); append(preview);
  }
  if(source.action==="hetu.video.media.get"&&source.data.media_ref) {
    const panel=element("div");append(panel);
    mountReact(panel,createElement(VideoFeedback,{media,mediaRef:object(source.data.media_ref),onDirty:(value:boolean)=>{feedbackDirty=value;},onPrepare:(intent:string,fixed:RecordValue)=>{feedbackDirty=false;prepare(intent,fixed);if(request){request.text=intent;renderRequest();}}}));
  }
  if (typeof source.data.next_cursor === "string") append(button("下一页", () => load(source.action, { ...source.input, cursor: source.data.next_cursor })));
  if (source.data.response) {
    const response = object(source.data.response), recovery = object(response.read), patch = object(object(response.read).input_patch);
    const readInput = object(recovery.input);
    const view = object(readInput.view ?? patch.view);
    const fields = Array.isArray(source.data.result_fields) ? source.data.result_fields.map(object) : [];
    append(element("p", "当前为摘要，请按需读取固定内容。", "muted"));
    for (const field of fields) if (typeof field.result_path === "string") append(button(`读取${fieldTitle(String(field.name))}`, () => load(source.action, source.input, { ...view, result_path: field.result_path, max_bytes: 12000 })));
  }
  const projection = object(source.data.view), page = object(projection.page);
  if (projection.value !== undefined) append(renderData(projection.value, link => { void openDetail(link); }));
  if (projection.items !== undefined) append(renderData(projection.items, link => { void openDetail(link); }));
  for (const field of Array.isArray(projection.fields) ? projection.fields.map(object) : []) append(button(`读取${fieldTitle(String(field.name))}`, () => load(source.action, source.input, { result_path: field.result_path, expected_result_sha256: projection.source_result_sha256, max_bytes: 12000 })));
  if (typeof projection.next_path === "string") append(button("展开固定内容", () => load(source.action, source.input, { result_path: projection.next_path, expected_result_sha256: projection.source_result_sha256, max_bytes: 12000 })));
  if (projection.page) append(renderData(page.text ?? page.items ?? page, link => { void openDetail(link); }));
  if (typeof projection.next_offset === "number") append(button("继续读取固定内容", () => load(source.action, source.input, { result_path: projection.result_path, expected_result_sha256: projection.source_result_sha256, offset: projection.next_offset, max_bytes: 12000 })));

}
function fieldTitle(key: string) { return ({ content: "正文", novel: "卷章", project: "项目", blueprint: "设定", actions: "能力", tasks: "任务", documents: "正文目录", resources: "资料", works: "作品" } as Record<string, string>)[key] ?? "内容"; }
async function openDetail(link: DetailLink) {
  if (!canLeave()) return;
  if (link.task) {
    const ticket = ++epoch; busy = true;
    try {
      const response = await gateway.openTask(link.task);
      if (!live(ticket)) return;
      busy = false; showTask(response);
    } catch (value) { if (live(ticket)) { busy = false; fail(value); updateStatus(); } }
  } else if (link.action) await load(link.action, link.input, undefined, true, link.expected);
}
function showTask(response: Parameters<ReturnType<typeof mountTaskReview>["receive"]>[0]) {
  if (!canLeave()) return;
  leave(); render(); content.append(element("h2", "任务与参考稿"));
  const pane = element("div",undefined,"task-review"); content.append(pane);
  taskView = mountTaskReview(host, pane); taskView.receive(response); if (connected) taskView.ready();
  host.onteardown = teardown;
}

function prepare(intent: string, references_: RecordValue) {
  if(request && !canLeave())return;
  request = { intent, references: references_, text: "", delivery: "ready" }; renderRequest();
}
function renderRequest() {
  if (!request) return;
  const value = request;
  root.querySelector(".agent-request")?.remove();
  const panel = element("section", undefined, "agent-request"); panel.setAttribute("aria-label", "让 AI 处理");
  panel.append(element("h2", "让 AI 处理"));
  const field = element("textarea"); field.setAttribute("aria-label", "创作目标"); field.placeholder = value.intent; field.value = value.text; field.maxLength = 4000;
  field.disabled = value.delivery !== "ready"; field.oninput = () => { value.text = field.value; };
  panel.append(field);
  const prompt = () => gateway.handoff(value.text.trim() || value.intent, value.references);
  const actions = element("div", undefined, "actions");
  const copy = button("复制请求", async () => {
    const preview = element("textarea"); preview.readOnly = true; preview.value = prompt(); preview.setAttribute("aria-label", "继续请求");
    try { await navigator.clipboard.writeText(preview.value); notice = "请求已复制，尚未发送。"; }
    catch { panel.append(preview); preview.focus(); preview.select(); notice = "请选择请求内容复制。"; }
    updateStatus();
  }); actions.append(copy);
  const send = async (target: "active" | "new", submit: boolean) => {
    if (value.delivery !== "ready" || !connected) return;
    value.delivery = "pending"; renderRequest();
    try {
      // 先回读精确作品；发送过程与作品读取不能假装原子完成。
      if (work) await gateway.read("hetu.works.get", { work_ref: work });
      if (disposed || request !== value) return;
      const response = await host.sendText(prompt(), target, submit);
      if (disposed || request !== value) return;
      value.delivery = response.isError ? "rejected" : submit ? "accepted" : "drafted";
    } catch { if (!disposed && request === value) value.delivery = "unknown"; }
    finally { if (!disposed && request === value) renderRequest(); }
  };
  if (host.features().messages) actions.append(button("发送给当前 Agent", () => send("active", true)));
  if (host.features().drafts) actions.append(button("放入当前草稿", () => send("active", false)), button("在新对话中准备", () => send("new", false)));
  for (const node of actions.querySelectorAll("button")) if (node !== copy) node.disabled = value.delivery !== "ready";
  panel.append(actions);
  if (value.delivery === "ready") panel.append(button("放弃未发送请求", () => { request = undefined; panel.remove(); }));
  if(value.delivery === "unknown")panel.append(button("已核对宿主，结束此次交接",()=>{request=undefined;panel.remove();notice="已结束此次交接，保留原作品与成果；未重复发送。";updateStatus();}));
  const states = { ready: "先核对目标，再交给 Agent。", pending: "正在核对并交接…", accepted: "宿主已受理，等待实际成果。", drafted: "请求已放入草稿，尚未发送。", rejected: "宿主未接收请求，可复制后继续。", unknown: "结果尚未确认，请先查看当前会话，不自动重发。" };
  panel.append(element("p", states[value.delivery], "muted")); root.append(panel);
}

async function receive(response: Parameters<ReturnType<typeof mountTaskReview>["receive"]>[0]) {
  try {
    if (bindingConsumed) return;
    if (work || route) return;
    const envelope = result(response), data = envelope.data ?? {}, app = object(data.app);
    // 只有入口工具的结果可以改变面板绑定；工作区内部的 `hetu.works.get` 等读取
    // 也会经由同一宿主回调返回，不能把它们误当成新的入口。
    // 旧版及测试宿主可能只返回 App 路由而不带 action；有 action 时才做
    // 严格的入口动作校验。这样既兼容标准 MCP 回执，也不会接管工作区内部动作。
    const sourceAction = (envelope as any).action;
    if (sourceAction !== undefined && !["hetu.works.list", "hetu.collaboration.library"].includes(String(sourceAction))) return;
    if (typeof app.route !== "string") return;
    // 初始入口消费完成后，后续工具调用由 gateway 直接处理，避免宿主通知再次重置当前工作面。
    // AppBridge 仍可能把 callServerTool 的回执送到 ontoolresult；保持一个空处理器，
    // 而不是清空属性，避免宿主把工作区内部读取再次交给 receive。
    bindingConsumed = true;
    host.ontoolresult = () => {};
    if (!canLeave()) return;
    if (app.route === "task") { showTask(response); return; }
    if(app.route === "library") {
      if(initialBinding && initialBinding!=="library")throw new Error("请另开面板查看创作库，当前固定作品保持原位。");
      initialBinding="library";libraryMode=true;libraryError="";
      works=gateway.useLibrary(Array.isArray(data.works)?data.works.map(object):[]);
      if(data.next_cursor)await readWorks();
      gateway.management=undefined;gateway.work=undefined;work=undefined;
    }
    if (app.route === "works") {
      const reference = object(app.management_ref), binding = JSON.stringify(reference);
      if (initialBinding && binding !== initialBinding) throw new Error("请另开面板查看其他作品，当前未保存内容保持原位。");
      initialBinding = binding; gateway.management = reference;
      works = Array.isArray(data.works) ? data.works.map(object) : [];
    }
    showHome();
  } catch (value) { fail(value); if(!route){libraryError=error;libraryMode=initialBinding==="library"||!initialBinding;renderHome();} updateStatus(); }
}
async function deepLink(context: Parameters<typeof host.taskLink>[0]) {
  const locator = host.taskLink(context);
  if (!locator || !canLeave()) return;
  await openDetail({ label: "审阅任务", task: locator });
}
async function teardown() {
  disposed = true; epoch++; connected = false; taskView?.dispose(); taskView = undefined;
  releaseMedia();
  gateway.management = undefined; gateway.work = undefined; gateway.useLibrary([]); works = []; work = undefined; current = undefined; history = []; request = undefined;
  unmountReact(); root.replaceChildren(element("p", "面板连接已结束。已保存成果保留在原作品。", "empty")); return {};
}
function bindEvents() {
  if (!bindingConsumed) host.ontoolresult = response => { void receive(response); };
  host.onhostcontextchanged = context => {
    if (context.theme) {document.documentElement.dataset.theme=context.theme;if(!route&&connected)renderHome();}
    void deepLink(context);
  };
  host.onteardown = teardown;
}
bindEvents(); render(); renderHome();
if (window.parent === window) { error = "请在支持 MCP Apps 的客户端打开河图。"; updateStatus(); }
else void host.connect().then(async () => {
  if (disposed) return;
  connected = true;
  const context = host.getHostContext();
  if (context?.theme) document.documentElement.dataset.theme = context.theme;
  if (taskView) taskView.ready(); else if (!current) showHome();
  await deepLink(context);
}).catch(value => { fail(value); updateStatus(); });
