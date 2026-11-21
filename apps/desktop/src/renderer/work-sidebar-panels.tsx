import React, {useEffect, useRef, useState} from "react";
import type {WorkRef} from "@hetu/plugin-sdk";
import {Icon, IconButton} from "@hetu/workbench-ui";
import {desktop, data} from "./bridge.ts";
import {ArtworkDetail} from "./artwork-detail.tsx";
import {readArtworkPage, mergeArtwork, artworkKey, artworkPreview, type Artwork} from "./artwork-model.ts";
import type {ResourceSelection} from "./resource-reading.tsx";
import {useObjectContextMenu} from "./text-context-menus.tsx";
import {manuscriptVisibleText} from "@hetu/workbench-ui/manuscript-format";

/** 仅在首次打开或明确刷新时读取；切换侧栏不切换正文和作者句柄。 */
export function SidebarTasks({work, active, onOpen, onAI, notify}: {work: WorkRef; active: boolean; onOpen: (taskId: string) => void; onAI: () => void; notify: (message: string) => void}) {
  const context = useObjectContextMenu(notify);
  const [items, setItems] = useState<any[]>([]), [cursor, setCursor] = useState<string>();
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [showClosed, setShowClosed] = useState(true);
  const generation = useRef(0);
  async function load(more = false) {
    const epoch = ++generation.current; setBusy(true); setError("");
    try {
      const result = data(await desktop.tasks("list", undefined, {cursor: more ? cursor : undefined}));
      if (epoch !== generation.current) return;
      setItems(previous => more ? [...new Map([...previous, ...result.tasks].map(item => [item.task_ref.task_id, item])).values()] : result.tasks);
      setCursor(result.next_cursor ?? undefined); setLoaded(true);
    } catch (error) {if (epoch === generation.current) {setError((error as Error).message); setLoaded(true);}}
    finally {if (epoch === generation.current) setBusy(false);}
  }
  useEffect(() => {if (active && !loaded && !busy) void load();}, [active, loaded]);
  useEffect(() => () => {generation.current++;}, [work]);
  const visible = items.filter(item => showClosed || item.state !== "closed");
  return <section className="sidebar-task-list" aria-label="作品任务" aria-busy={busy}>
    <div className="sidebar-panel-heading"><strong>任务</strong>
      <details className="popover-menu"><summary aria-label="任务显示选项" title="任务显示选项"><Icon name="more"/></summary><div className="menu-panel">
        <button aria-pressed={showClosed} onClick={() => setShowClosed(true)}>显示已结束的任务</button><button aria-pressed={!showClosed} onClick={() => setShowClosed(false)}>隐藏已结束的任务</button>
        <hr/><button disabled={busy} onClick={() => void load()}>刷新侧栏任务</button><button onClick={onAI}>让 AI 准备任务</button>
      </div></details></div>
    {error && <div className="sidebar-empty" role="alert"><p>任务未能读取：{error}</p><button disabled={busy} onClick={() => void load()}>重新读取任务</button></div>}
    {busy && !items.length ? <p className="sidebar-empty" role="status">正在读取任务…</p> : !error && !visible.length && <p className="sidebar-empty">{items.length ? "没有进行中的任务。" : "本作品中的任务将出现在此处。"}</p>}
    <ol className="sidebar-items">{visible.map(task => <li key={task.task_ref.task_id}><button {...context(task.brief || "创作任务", [
      {id: "open", label: "打开任务", action: () => onOpen(task.task_ref.task_id)},
      {id: "copy-title", label: "复制任务说明", action: () => desktop.copy(task.brief || "创作任务")},
      {id: "continue", label: "复制接续请求", action: () => desktop.copy(`继续河图洛书原任务。通过当前可用任务连接打开 task_locator：${JSON.stringify({scope_ref: task.task_ref.scope_ref, task_id: task.task_ref.task_id})}。读取原稿、公开反馈和接续记录，沿原操作继续，不重建任务。`)},
    ])} onClick={() => onOpen(task.task_ref.task_id)}><Icon name="check"/><span><strong>{task.brief || "创作任务"}</strong><small>{task.state === "closed" ? "已结束" : task.submission_count ? "有成果待审阅" : "进行中"}{task.submission_count ? ` ${task.submission_count} 批成果` : ""}</small></span></button></li>)}</ol>
    {cursor && <button disabled={busy} onClick={() => void load(true)}>{busy ? "正在读取…" : "更多任务"}</button>}
  </section>;
}

export function SidebarAttachments({work, active, notify, onNavigate, selected, onOpen}: {work: WorkRef; active: boolean; notify: (message: string) => void; onNavigate: (id: string) => void; selected?: ResourceSelection; onOpen: (item: ResourceSelection, trigger: HTMLButtonElement) => void}) {
  const context = useObjectContextMenu(notify);
  const [resources, setResources] = useState<any[]>([]), [images, setImages] = useState<Artwork[]>([]);
  const [resourceCursor, setResourceCursor] = useState<string>(), [imageCursor, setImageCursor] = useState<string>();
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [errors, setErrors] = useState<string[]>([]);
  const [image, setImage] = useState<Artwork>();
  const generation = useRef(0);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const resourceContext = (item: any) => context(item.title, [
    {id: "open", label: "打开", action: () => {const trigger = triggers.current.get(item.resource_id); if (trigger) onOpen({resource_id: item.resource_id, revision: item.revision, title: item.title}, trigger);}},
    {id: "copy-title", label: "复制名称", action: () => desktop.copy(item.title)},
    {id: "copy-as", label: "复制为", children: [
      {id: "plain", label: "纯文本", action: async () => {const value = await desktop.resources("get", {resource_id: item.resource_id, revision: item.revision}); await desktop.copy(manuscriptVisibleText(value.resource.body));}},
      {id: "source", label: "完整原稿", action: async () => {const value = await desktop.resources("get", {resource_id: item.resource_id, revision: item.revision}); await desktop.copy(value.resource.body);}},
    ]},
    {id: "manage", label: "资料与素材", action: () => onNavigate("work.resources")},
    {id: "ai", label: "让 AI 整理此资料", action: () => desktop.handoff("work.resources", {resource_id: item.resource_id, revision: item.revision})},
  ]);
  async function load(more?: "resources" | "images") {
    const epoch = ++generation.current; setBusy(true); setErrors([]);
    const failures: string[] = [];
    const results = await Promise.allSettled([
      more === "images" ? Promise.resolve(undefined) : desktop.resources("list", {cursor: more ? resourceCursor : undefined}).then(data),
      more === "resources" ? Promise.resolve(undefined) : readArtworkPage(async (method, input) => method === "list" ? data(await desktop.tasks("list", undefined, input))
        : data((await desktop.tasks("call", input, {name: "hetu_open_task_view", arguments: {task_ref: input}})).structuredContent), more ? imageCursor : undefined, () => epoch === generation.current),
    ]);
    if (epoch !== generation.current) return;
    const [files, artwork] = results;
    if (files.status === "fulfilled" && files.value) {setResources(previous => more ? [...new Map([...previous, ...files.value.resources].map(item => [item.resource_id, item])).values()] : files.value.resources); setResourceCursor(files.value.next_cursor ?? undefined);}
    else if (files.status === "rejected") failures.push("资料：" + files.reason.message);
    if (artwork.status === "fulfilled" && artwork.value) {const page = artwork.value; setImages(previous => mergeArtwork(more || page.errors.length ? previous : [], page.items)); setImageCursor(page.cursor); failures.push(...page.errors);}
    else if (artwork.status === "rejected") failures.push("图片：" + artwork.reason.message);
    setErrors(failures); setLoaded(true); setBusy(false);
  }
  useEffect(() => {if (active && !loaded && !busy) void load();}, [active, loaded]);
  useEffect(() => () => {generation.current++;}, [work]);
  return <section className="sidebar-attachments" aria-label="作品附件" aria-busy={busy}>
    <div className="sidebar-panel-heading"><strong>附件</strong><IconButton icon="refresh" label="刷新侧栏附件" disabled={busy} onClick={() => void load()}/></div>
    {!!errors.length && <div className="sidebar-empty" role="alert"><p>部分附件未能读取。</p>{errors.map((error, index) => <p key={index}>{error}</p>)}<button disabled={busy} onClick={() => void load()}>重新读取附件</button></div>}
    {busy && !resources.length && !images.length ? <p className="sidebar-empty" role="status">正在读取附件…</p> : !errors.length && !resources.length && !images.length && <p className="sidebar-empty">添加到本作品的图像和资料将显示在此处。</p>}
      <ol className="sidebar-items">{resources.map(item => <li key={item.resource_id}><button ref={button => {if (button) triggers.current.set(item.resource_id, button); else triggers.current.delete(item.resource_id);}} {...resourceContext(item)} aria-current={selected?.resource_id === item.resource_id ? "page" : undefined} onClick={event => onOpen({resource_id: item.resource_id, revision: item.revision, title: item.title}, event.currentTarget)}><Icon name="file"/><span><strong>{item.title}</strong><small>{item.summary}</small></span></button></li>)}</ol>
      {resourceCursor && <button disabled={busy} onClick={() => void load("resources")}>更多资料</button>}
      <ol className="sidebar-items sidebar-image-items">{images.map(item => <li key={artworkKey(item)}><button {...context(item.candidate.title, [
        {id: "open", label: "打开图片", action: () => setImage(item)},
        {id: "copy-title", label: "复制名称", action: () => desktop.copy(item.candidate.title)},
        {id: "source", label: "图片来源与意见", action: () => setImage(item)},
      ])} onClick={() => setImage(item)}>{artworkPreview(item.preview) ? <img src={artworkPreview(item.preview)} alt=""/> : <Icon name="image"/>}<span><strong>{item.candidate.title}</strong><small>{item.candidate.width} × {item.candidate.height}</small></span></button></li>)}</ol>
      {imageCursor && <button disabled={busy} onClick={() => void load("images")}>更多图片</button>}
      <div className="sidebar-attachment-links"><button onClick={() => onNavigate("work.resources")}><Icon name="file"/>资料与素材</button><button onClick={() => onNavigate("work.images")}><Icon name="image"/>图片成果</button><button onClick={() => void desktop.handoff("work.resources").catch(error => notify(error.message))}><Icon name="sparkles"/>让 AI 整理资料</button></div>
    {image && <ArtworkDetail item={image} group={images.filter(item => item.task.task_ref.task_id === image.task.task_ref.task_id && item.submission_id === image.submission_id)} notify={notify} onClose={() => setImage(undefined)}/>}
  </section>;
}
