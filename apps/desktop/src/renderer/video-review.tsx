import { VideoFeedbackFields, type FixedAssetRef } from "@hetu/workbench-ui";
import React, { useEffect, useRef, useState } from "react";
import type { SurfaceContext } from "./contributions.tsx";
import {sameWork} from "@hetu/plugin-sdk";
import { desktop, data } from "./bridge.ts";
import { MediaPreview } from "./media-preview.tsx";
import {VideoDecision} from "./video-decision.tsx";
import { Icon, IconButton, PageActions } from "./workbench.tsx";
import "./surface-pages.css";

const purposes: Record<string, string> = { previsualization: "预演", clip: "片段", final: "成片候选" };
const seconds = (ticks: number, base: any) => ticks * base.numerator / base.denominator;
const feedbackRange = (ranged: boolean, start: string, end: string, base: any) => ranged ? {
  start_tick: Math.round(Number(start) * base.denominator / base.numerator),
  end_tick: Math.round(Number(end) * base.denominator / base.numerator),
} : null;
const matchesFeedback = (input: any, media: any, comment: string, range: any) => input &&
  input.media_ref?.media_id === media.media_id && input.media_ref?.sha256 === media.sha256 && input.media_ref?.revision === media.revision &&
  input.comment === comment && (range === null ? input.range == null : input.range?.start_tick === range.start_tick && input.range?.end_tick === range.end_tick);

/** 默认分集审阅消费Core固定成果，不依赖任何专业插件。 */
export function VideoReview({ work, notify, ai, videoResult }: SurfaceContext) {
  const [project, setProject] = useState<any>(), [episode, setEpisode] = useState(""), [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<string>(), [selected, setSelected] = useState<any>(), [view, setView] = useState<any>(),
    [previous, setPrevious] = useState<any>(), [feedback, setFeedback] = useState<any[]>([]), [feedbackCursor, setFeedbackCursor] = useState<string>(),
    [comment, setComment] = useState(""), [start, setStart] = useState("0"), [end, setEnd] = useState("0"), [ranged, setRanged] = useState(false),
    [position, setPosition] = useState(0), [projectLoading, setProjectLoading] = useState(true), [listLoading, setListLoading] = useState(false),
    [mediaLoading, setMediaLoading] = useState(false), [mediaError, setMediaError] = useState(""), [mediaReload, setMediaReload] = useState(0), [busy, setBusy] = useState(false),
    [error, setError] = useState(""), [journal, setJournal] = useState<any>(), [needsRecovery, setNeedsRecovery] = useState(false), [reload, setReload] = useState(0);
  const generation = useRef(0), pendingDraft = useRef<Promise<unknown>>(Promise.resolve()), dirty = useRef(false);
  const [captionExported,setCaptionExported]=useState<{media:string;asset:FixedAssetRef}>();
  // 固定选择跨外部刷新保持；只有作者切换分集或成果时才替换。
  const requested = useRef(videoResult);
  const refKey = selected ? JSON.stringify(selected) : "";
  const selectionKey=useRef(refKey);selectionKey.current=refKey;
  const active = useRef(true);
  useEffect(() => () => { active.current = false; generation.current++; void desktop.dirty(false); }, []);
  const fail = (e: unknown) => { if (active.current) setError((e as Error).message); };
  useEffect(() => {
    let current = true;
    setProjectLoading(true); setError(""); setProject(undefined);
    desktop.read("hetu.video.projects.get", { video_project_id: work.object_id }).then(data).then(value => {
      if (current) {
        if(requested.current&&!value.episodes.some((r:any)=>r.episode.video_episode_id===requested.current!.video_episode_id))throw Error("原视频分集已不可读，请核对成果。");
        setProject(value); setEpisode(old => requested.current?.video_episode_id ?? (value.episodes.some((r: any) => r.episode.video_episode_id === old) ? old : value.episodes[0]?.episode.video_episode_id ?? ""));
      }
    }).catch(error => { if (current) fail(error); }).finally(() => { if (current) setProjectLoading(false); });
    return () => { current = false; };
  }, [work, reload]);
  useEffect(() => {
    const ticket = ++generation.current;
    setError(""); setItems([]); setNext(undefined); setSelected(undefined); setView(undefined);
    if (!episode) { setListLoading(false); return; }
    setListLoading(true);
    desktop.video("list", { video_episode_id: episode }).then(async value => {
      if (generation.current !== ticket) return;
      const fixed=requested.current?.video_episode_id===episode?requested.current:undefined;
      if(fixed){
        const matches=(row:any)=>row.media_ref.media_id===fixed.media_ref.media_id&&row.media_ref.revision===fixed.media_ref.revision&&row.media_ref.sha256===fixed.media_ref.sha256;
        if(!value.items.some(matches)){
          const original=await desktop.video("media",{media_ref:fixed.media_ref});
          if(generation.current!==ticket)return;
          if(!sameWork(original.media.work_ref,work)||original.media.video_episode_id!==episode||!matches(original))throw Error("原视频归属或版本不一致，请核对成果。");
          value={...value,items:[...value.items,{media:original.media,media_ref:fixed.media_ref}]};
        }
      }
      const selection=fixed?.media_ref??value.items.at(-1)?.media_ref;
      requested.current=selection?{video_episode_id:episode,media_ref:selection}:undefined;
      setItems(value.items); setNext(value.next_cursor ?? undefined); setSelected(selection);
    }).catch(error => { if (generation.current === ticket) fail(error); }).finally(() => { if (generation.current === ticket) setListLoading(false); });
    return () => { generation.current++; };
  }, [episode, reload, work]);
  useEffect(() => {
    let current = true;
    setView(undefined); setPrevious(undefined); setFeedback([]); setFeedbackCursor(undefined); setJournal(undefined); setNeedsRecovery(false); setComment(""); setError(""); setMediaError(""); setPosition(0);
    if (!selected) { setMediaLoading(false); return; }
    setMediaLoading(true);
    Promise.all([desktop.video("media", { media_ref: selected }), desktop.video("feedback", { media_ref: selected }), desktop.video("draft", { media_ref: selected }), desktop.video("journal")]).then(([value, notes, draft, operation]) => {
      if (!current) return;
      setView(value); setFeedback(notes.items); setFeedbackCursor(notes.next_cursor ?? undefined); setJournal(operation);
      setComment(draft?.comment ?? ""); setStart(draft?.start ?? "0"); setEnd(draft?.end ?? String(seconds(value.media.duration_ticks, value.media.time_base))); setRanged(draft?.ranged ?? false);
      setNeedsRecovery(operation?.status === "pending" || !!(draft?.comment && operation?.status === "succeeded" && matchesFeedback(operation.input, selected, draft.comment, feedbackRange(draft.ranged, draft.start, draft.end, value.media.time_base))));
      dirty.current = !!draft?.comment; void desktop.dirty(dirty.current);
    }).catch(error => { if (current) setMediaError((error as Error).message); }).finally(() => { if (current) setMediaLoading(false); });
    return () => { current = false; };
  }, [refKey, work, mediaReload, reload]);
  function draft(changes: Record<string, unknown>) {
    const value = { comment, start, end, ranged, ...changes };
    dirty.current = true; void desktop.dirty(true);
    pendingDraft.current = desktop.video("draft", { media_ref: selected, value }).catch(fail);
  }
  async function run(action: () => Promise<unknown>, feedbackWrite = false) {
    setBusy(true); setError("");
    try { await pendingDraft.current; await action(); }
    catch (e) {
      fail(e);
      if (feedbackWrite) setNeedsRecovery(true);
      try {
        const operation = await desktop.video("journal"); setJournal(operation);
        if (feedbackWrite && operation?.status === "blocked") setNeedsRecovery(false);
      } catch { /* 保留原错误，未知写入仍沿原操作恢复。 */ }
    }
    finally { if (active.current) setBusy(false); }
  }
  async function refreshFeedback() {
    const notes = await desktop.video("feedback", { media_ref: selected });
    setFeedback(notes.items); setFeedbackCursor(notes.next_cursor ?? undefined);
  }
  async function save() {
    const base = view.media.time_base;
    const range = feedbackRange(ranged, start, end, base);
    await desktop.video("save_feedback", { media_ref: selected, comment, range });
    await desktop.video("draft", { media_ref: selected, value: null });
    setComment(""); dirty.current = false; await desktop.dirty(false);
    setJournal(await desktop.video("journal")); await refreshFeedback(); notify("意见已保存，可让 AI 沿原成果继续修改。");
  }
  async function recover() {
    const result = await desktop.video("recover"); setJournal(result);
    const input = result?.input, base = view.media.time_base;
    const range = feedbackRange(ranged, start, end, base);
    if (result?.status === "succeeded" && matchesFeedback(input, selected, comment, range)) {
      await desktop.video("draft", { media_ref: selected, value: null });
      setComment(""); dirty.current = false; await desktop.dirty(false);
    }
    setNeedsRecovery(result?.status === "pending");
    await refreshFeedback();
  }
  function changeSelection(fn: () => void) {
    if (dirty.current) { setError("请先保存意见或清除草稿，再切换成果。"); return; }
    fn();
  }
  const media = view?.media;
  const loading = projectLoading || listLoading || mediaLoading;
  const feedbackLocked = busy || needsRecovery || journal?.status === "pending";
  return <section className="video-workbench surface-page" aria-label="视频作品" aria-busy={loading || busy}>
    <PageActions>
      <IconButton icon="refresh" label="刷新视频作品" disabled={loading || busy} onClick={() => changeSelection(() => {if(selected)requested.current={video_episode_id:episode,media_ref:selected};setReload(n => n + 1);})}/>
      <button onClick={() => ai({ ...(episode ? { video_episode_id: episode } : {}), ...(selected ? { media_ref: selected } : {}) })}><Icon name="sparkles"/>让 AI 继续制作</button>
    </PageActions>
    {loading && <p role="status">正在读取视频作品…</p>}
    {error && <p role="alert">{error}</p>}
    {mediaError && <div><p role="alert">{mediaError}</p><button disabled={busy || mediaLoading} onClick={() => setMediaReload(value => value + 1)}>重新读取本版视频</button></div>}
    {project && <>
      <h2>{project.project.title}</h2>
      {!project.episodes.length ? <div className="surface-empty"><p>还没有视频分集</p><button onClick={() => ai()}>让 AI 开始制作</button></div> : <>
        <label>分集 <select aria-label="视频分集" value={episode} disabled={busy} onChange={e => changeSelection(() => {requested.current=undefined;setEpisode(e.target.value);})}>{project.episodes.map((r: any) => <option key={r.episode.video_episode_id} value={r.episode.video_episode_id}>第{r.episode_number}集 {r.episode.title}</option>)}</select></label>
        {!loading && !error && !items.length && <p>本集还没有视频成果。可以让 AI 接收制作工具返回的视频。</p>}
        {!!items.length && <label>成果版本 <select aria-label="视频成果版本" value={selected?.media_id ?? ""} disabled={busy} onChange={e => changeSelection(() => {const media_ref=items.find(r => r.media_ref.media_id === e.target.value)?.media_ref;requested.current=media_ref?{video_episode_id:episode,media_ref}:undefined;setSelected(media_ref);})}>{items.map(r => <option key={r.media_ref.media_id} value={r.media_ref.media_id}>{r.media.title}（{purposes[r.media.purpose]}）</option>)}</select></label>}
        {next && <button disabled={busy} onClick={() => run(async () => { const page = await desktop.video("list", { video_episode_id: episode, cursor: next }); setItems(old => [...old, ...page.items.filter((row:any)=>!old.some(item=>item.media_ref.media_id===row.media_ref.media_id))]); setNext(page.next_cursor ?? undefined); })}>更多成果</button>}
      </>}
    </>}
    {view && <article className="video-review-content">
      <h3>{media.title} <small>{purposes[media.purpose]}</small></h3>
      <MediaPreview key={refKey} asset={view.asset} sha256={media.asset_ref.sha256} captionTracks={media.caption_tracks} onPosition={setPosition}
        exportCaption={{busy,saved:captionExported?.media===refKey?captionExported.asset:undefined,save:track=>{setCaptionExported(undefined);void run(async()=>{const value=await desktop.video("export_caption",{media_ref:selected,caption_ref:track.asset_ref});if(value.saved&&active.current)setCaptionExported({media:refKey,asset:track.asset_ref});});}}}/>
      <div className="surface-filters">
        {media.previous_media_ref && <button disabled={busy} onClick={() => run(async () => setPrevious(await desktop.video("media", { media_ref: media.previous_media_ref })))}>查看前版</button>}
        <button disabled={busy} onClick={() => run(async () => { const value = await desktop.video("export", { media_ref: selected }); if (value.saved) notify("固定视频文件已导出。"); })}>导出本版视频</button>
        <button disabled={busy} onClick={() => run(async () => { const value = await desktop.video("delivery", { media_refs: [selected] }); await desktop.copy("视频文件交付\n\n" + value.items.map((item: any) => `${item.title}（${purposes[item.purpose]}）\n文件：${item.filename}\n大小：${item.blob.size_bytes} 字节${(item.caption_files ?? []).map((file: any) => `\n字幕：${file.track.label}（${file.filename}）`).join("")}`).join("\n\n") + "\n\n交付范围：所选固定视频与关联字幕。视频和字幕分别导出；剪辑工程由制作工具另行准备。"); notify("交付清单已复制。"); })}>复制交付清单</button>
      </div>
      <VideoDecision key={refKey} view={view} locked={busy} changed={async()=>{const value=await desktop.video("media",{media_ref:selected});if(active.current&&selectionKey.current===refKey)setView(value);}}/>
      {previous && <section aria-label="前版视频"><h3>前版 {previous.media.title}</h3><MediaPreview key={JSON.stringify(previous.media_ref)} asset={previous.asset} sha256={previous.media.asset_ref.sha256} captionTracks={previous.media.caption_tracks}/><button onClick={() => setPrevious(undefined)}>收起前版</button></section>}
      <section aria-label="视频修改意见">
        <h3>修改意见</h3>
        {(needsRecovery || journal?.status === "pending") && <p role="status">前次意见的保存结果尚未确认。<button disabled={busy} onClick={() => run(recover)}>恢复原操作</button></p>}
        <VideoFeedbackFields value={{comment,start,end,ranged}} disabled={feedbackLocked} onChange={changes=>{if(changes.comment!==undefined)setComment(changes.comment);if(changes.start!==undefined)setStart(changes.start);if(changes.end!==undefined)setEnd(changes.end);if(changes.ranged!==undefined)setRanged(changes.ranged);draft(changes);}} onPosition={edge=>{const value=position.toFixed(3);if(edge==="start")setStart(value);else setEnd(value);draft({[edge]:value});}}/>

        <div className="surface-filters"><button disabled={feedbackLocked || !comment.trim()} onClick={() => run(save, true)}>保存意见</button><button disabled={feedbackLocked} onClick={() => run(async () => { await desktop.video("draft", { media_ref: selected, value: null }); setComment(""); dirty.current = false; await desktop.dirty(false); })}>清除草稿</button></div>
        {feedback.map(row => <blockquote key={row.feedback.feedback_id}><p>{row.feedback.comment}</p><small>{row.feedback.range ? `${seconds(row.feedback.range.start_tick, row.feedback.time_base).toFixed(3)}–${seconds(row.feedback.range.end_tick, row.feedback.time_base).toFixed(3)} 秒` : "整版意见"}</small></blockquote>)}
        {feedbackCursor && <button disabled={busy} onClick={() => run(async () => { const page = await desktop.video("feedback", { media_ref: selected, cursor: feedbackCursor }); setFeedback(old => [...old, ...page.items]); setFeedbackCursor(page.next_cursor ?? undefined); })}>更多意见</button>}
      </section>
    </article>}
  </section>;
}
