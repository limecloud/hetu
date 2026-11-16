import React, { useEffect, useRef, useState } from "react";
import type { SurfaceContext } from "./contributions.tsx";
import { desktop } from "./bridge.ts";
import { ArtworkLibrary } from "./artwork.tsx";
import { artworkPreview, type Artwork } from "./artwork-model.ts";
import { Icon, IconButton } from "./workbench.tsx";
import "./covers.css";
import { readWorkContent } from "./work-content.ts";

export function ImagesWorkbench(context: SurfaceContext) {
  const [selection, setSelection] = useState<{ item: Artwork; title: string; author: string }>();
  async function select(item: Artwork) {
    try {
      const value = await readWorkContent(context.work);
      setSelection({ item, title: value.summary.title, author: value.record.metadata?.author_name ?? "" });
    } catch (error) { context.notify((error as Error).message); }
  }
  return <><ArtworkLibrary {...context} onUseCover={context.work.kind === "novel" ? item => void select(item) : undefined}/>
    {selection && <CoverWorkbench {...context} initial={selection.item} title={selection.title} author={selection.author} onClose={() => setSelection(undefined)}/>}
  </>;
}

function taskSelection(item: Artwork) {
  return { source: { kind: "creative_task", reference: { task_ref: item.task.task_ref, submission_id: item.submission_id, candidate_id: item.candidate.candidate_id } }, preview: item.preview, title: item.candidate.title };
}
function CoverImage({ preview, title, author = "", overlay = false }: { preview: any; title: string; author?: string; overlay?: boolean }) {
  return <div className="cover-preview">{artworkPreview(preview) ? <img src={artworkPreview(preview)} alt={title}/> : <Icon name="book" size={32}/>}
    {overlay && <div className="cover-preview-text"><strong>{title}</strong><span>{author}</span></div>}
  </div>;
}

export function CoverWorkbench({ work, ai, notify, title, author, initial, initialTab = "candidates", onClose }: SurfaceContext & { title: string; author: string; initial?: Artwork; initialTab?: "candidates" | "local" | "history"; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), live = useRef(true);
  const [current, setCurrent] = useState<any>(), [tab, setTab] = useState<string>(initialTab), [selection, setSelection] = useState<any>(initial ? taskSelection(initial) : undefined),
    [overlay, setOverlay] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""),
    [revision, setRevision] = useState(1), [history, setHistory] = useState<any>(), [requests, setRequests] = useState<any[]>([]), [cursor, setCursor] = useState<string>(),
    [request, setRequest] = useState<any>();
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (e) { if (live.current) setError((e as Error).message); }
    finally { if (live.current) setBusy(false); }
  }
  async function refresh() {
    const value = await desktop.covers("get");
    if (live.current) setCurrent(value);
  }
  async function loadRequests(more = false) {
    const result = await desktop.covers("requests", more ? { cursor } : {});
    if (live.current) { setRequests(previous => more ? [...previous, ...result.requests] : result.requests); setCursor(result.next_cursor ?? undefined); }
  }
  useEffect(() => {
    live.current = true; dialog.current?.showModal();
    void run(async () => { await refresh(); await loadRequests(); });
    return () => { live.current = false; };
  }, []);
  function close() { if (!busy) dialog.current?.close(); }
  async function apply(source: any, useOverlay = overlay) {
    const prepared = await desktop.covers("prepare", { source, overlay: useOverlay, expected_cover: current.expected_cover });
    await desktop.covers("commit", { token: prepared.token });
    await desktop.covers("acknowledge");
    await refresh(); setSelection(undefined); setHistory(undefined);
    window.dispatchEvent(new Event("hetu:cover-changed"));
    setMessage(source.kind === "history" ? "已恢复为新的封面修订" : "已用作封面");
    notify("封面已更新。");
  }
  const held = busy || current?.journal?.status === "pending";
  const presentation = current?.cover?.presentation;
  return <dialog ref={dialog} className="cover-sheet" aria-label="更换封面" onClose={onClose} onCancel={event => { event.preventDefault(); close(); }}>
    <header className="cover-heading"><h2>更换封面</h2><span>{title}</span><button disabled={held} onClick={() => ai()}>让 AI 准备封面</button><IconButton icon="close" label="关闭封面窗口" disabled={busy} onClick={close}/></header>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {current?.journal && <div className="recover"><p>{current.journal.status === "pending" ? "上次封面选用的结果尚未确认。" : current.journal.status === "blocked" ? "原封面操作被阻止，请核对版本后继续。" : "上次封面操作已确认。"}</p><div className="actions">
      {current.journal.status === "pending" ? <button disabled={busy} onClick={() => void run(async () => { await desktop.covers("recover"); await desktop.covers("acknowledge"); await refresh(); window.dispatchEvent(new Event("hetu:cover-changed")); setMessage("原封面操作已确认"); })}>恢复原封面操作</button>
      : <button disabled={busy} onClick={() => void run(async () => { await desktop.covers("acknowledge"); await refresh(); })}>收起已确认操作</button>}
    </div></div>}
    <div className="cover-columns">
      <aside className="cover-current"><div className="cover-section-heading"><h3>当前封面</h3><IconButton icon="refresh" label="刷新当前封面" disabled={busy} onClick={() => void run(refresh)}/></div>
        <CoverImage preview={current?.preview} title={presentation?.title_overlay || title} author={presentation?.author_overlay} overlay={!!(presentation?.title_overlay || presentation?.author_overlay)}/>
        <p>{current?.cover ? `修订 ${current.cover.revision}` : "尚未选用封面"}</p>
      </aside>
      <div className="cover-content">
        <div className="cover-tabs" role="tablist" aria-label="封面来源">{[{ id: "candidates", label: "候选" }, { id: "local", label: "本地导入" }, { id: "history", label: "历史" }].map((item, index, all) => <button key={item.id} role="tab" aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} disabled={held} onClick={() => { setTab(item.id); setSelection(undefined); setMessage(""); }} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % all.length : event.key === "ArrowLeft" ? (index + all.length - 1) % all.length : -1;
          if (next >= 0) { event.preventDefault(); setTab(all[next].id); setSelection(undefined); setMessage(""); (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus(); }
        }}>{item.label}</button>)}</div>
        <div className="cover-source-content">
          {selection ? <section className="cover-selection" aria-label="待选用封面"><div className="cover-section-heading"><h3>{selection.title}</h3><button disabled={held} onClick={() => setSelection(undefined)}>返回候选</button></div>
            <CoverImage preview={selection.preview} title={title} author={author} overlay={overlay}/>
            <label className="cover-overlay"><input type="checkbox" checked={overlay} disabled={held} onChange={e => setOverlay(e.target.checked)}/>叠加书名与作者</label>
            <button className="primary" disabled={held || !current} onClick={() => void run(async () => { try { await apply(selection.source); } finally { await refresh(); } })}>用作封面</button>
          </section> : tab === "local" ? <section className="cover-local"><Icon name="image" size={20}/><p>PNG、JPEG 或 WebP 图片</p><button disabled={held} onClick={() => void run(async () => {
            const file = await desktop.covers("choose_file");
            if (file) { setOverlay(false); setSelection({ source: { kind: "file", token: file.token }, preview: file.preview, title: file.filename }); }
          })}>选择图片</button></section> : tab === "history" ? <section className="cover-history" aria-label="封面历史">
            {current?.cover?.revision > 1 ? <><label>封面修订<input aria-label="封面修订" type="number" min={Math.max(1, current.cover.revision - 999)} max={current.cover.revision - 1} value={revision} disabled={held} onChange={e => { setRevision(Number(e.target.value)); setHistory(undefined); }}/></label>
              <button disabled={held} onClick={() => void run(async () => setHistory(await desktop.covers("get", { revision })))}>查看修订</button>
              {history?.cover && <><CoverImage preview={history.preview} title={history.cover.presentation.title_overlay || title} author={history.cover.presentation.author_overlay} overlay={!!history.cover.presentation.title_overlay}/><p>修订 {history.cover.revision}</p><button disabled={held} onClick={() => void run(async () => { try { await apply({ kind: "history", revision: history.cover.revision }); } finally { await refresh(); } })}>恢复此封面</button></>}
            </> : <p>还没有可恢复的封面历史</p>}
          </section> : <>
            <ArtworkLibrary work={work} ai={ai} notify={notify} embedded filterCategory="cover" onUseCover={item => { setOverlay(false); setSelection(taskSelection(item)); }}/>
            {!!requests.length && <details className="cover-requests"><summary>外部封面设计记录</summary>{requests.map(item => <button key={item.request.request_id} disabled={held} onClick={() => void run(async () => setRequest(await desktop.covers("candidates", { request_id: item.request.request_id })))}>{item.request.design.art_direction}</button>)}{cursor && <button disabled={held} onClick={() => void run(() => loadRequests(true))}>加载更多记录</button>}
              {request && <div className="cover-request-candidates">{request.candidates.map((item: any) => <button key={item.reference.filename} disabled={held} onClick={() => { setOverlay(request.request.design.text_mode === "background_only"); setSelection({ source: { kind: "candidate", reference: item.reference }, preview: item.preview, title: item.candidate.filename }); }}><img src={artworkPreview(item.preview)} alt={item.candidate.filename}/><span>{item.candidate.filename}</span></button>)}{!request.candidates.length && <p>尚未收到图片</p>}</div>}
            </details>}
          </>}
        </div>
      </div>
    </div>
  </dialog>;
}
