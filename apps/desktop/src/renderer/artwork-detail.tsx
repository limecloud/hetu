import React, { useEffect, useRef, useState } from "react";
import { desktop, data } from "./bridge.ts";
import { Icon, IconButton } from "./workbench.tsx";
import { domainText } from "./strings.ts";
import { artworkKey, artworkPreview, type Artwork } from "./artwork-model.ts";

export function ArtworkDetail({ item, group, notify, onClose, onUseCover }: {
  item: Artwork; group: Artwork[]; notify: (message: string) => void; onClose: () => void; onUseCover?: (item: Artwork) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [images, setImages] = useState(group),
    [selected, setSelected] = useState(item.candidate.candidate_id),
    [batch, setBatch] = useState(item.submission_id),
    [view, setView] = useState<any>(),
    [journal, setJournal] = useState<any>(),
    [comment, setComment] = useState(""),
    [receipt, setReceipt] = useState<any>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [discarding, setDiscarding] = useState(false),
    [message, setMessage] = useState("");
  const focused = images.find(image => image.candidate.candidate_id === selected) ?? images[0] ?? item;
  const generation = useRef(0);
  const taskRef = item.task.task_ref;
  function close() {
    if (busy) return;
    if (comment.trim()) { setDiscarding(true); return; }
    dialog.current?.close();
  }
  async function load(submission = batch) {
    const epoch = ++generation.current;
    setBusy(true); setError("");
    try {
      const next = data((await desktop.tasks("call", taskRef, { name: "hetu_open_task_view", arguments: { task_ref: taskRef, submission_id: submission } })).structuredContent);
      const saved = await desktop.tasks("journal", taskRef);
      if (epoch !== generation.current) return;
      setView(next); setJournal(saved);
      setImages((next.submission?.candidates ?? []).filter((candidate: any) => candidate.kind === "image").map((candidate: any) => ({
        ...item, candidate, submission_id: next.submission.submission_id,
        provenance: next.submission.provenance, received_at: next.submission.received_at,
        preview: next.image_previews?.find((p: any) => p.candidate_id === candidate.candidate_id),
        category: item.task.task_kind === "cover" ? "cover" : candidate.image_category ?? "other",
      })));
      setBatch(submission);
    } catch (error) { if (epoch === generation.current) setError((error as Error).message); }
    finally { if (epoch === generation.current) setBusy(false); }
  }
  useEffect(() => {
    dialog.current?.showModal();
    void load();
    return () => { generation.current++; };
  }, []);
  async function save() {
    if (!view?.submission || !comment.trim() || busy || journal?.status === "pending") return;
    setBusy(true); setError(""); setMessage("");
    try {
      const targets = view.submission.candidates.map((candidate: any) => ({ kind: "candidate", candidate_ref: {
        task_ref: taskRef, submission_id: batch, candidate_id: candidate.candidate_id,
      } }));
      const result = data((await desktop.tasks("call", taskRef, { name: "hetu_save_task_feedback", arguments: {
        task_ref: taskRef, target_refs: targets, expected_feedback_head: view.feedback_head ?? null,
        intent: "request_changes", public_comment: comment,
        selected_refs: targets.filter((target: any) => target.candidate_ref.candidate_id === focused.candidate.candidate_id),
        operation_key: `desktop-artwork-feedback-${crypto.randomUUID()}`,
      } })).structuredContent);
      setReceipt(result.feedback_ref); setComment(""); setMessage("修改意见已保存");
      await load();
    } catch (error) {
      setError((error as Error).message);
      try { setJournal(await desktop.tasks("journal", taskRef)); } catch { /* 保留原错误与待恢复操作。 */ }
    } finally { setBusy(false); }
  }
  async function recover() {
    setBusy(true); setError("");
    try {
      const result = data(await desktop.tasks("recover", taskRef));
      if (journal?.action === "hetu.task_feedback.save") {
        const restored = result.original_result ? data(result.original_result) : result;
        setReceipt(restored.feedback_ref); setComment("");
      }
      await load();
      setMessage("原保存操作已确认");
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function copyContinuation() {
    try {
      const locator = JSON.stringify({ scope_ref: taskRef.scope_ref, task_id: taskRef.task_id });
      await desktop.copy(`继续河图洛书原图片任务。通过当前可用任务连接打开 task_locator：${locator}。用 hetu_list_task_feedback 读取公开意见 ${JSON.stringify(receipt)} 及其固定成果，沿原参考稿返工。保存与提交时引用实际处理的 feedback_refs。保留其他图片和作者要求的部分，不重建任务、不采纳或定稿。`);
      setMessage("已复制继续提示词");
    } catch (error) { notify((error as Error).message); }
  }
  const versions = view?.observation?.submission_refs ?? [];
  const date = new Date(focused.received_at);
  return <dialog className="artwork-sheet" ref={dialog} aria-label="固定图片详情" onClose={onClose} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) close(); }}>
    <section className="artwork-detail" aria-label="固定图片详情">
      <header className="artwork-detail-heading"><h2>{focused.candidate.title}</h2><IconButton icon="close" label="关闭图片详情" disabled={busy} onClick={close}/></header>
      {discarding && <div className="recover"><p>修改意见尚未保存。</p><button onClick={() => setDiscarding(false)}>继续编辑</button><button onClick={() => dialog.current?.close()}>放弃意见并关闭</button></div>}
      <div className="artwork-detail-columns">
        <div className="artwork-detail-visual">
          <div className="artwork-preview-stage">{artworkPreview(focused.preview) ? <img className="artwork-preview" src={artworkPreview(focused.preview)} alt={focused.candidate.title}/> : <p className="muted">预览不可用</p>}</div>
          {images.length > 1 && <div className="artwork-filmstrip" aria-label="同批图片">{images.map(image => <button key={artworkKey(image)} aria-label={image.candidate.title} aria-pressed={image.candidate.candidate_id === focused.candidate.candidate_id} disabled={busy || !!comment.trim() || journal?.status === "pending"} onClick={() => { setSelected(image.candidate.candidate_id); setReceipt(undefined); setMessage(""); }}>
            <span>{artworkPreview(image.preview) ? <img src={artworkPreview(image.preview)} alt=""/> : <Icon name="image"/>}</span><small>{domainText(image.candidate.image_view ? `artwork.view.${image.candidate.image_view}` : `artwork.category.${image.category}`, image.category)}</small>
          </button>)}</div>}
        </div>
        <aside className="artwork-detail-inspector" aria-label="图片来源与意见">
          <section><h3>图片来源</h3><dl className="artwork-properties">
            <dt>类别</dt><dd>{domainText(`artwork.category.${focused.category}`, focused.category)}</dd>
            {focused.candidate.image_view && <><dt>视图</dt><dd>{domainText(`artwork.view.${focused.candidate.image_view}`, focused.candidate.image_view)}</dd></>}
            <dt>尺寸</dt><dd>{focused.candidate.width} × {focused.candidate.height}</dd>
            {focused.provenance?.model && <><dt>模型</dt><dd>{focused.provenance.model}</dd></>}
            {!Number.isNaN(date.getTime()) && <><dt>接收时间</dt><dd>{date.toLocaleString()}</dd></>}
          </dl>
          {focused.category === "cover" && onUseCover && <button disabled={busy || !!comment.trim() || journal?.status === "pending"} onClick={() => { dialog.current?.close(); onUseCover(focused); }}>选用此封面</button>}
          {versions.length > 1 && <label className="artwork-version">图片版本<select aria-label="图片版本" value={batch} disabled={busy || !!comment.trim() || journal?.status === "pending"} onChange={event => { setReceipt(undefined); setMessage(""); void load(event.target.value); }}>{versions.map((version: any, index: number) => <option key={version.submission_id} value={version.submission_id}>第 {index + 1} 版</option>)}</select></label>}
          </section>
          <section className="artwork-feedback"><h3>修改意见</h3>
            {journal?.status === "pending" && <div className="recover"><p>原保存结果尚未确认。</p><button disabled={busy} onClick={() => void recover()}>查询并恢复原保存</button></div>}
            {error && <p role="alert">{error}</p>}
            <label><span className="muted">{focused.candidate.title}</span><textarea aria-label="图片修改意见" placeholder="写下需要调整的地方" value={comment} disabled={busy || journal?.status === "pending"} onChange={event => setComment(event.target.value)}/></label>
            <div className="actions"><button disabled={busy || !comment.trim() || !view?.allowed_actions?.includes("hetu.task_feedback.save") || journal?.status === "pending"} onClick={() => void save()}>按此修改</button>{receipt && <button onClick={() => void copyContinuation()}>复制继续提示词</button>}</div>
            {message && <p role="status">{message}</p>}
          </section>
          <details className="artwork-source"><summary>固定来源与关联</summary><pre>{JSON.stringify({ task_ref: taskRef, submission_id: batch, candidate_id: focused.candidate.candidate_id, sha256: focused.candidate.sha256, subject_refs: focused.candidate.subject_refs ?? [], provenance: focused.provenance }, null, 2)}</pre></details>
        </aside>
      </div>
    </section>
  </dialog>;
}
