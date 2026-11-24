import React, {useEffect, useMemo, useRef, useState} from "react";
import {desktop, data} from "./bridge.ts";
import {Icon, IconButton} from "./workbench.tsx";
import type {SourceQuote} from "./annotation-anchors.ts";

export interface DocumentMoveSource {document_id: string; revision_id: string; range: SourceQuote}

export function DocumentMove({source, documents, workKind, workId, onClose, onMoved}: {
  source: DocumentMoveSource; documents: any[]; workKind: "novel" | "drama"; workId: string; onClose(): void; onMoved(result: any): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null), mounted = useRef(true), locked = useRef(false);
  const [query, setQuery] = useState(""), [index, setIndex] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(""), [journal, setJournal] = useState<any>();
  const [newMode, setNewMode] = useState(false), [title, setTitle] = useState(""), [plan, setPlan] = useState(""), [volumeId, setVolumeId] = useState<string | null>(null), [directory, setDirectory] = useState<any>();
  const targets = useMemo(() => documents.filter(doc => doc.document_id !== source.document_id && !doc.archived && doc.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [documents, query, source.document_id]);
  useEffect(() => {void desktop.read(workKind === "novel" ? "hetu.novels.get" : "hetu.drama.projects.get", workKind === "novel" ? {} : {project_id: workId}).then(value => setDirectory(data(value))).catch(() => setDirectory(undefined));}, [workKind, workId]);
  useEffect(() => {document.getElementById(`move-target-${index}`)?.scrollIntoView({block: "nearest"});}, [index, targets]);
  useEffect(() => {
    dialog.current?.showModal();
    return () => {mounted.current = false;};
  }, []);
  async function move(target?: any, recover = false) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try {
      let result;
      if (recover) result = data(await desktop.author("recover", {document_id: source.document_id}));
      else {
        let prepared;
        if (target === undefined) {
          const value: any = {title: title.trim(), ...(workKind === "novel" ? {volume_id: volumeId} : {plan})};
          prepared = await desktop.author("move_to_new", {document_id: source.document_id, base_revision_id: source.revision_id, range: source.range, target: value});
        } else {
          const current = data(await desktop.read("hetu.documents.get", {document_id: target.document_id}));
          prepared = await desktop.author("move_range", {document_id: source.document_id, base_revision_id: source.revision_id, range: source.range,
            target_ref: {document_id: target.document_id, revision_id: current.revision.revision_id, sha256: current.revision.sha256}});
        }
        result = data(await desktop.author("commit", {token: prepared.token}));
      }
      await onMoved(result);
      const record = await desktop.author("journal", {document_id: source.document_id});
      if (record) await desktop.author("acknowledge", {document_id: source.document_id, operation_key: record.input.operation_key});
      dialog.current?.close();
    } catch (error) {
      if (mounted.current) {
        setError((error as Error).message);
        try {setJournal(await desktop.author("journal", {document_id: source.document_id}));} catch {/* 保留原错误。 */}
      }
    } finally {locked.current = false; if (mounted.current) setBusy(false);}
  }
  const pending = journal?.status === "pending";
  return <dialog ref={dialog} className="document-move" aria-label="移至文稿" onClose={onClose} onCancel={event => {if (busy || pending) event.preventDefault();}}>
    <div className="document-move-search"><Icon name="search"/><input autoFocus role="combobox" aria-autocomplete="list" aria-expanded="true" aria-label="搜索目标文稿" placeholder="移至…" value={query} disabled={busy || pending}
      onChange={event => {setQuery(event.target.value); setIndex(0);}}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? targets.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + targets.length) % targets.length;
          setIndex(Math.max(0, next));
        } else if (!newMode && event.key === "Enter" && targets[index]) {event.preventDefault(); void move(targets[index]);}
      }} aria-controls="document-move-targets" aria-activedescendant={!newMode && targets[index] ? `move-target-${index}` : undefined}/><IconButton icon="close" label="取消移动" disabled={busy || pending} onClick={() => dialog.current?.close()}/></div>
    {!newMode && <button type="button" className="document-move-new" disabled={busy || pending} onClick={() => {setNewMode(true); setTitle(source.document_id ? "新文稿" : "");}}><Icon name="plus"/>新建{workKind === "drama" ? "分集" : "章节"}</button>}
    {newMode && <form className="document-move-create" onSubmit={event => {event.preventDefault(); if (title.trim()) void move();}}>
      <label>标题<input autoFocus value={title} maxLength={200} disabled={busy || pending} onChange={event => setTitle(event.target.value)} /></label>
      {workKind === "novel" ? <label>分卷<select value={volumeId ?? ""} disabled={busy || pending} onChange={event => setVolumeId(event.target.value || null)}><option value="">未分卷</option>{directory?.novel?.volumes?.map((volume: any) => <option key={volume.volume_id} value={volume.volume_id}>{volume.title}</option>)}</select></label> : <label>分集计划<textarea value={plan} maxLength={20000} disabled={busy || pending} onChange={event => setPlan(event.target.value)} /></label>}
      <div className="document-move-create-actions"><button type="button" disabled={busy || pending} onClick={() => setNewMode(false)}>返回目标列表</button><button type="submit" disabled={busy || pending || !title.trim()}>创建并移动</button></div>
    </form>}
    <div id="document-move-targets" className="document-move-targets" role="listbox" aria-label="目标文稿" aria-busy={busy}>
      {!newMode && targets.map((target, position) => <button type="button" id={`move-target-${position}`} key={target.document_id} role="option" aria-selected={position === index}
        disabled={busy || pending} onFocus={() => setIndex(position)} onPointerMove={() => setIndex(position)} onClick={() => void move(target)}><Icon name="file"/><span>{target.title}</span></button>)}
      {!newMode && !targets.length && <p role="status">没有匹配的文稿。</p>}
    </div>
    {error && <p className="document-move-error" role="alert">{error}</p>}
    {pending && <div className="document-move-recovery"><p role="status">原移动结果尚未确认，请沿原操作恢复。</p><button disabled={busy} onClick={() => void move(undefined, true)}>恢复原操作</button></div>}
  </dialog>;
}
