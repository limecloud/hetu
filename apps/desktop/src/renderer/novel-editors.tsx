import React, { useEffect, useRef, useState } from "react";
import { desktop } from "./bridge.ts";
import { IconButton, Workbench } from "./workbench.tsx";
import "./novel-editors.css";

export function NovelEditor({ kind, documents, onClose, onSaved }: { kind: "metadata" | "structure"; documents: any[]; onClose: () => void; onSaved: () => void }) {
  const { agentStatus } = React.useContext(Workbench);
  const dialog = useRef<HTMLDialogElement>(null), live = useRef(true);
  const [base, setBase] = useState<any>(), [draft, setDraft] = useState<any>(), [busy, setBusy] = useState(false), [error, setError] = useState(""),
    [journal, setJournal] = useState<any>(), [discarding, setDiscarding] = useState(false), [volumeTitle, setVolumeTitle] = useState("");
  const dirty = !!base && JSON.stringify(draft) !== JSON.stringify(kind === "metadata" ? base.novel.metadata : { volumes: base.novel.volumes, chapters: base.novel.chapters });
  const held = busy || journal?.status === "pending" || agentStatus.state === 'running';
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (e) {
      if (live.current) { setError((e as Error).message); try { setJournal((await desktop.novel("get")).journal); } catch { /* 原错误和输入继续保留。 */ } }
    } finally { if (live.current) setBusy(false); }
  }
  useEffect(() => {
    live.current = true; dialog.current?.showModal();
    void run(async () => { const value = await desktop.novel("get"); if (!live.current) return; setBase(value); setJournal(value.journal); setDraft(structuredClone(kind === "metadata" ? value.novel.metadata : { volumes: value.novel.volumes, chapters: value.novel.chapters })); });
    return () => { live.current = false; void desktop.dirty(false); };
  }, []);
  useEffect(() => { void desktop.dirty(dirty || journal?.status === "pending"); }, [dirty, journal?.status]);
  function close() { if (held) return; if (dirty) setDiscarding(true); else dialog.current?.close(); }
  async function saved() { await desktop.novel("acknowledge"); window.dispatchEvent(new Event("hetu:work-changed")); onSaved(); dialog.current?.close(); }
  async function save() {
    await desktop.novel("save", { kind, expected: { revision: base.revision, sha256: base.sha256 }, ...(kind === "metadata" ? { metadata: draft } : {
      volumes: draft.volumes, chapters: [null, ...draft.volumes.map((v: any) => v.volume_id)].flatMap(id => draft.chapters.filter((c: any) => c.volume_id === id)),
    }) });
    await saved();
  }
  function moveVolume(index: number, direction: number) {
    const volumes = [...draft.volumes]; [volumes[index], volumes[index + direction]] = [volumes[index + direction], volumes[index]]; setDraft({ ...draft, volumes });
  }
  function moveChapter(index: number, other: number) {
    const chapters = [...draft.chapters]; [chapters[index], chapters[other]] = [chapters[other], chapters[index]]; setDraft({ ...draft, chapters });
  }
  function group(volume: string | null) {
    const rows = draft.chapters.map((chapter: any, index: number) => ({ chapter, index })).filter((item: any) => item.chapter.volume_id === volume);
    return <div className="novel-chapters">{!volume && <h3>未分卷</h3>}{rows.map(({ chapter, index }: any, position: number) => {
      const title = documents.find(item => item.document_id === chapter.document_id)?.title ?? "未命名章节";
      return <div className="novel-chapter-row" key={chapter.chapter_id}><span title={title}>{title}</span><select aria-label={title + "所属卷"} value={chapter.volume_id ?? ""} disabled={held} onChange={e => setDraft({ ...draft, chapters: draft.chapters.map((c: any, i: number) => i === index ? { ...c, volume_id: e.target.value || null } : c) })}>
        <option value="">未分卷</option>{draft.volumes.map((v: any) => <option key={v.volume_id} value={v.volume_id}>{v.title}</option>)}
      </select><button aria-label={"上移" + title} title="上移" disabled={held || !position} onClick={() => moveChapter(index, rows[position - 1].index)}>↑</button><button aria-label={"下移" + title} title="下移" disabled={held || position === rows.length - 1} onClick={() => moveChapter(index, rows[position + 1].index)}>↓</button></div>;
    })}{!rows.length && <p>还没有章节</p>}</div>;
  }
  return <dialog ref={dialog} className={"novel-editor " + (kind === "structure" ? "novel-structure-editor" : "")} aria-label={kind === "metadata" ? "编辑作品资料" : "整理卷章结构"} onClose={onClose} onCancel={e => { e.preventDefault(); close(); }}>
    <header><h2>{kind === "metadata" ? "作品资料" : "整理卷章结构"}</h2><IconButton icon="close" label="关闭编辑窗口" disabled={held} onClick={close}/></header>
    {error && <p role="alert">{error}</p>}
    {agentStatus.state === 'running' && <p role="status" className="notice">AI 正在执行编排任务，编辑器已自动锁定以防冲突。</p>}
    {discarding && <div className="recover"><p>修改尚未保存。</p><button onClick={() => setDiscarding(false)}>继续编辑</button><button onClick={() => dialog.current?.close()}>放弃修改并关闭</button></div>}
    {journal?.status === "pending" && <div className="recover"><p>原保存结果尚未确认。</p><button disabled={busy} onClick={() => void run(async () => { await desktop.novel("recover"); await saved(); })}>恢复原小说操作</button></div>}
    {!draft ? <p role="status">正在读取作品资料…</p> : <>
      <div className="novel-editor-content">
        {kind === "metadata" ? <>
          {[{ key: "title", label: "书名", limit: 200 }, { key: "author_name", label: "作者", limit: 200 }, { key: "genre", label: "题材", limit: 100 }].map(field => <label key={field.key}>{field.label}<input maxLength={field.limit} value={draft[field.key]} disabled={held} onChange={e => setDraft({ ...draft, [field.key]: e.target.value })}/></label>)}
          <label>创作状态<select value={draft.status} disabled={held} onChange={e => setDraft({ ...draft, status: e.target.value })}>{Object.entries({ planning: "筹备中", writing: "创作中", completed: "已完成", archived: "已归档" }).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
          <label>语言<input value={draft.language_tag} maxLength={64} disabled={held} onChange={e => setDraft({ ...draft, language_tag: e.target.value })}/></label>
          <label className="novel-synopsis-field">简介<textarea rows={7} value={draft.synopsis} maxLength={20000} disabled={held} onChange={e => setDraft({ ...draft, synopsis: e.target.value })}/></label>
        </> : <>
          <div className="novel-add-volume"><input aria-label="新卷标题" placeholder="分卷标题" value={volumeTitle} disabled={held} maxLength={200} onChange={e => setVolumeTitle(e.target.value)}/><button disabled={held || !volumeTitle.trim()} onClick={() => { setDraft({ ...draft, volumes: [...draft.volumes, { volume_id: `volume_${crypto.randomUUID()}`, title: volumeTitle }] }); setVolumeTitle(""); }}>添加分卷</button></div>
          {group(null)}{draft.volumes.map((volume: any, index: number) => <section className="novel-volume" key={volume.volume_id}><div className="novel-volume-heading"><input aria-label={"第" + (index + 1) + "卷标题"} value={volume.title} maxLength={200} disabled={held} onChange={e => setDraft({ ...draft, volumes: draft.volumes.map((v: any, i: number) => i === index ? { ...v, title: e.target.value } : v) })}/><button aria-label={"上移第" + (index + 1) + "卷"} disabled={held || !index} onClick={() => moveVolume(index, -1)}>↑</button><button aria-label={"下移第" + (index + 1) + "卷"} disabled={held || index === draft.volumes.length - 1} onClick={() => moveVolume(index, 1)}>↓</button></div>{group(volume.volume_id)}</section>)}
        </>}
      </div>
      <footer><button disabled={held} onClick={close}>取消</button><button className="primary" disabled={held || !dirty || (kind === "metadata" ? !draft.title.trim() : draft.volumes.some((v: any) => !v.title.trim()))} onClick={() => void run(save)}>{kind === "metadata" ? "保存资料" : "保存结构"}</button></footer>
    </>}
  </dialog>;
}
