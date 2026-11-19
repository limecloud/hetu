import React, { useEffect, useRef, useState } from "react";
import type { SurfaceContext } from "./contributions.tsx";
import { desktop, data } from "./bridge.ts";
import { MediaPreview } from "./media-preview.tsx";
import { Icon, IconButton, PageActions } from "./workbench.tsx";
import "./surface-pages.css";

const purposes: Record<string, string> = { previsualization: "预演", clip: "片段", final: "成片候选" };
const seconds = (ticks: number, base: any) => ticks * base.numerator / base.denominator;

/** 默认分集审阅消费Core固定成果，不依赖任何专业插件。 */
export function VideoReview({ work, notify, ai }: SurfaceContext) {
  const [project, setProject] = useState<any>(), [episode, setEpisode] = useState(""), [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<string>(), [selected, setSelected] = useState<any>(), [view, setView] = useState<any>(),
    [previous, setPrevious] = useState<any>(), [feedback, setFeedback] = useState<any[]>([]), [feedbackCursor, setFeedbackCursor] = useState<string>(),
    [comment, setComment] = useState(""), [start, setStart] = useState("0"), [end, setEnd] = useState("0"), [ranged, setRanged] = useState(false),
    [position, setPosition] = useState(0), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false),
    [error, setError] = useState(""), [journal, setJournal] = useState<any>(), [reload, setReload] = useState(0);
  const generation = useRef(0), pendingDraft = useRef<Promise<unknown>>(Promise.resolve()), dirty = useRef(false);
  const refKey = selected ? JSON.stringify(selected) : "";
  const active = useRef(true);
  useEffect(() => () => { active.current = false; generation.current++; void desktop.dirty(false); }, []);
  const fail = (e: unknown) => { if (active.current) setError((e as Error).message); };
  useEffect(() => {
    let current = true;
    setLoading(true); setError(""); setProject(undefined);
    desktop.read("hetu.video.projects.get", { video_project_id: work.object_id }).then(data).then(value => {
      if (current) { setProject(value); setEpisode(old => value.episodes.some((r: any) => r.episode.video_episode_id === old) ? old : value.episodes[0]?.episode.video_episode_id ?? ""); }
    }).catch(fail).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [work, reload]);
  useEffect(() => {
    if (!episode) return;
    const ticket = ++generation.current;
    setLoading(true); setError(""); setItems([]); setSelected(undefined); setView(undefined);
    desktop.video("list", { video_episode_id: episode }).then(value => {
      if (generation.current !== ticket) return;
      setItems(value.items); setNext(value.next_cursor ?? undefined); setSelected(value.items.at(-1)?.media_ref);
    }).catch(fail).finally(() => { if (generation.current === ticket) setLoading(false); });
    return () => { generation.current++; };
  }, [episode, reload, work]);
  useEffect(() => {
    if (!selected) return;
    let current = true;
    setView(undefined); setPrevious(undefined); setFeedback([]); setComment(""); setError(""); setPosition(0);
    Promise.all([desktop.video("media", { media_ref: selected }), desktop.video("feedback", { media_ref: selected }), desktop.video("draft", { media_ref: selected }), desktop.video("journal")]).then(([value, notes, draft, operation]) => {
      if (!current) return;
      setView(value); setFeedback(notes.items); setFeedbackCursor(notes.next_cursor ?? undefined); setJournal(operation);
      setComment(draft?.comment ?? ""); setStart(draft?.start ?? "0"); setEnd(draft?.end ?? String(seconds(value.media.duration_ticks, value.media.time_base))); setRanged(draft?.ranged ?? false);
      dirty.current = !!draft?.comment; void desktop.dirty(dirty.current);
    }).catch(fail);
    return () => { current = false; };
  }, [refKey, work]);
  function draft(changes: Record<string, unknown>) {
    const value = { comment, start, end, ranged, ...changes };
    dirty.current = true; void desktop.dirty(true);
    pendingDraft.current = desktop.video("draft", { media_ref: selected, value }).catch(fail);
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await pendingDraft.current; await action(); }
    catch (e) { fail(e); try { setJournal(await desktop.video("journal")); } catch { /* 保留原错误。 */ } }
    finally { if (active.current) setBusy(false); }
  }
  async function refreshFeedback() {
    const notes = await desktop.video("feedback", { media_ref: selected });
    setFeedback(notes.items); setFeedbackCursor(notes.next_cursor ?? undefined);
  }
  async function save() {
    const base = view.media.time_base;
    const range = ranged ? { start_tick: Math.round(Number(start) * base.denominator / base.numerator), end_tick: Math.round(Number(end) * base.denominator / base.numerator) } : null;
    await desktop.video("save_feedback", { media_ref: selected, comment, range });
    await desktop.video("draft", { media_ref: selected, value: null });
    setComment(""); dirty.current = false; await desktop.dirty(false);
    setJournal(await desktop.video("journal")); await refreshFeedback(); notify("意见已保存，可让 AI 沿原成果继续修改。");
  }
  async function recover() {
    const result = await desktop.video("recover"); setJournal(result);
    const input = result?.input, base = view.media.time_base;
    const range = ranged ? { start_tick: Math.round(Number(start) * base.denominator / base.numerator), end_tick: Math.round(Number(end) * base.denominator / base.numerator) } : null;
    if (result?.status === "succeeded" && input.media_ref.media_id === selected.media_id && input.media_ref.sha256 === selected.sha256 && input.media_ref.revision === selected.revision && input.comment === comment && JSON.stringify(input.range ?? null) === JSON.stringify(range)) {
      await desktop.video("draft", { media_ref: selected, value: null });
      setComment(""); dirty.current = false; await desktop.dirty(false);
    }
    await refreshFeedback();
  }
  function changeSelection(fn: () => void) {
    if (dirty.current) { setError("请先保存意见或清除草稿，再切换成果。"); return; }
    fn();
  }
  const media = view?.media;
  const feedbackLocked = busy || journal?.status === "pending";
  return <section className="video-workbench surface-page" aria-label="视频作品">
    <PageActions>
      <IconButton icon="refresh" label="刷新视频作品" disabled={loading || busy} onClick={() => changeSelection(() => setReload(n => n + 1))}/>
      <button onClick={() => ai({ ...(episode ? { video_episode_id: episode } : {}), ...(selected ? { media_ref: selected } : {}) })}><Icon name="sparkles"/>让 AI 继续制作</button>
    </PageActions>
    {loading && <p role="status">正在读取视频作品…</p>}
    {error && <p role="alert">{error}</p>}
    {project && <>
      <h2>{project.project.title}</h2>
      {!project.episodes.length ? <div className="surface-empty"><p>还没有视频分集</p><button onClick={() => ai()}>让 AI 开始制作</button></div> : <>
        <label>分集 <select aria-label="视频分集" value={episode} disabled={busy} onChange={e => changeSelection(() => setEpisode(e.target.value))}>{project.episodes.map((r: any) => <option key={r.episode.video_episode_id} value={r.episode.video_episode_id}>第{r.episode_number}集 {r.episode.title}</option>)}</select></label>
        {!loading && !items.length && <p>本集还没有视频成果。可以让 AI 接收制作工具返回的视频。</p>}
        {!!items.length && <label>成果版本 <select aria-label="视频成果版本" value={selected?.media_id ?? ""} disabled={busy} onChange={e => changeSelection(() => setSelected(items.find(r => r.media_ref.media_id === e.target.value)?.media_ref))}>{items.map(r => <option key={r.media_ref.media_id} value={r.media_ref.media_id}>{r.media.title}（{purposes[r.media.purpose]}）</option>)}</select></label>}
        {next && <button disabled={busy} onClick={() => run(async () => { const page = await desktop.video("list", { video_episode_id: episode, cursor: next }); setItems(old => [...old, ...page.items]); setNext(page.next_cursor ?? undefined); })}>更多成果</button>}
      </>}
    </>}
    {view && <article className="video-review-content">
      <h3>{media.title} <small>{purposes[media.purpose]}</small></h3>
      <MediaPreview key={refKey} asset={view.asset} sha256={media.asset_ref.sha256} onPosition={setPosition}/>
      <div className="surface-filters">
        {media.previous_media_ref && <button disabled={busy} onClick={() => run(async () => setPrevious(await desktop.video("media", { media_ref: media.previous_media_ref })))}>查看前版</button>}
        <button disabled={busy} onClick={() => run(async () => { const value = await desktop.video("export", { media_ref: selected }); if (value.saved) notify("固定视频文件已导出。"); })}>导出本版视频</button>
        <button disabled={busy} onClick={() => run(async () => { const value = await desktop.video("delivery", { media_refs: [selected] }); await desktop.copy("视频文件交付\n\n" + value.items.map((item: any) => `${item.title}（${purposes[item.purpose]}）\n文件：${item.filename}\n大小：${item.blob.size_bytes} 字节`).join("\n\n") + "\n\n交付范围：所选固定视频文件。剪辑工程需单独准备。"); notify("交付清单已复制。"); })}>复制交付清单</button>
      </div>
      {previous && <section aria-label="前版视频"><h3>前版 {previous.media.title}</h3><MediaPreview asset={previous.asset} sha256={previous.media.asset_ref.sha256}/><button onClick={() => setPrevious(undefined)}>收起前版</button></section>}
      <section aria-label="视频修改意见">
        <h3>修改意见</h3>
        {journal?.status === "pending" && <p role="status">前次意见的保存结果尚未确认。<button disabled={busy} onClick={() => run(recover)}>恢复原操作</button></p>}
        <fieldset disabled={feedbackLocked} className="baseline-editor-fields">
        <label><input type="checkbox" checked={ranged} onChange={e => { setRanged(e.target.checked); draft({ ranged: e.target.checked }); }}/>指定片段</label>
        {ranged && <div className="surface-filters">
          <label>开始（秒）<input aria-label="意见开始秒数" type="number" min="0" step="0.001" value={start} onChange={e => { setStart(e.target.value); draft({ start: e.target.value }); }}/></label>
          <button onClick={() => { const value = position.toFixed(3); setStart(value); draft({ start: value }); }}>以当前位置为开始</button>
          <label>结束（秒）<input aria-label="意见结束秒数" type="number" min="0" step="0.001" value={end} onChange={e => { setEnd(e.target.value); draft({ end: e.target.value }); }}/></label>
          <button onClick={() => { const value = position.toFixed(3); setEnd(value); draft({ end: value }); }}>以当前位置为结束</button>
        </div>}
        <textarea aria-label="视频修改意见" placeholder="例如：先听到脚步声，再切到门口。" value={comment} onChange={e => { setComment(e.target.value); draft({ comment: e.target.value }); }}/>
        </fieldset>
        <div className="surface-filters"><button disabled={busy || !comment.trim() || journal?.status === "pending"} onClick={() => run(save)}>保存意见</button><button disabled={busy} onClick={() => run(async () => { await desktop.video("draft", { media_ref: selected, value: null }); setComment(""); dirty.current = false; await desktop.dirty(false); })}>清除草稿</button></div>
        {feedback.map(row => <blockquote key={row.feedback.feedback_id}><p>{row.feedback.comment}</p><small>{row.feedback.range ? `${seconds(row.feedback.range.start_tick, row.feedback.time_base).toFixed(3)}–${seconds(row.feedback.range.end_tick, row.feedback.time_base).toFixed(3)} 秒` : "整版意见"}</small></blockquote>)}
        {feedbackCursor && <button disabled={busy} onClick={() => run(async () => { const page = await desktop.video("feedback", { media_ref: selected, cursor: feedbackCursor }); setFeedback(old => [...old, ...page.items]); setFeedbackCursor(page.next_cursor ?? undefined); })}>更多意见</button>}
      </section>
    </article>}
  </section>;
}
