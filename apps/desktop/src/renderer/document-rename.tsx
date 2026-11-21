import React, {useEffect, useRef, useState} from "react";
import {desktop, data} from "./bridge.ts";
import {IconButton} from "./workbench.tsx";

export function DocumentRename({document, onClose, onSaved}: {document: {document_id: string; title: string; current_revision_id: string}; onClose(): void; onSaved(): void}) {
  const dialog = useRef<HTMLDialogElement>(null), live = useRef(true);
  const [title, setTitle] = useState(document.title), [busy, setBusy] = useState(true), [error, setError] = useState(""), [journal, setJournal] = useState<any>();
  useEffect(() => {
    dialog.current?.showModal();
    void desktop.author("journal", {document_id: document.document_id}).then(value => {if (live.current) setJournal(value);}).catch(error => {if (live.current) setError(error.message);}).finally(() => {if (live.current) setBusy(false);});
    return () => {live.current = false;};
  }, []);
  async function save(recover = false) {
    setBusy(true); setError("");
    try {
      const result = recover ? await desktop.author("recover", {document_id: document.document_id}) : await desktop.author("rename", {document_id: document.document_id, base_revision_id: document.current_revision_id, title});
      data(result);
      const record = await desktop.author("journal", {document_id: document.document_id});
      if (record) await desktop.author("acknowledge", {document_id: document.document_id, operation_key: record.input.operation_key});
      onSaved(); dialog.current?.close();
    } catch (error) {
      if (live.current) {setError((error as Error).message); try {setJournal(await desktop.author("journal", {document_id: document.document_id}));} catch {/* 保留原错误和名称。 */}}
    } finally {if (live.current) setBusy(false);}
  }
  return <dialog ref={dialog} className="document-rename" aria-label="重命名文稿" onClose={onClose} onCancel={event => {if (busy || journal?.status === "pending") event.preventDefault();}}>
    <form onSubmit={event => {event.preventDefault(); if (!busy && journal?.status !== "pending") void save();}}>
      <header><h2>重命名</h2><IconButton icon="close" label="关闭重命名" disabled={busy || journal?.status === "pending"} onClick={() => dialog.current?.close()}/></header>
      <label>文稿名称<input autoFocus aria-label="文稿名称" maxLength={200} value={title} disabled={busy || journal?.status === "pending"} onChange={event => setTitle(event.target.value)}/></label>
      {error && <p role="alert">{error}</p>}
      {journal?.status === "pending" && <p role="status">原作者操作结果尚未确认，请沿原操作恢复。</p>}
      <footer><button type="button" disabled={busy || journal?.status === "pending"} onClick={() => dialog.current?.close()}>取消</button>{journal?.status === "pending" ? <button type="button" disabled={busy} onClick={() => void save(true)}>恢复原操作</button> : <button className="primary" disabled={busy || !title.trim() || title.trim() === document.title}>保存名称</button>}</footer>
    </form>
  </dialog>;
}
