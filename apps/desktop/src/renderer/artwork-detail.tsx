import React, { useEffect, useRef, useState } from "react";
import { desktop, data } from "./bridge.ts";
import { Icon, IconButton } from "./workbench.tsx";
import { domainText } from "./strings.ts";
import { artworkKey, artworkPreview, type Artwork } from "./artwork-model.ts";
import { ImageRegionPreview, TaskFeedbackHistory, readTaskFeedbackPage, type ImageRegion, type FeedbackRef } from "@hetu/workbench-ui";

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
    [region,setRegion] = useState<ImageRegion>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [needsReload, setNeedsReload] = useState(false),
    [delivery, setDelivery] = useState<"idle"|"drafted"|"unknown">("idle"),
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
  async function load(submission = batch, preserveRegion = false) {
    const epoch = ++generation.current;
    setBusy(true); setError("");
    try {
      const next = data((await desktop.tasks("call", taskRef, { name: "hetu_open_task_view", arguments: { task_ref: taskRef, submission_id: submission } })).structuredContent);
      const saved = await desktop.tasks("journal", taskRef);
      if (epoch !== generation.current) return;
      setView(next); setJournal(saved);
      const candidates=next.submission?.candidates??[],chosen=candidates.find((candidate:any)=>candidate.candidate_id===selected)??candidates[0];
      if (!preserveRegion) setRegion(next.last_feedback?.target_refs?.find((target:any)=>target.kind==="candidate"&&target.candidate_ref.submission_id===submission&&target.candidate_ref.candidate_id===chosen?.candidate_id)?.image_region);
      setImages((next.submission?.candidates ?? []).filter((candidate: any) => candidate.kind === "image").map((candidate: any) => ({
        ...item, candidate, submission_id: next.submission.submission_id,
        provenance: next.submission.provenance, received_at: next.submission.received_at,
        preview: next.image_previews?.find((p: any) => p.candidate_id === candidate.candidate_id),
        category: item.task.task_kind === "cover" ? "cover" : candidate.image_category ?? "other",
      })));
      setBatch(submission);
      setNeedsReload(false);
    } catch (error) { if (epoch === generation.current) {setError((error as Error).message);setNeedsReload(true);} }
    finally { if (epoch === generation.current) setBusy(false); }
  }
  useEffect(() => {
    dialog.current?.showModal();
    void load();
    return () => { generation.current++; };
  }, []);
  async function save() {
    if (!view?.submission || !comment.trim() || busy || needsReload || journal?.status === "pending") return;
    const operationKey=`desktop-artwork-feedback-${crypto.randomUUID()}`;
    setBusy(true); setError(""); setMessage("");
    try {
      const candidates=region?[focused.candidate]:view.submission.candidates;
      const targets = candidates.map((candidate: any) => ({ kind: "candidate", candidate_ref: {
        task_ref: taskRef, submission_id: batch, candidate_id: candidate.candidate_id,
      },...(region&&candidate.candidate_id===focused.candidate.candidate_id?{image_region:region}:{}) }));
      const response = (await desktop.tasks("call", taskRef, { name: "hetu_save_task_feedback", arguments: {
        task_ref: taskRef, target_refs: targets, expected_feedback_head: view.feedback_head ?? null,
        intent: "request_changes", public_comment: comment,
        selected_refs: targets.filter((target: any) => target.candidate_ref.candidate_id === focused.candidate.candidate_id),
        operation_key: operationKey,
      } })).structuredContent;
      if (response?.status === "blocked" && response.error?.code === "revision_conflict") setNeedsReload(true);
      const result = data(response);
      setReceipt(result.feedback_ref); setDelivery("idle"); setComment(""); setMessage("修改意见已保存，尚未发送");
      await load();
    } catch (error) {
      setError((error as Error).message);
      try {
        const saved=await desktop.tasks("journal", taskRef);
        setJournal(saved?.input?.operation_key===operationKey&&saved.status==="succeeded"?{...saved,status:"pending"}:saved);
      } catch { /* 保留原错误与待恢复操作。 */ }
    } finally { setBusy(false); }
  }
  async function recover() {
    setBusy(true); setError("");
    try {
      const result = data(await desktop.tasks("recover", taskRef));
      if (journal?.action === "hetu.task_feedback.save") {
        const restored = result.original_result ? data(result.original_result) : result;
        setReceipt(restored.feedback_ref); setDelivery("idle"); setComment("");
      }
      await load();
      setMessage("原保存操作已确认");
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function continueFeedback(feedback: FeedbackRef, mode: "copy"|"draft") {
    if (busy || journal?.status === "pending" || mode === "draft" && delivery !== "idle") return;
    const epoch = ++generation.current;
    setBusy(true); setError(""); setMessage("");
    try {
      const prepared = await desktop.tasks("continuation", taskRef, {feedback_ref: feedback});
      if (epoch !== generation.current) return;
      if (mode === "copy") { await desktop.copy(prepared.prompt); if (epoch === generation.current) setMessage("已复制继续提示词"); return; }
      if (!desktop.promptDelivery?.drafts) throw Error("当前宿主暂不支持草稿，可复制继续提示词。");
      setDelivery("unknown");
      const result = await desktop.promptDelivery.send(prepared.prompt, "draft", prepared.work_ref);
      if (epoch !== generation.current) return;
      if (result.isError) {setDelivery("idle"); throw Error("宿主未接收草稿，可复制继续提示词。");}
      setDelivery("drafted"); setMessage("已放入当前草稿，尚未发送");
      if (desktop.agentSessionHost) {
        window.dispatchEvent(new CustomEvent("hetu:agent-open",{detail:{work_ref:prepared.work_ref}}));
        dialog.current?.close(); notify("已放入当前草稿，尚未发送");
      }
    } catch (error) { if (epoch === generation.current) setError((error as Error).message); }
    finally { if (epoch === generation.current) setBusy(false); }
  }
  function continueInAgent(feedback: FeedbackRef) { void continueFeedback(feedback,"draft"); }
  const versions = view?.observation?.submission_refs ?? [];
  const date = new Date(focused.received_at);
  return <dialog className="artwork-sheet" ref={dialog} aria-label="固定图片详情" onClose={onClose} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) close(); }}>
    <section className="artwork-detail" aria-label="固定图片详情">
      <header className="artwork-detail-heading"><h2>{focused.candidate.title}</h2><IconButton icon="close" label="关闭图片详情" disabled={busy} onClick={close}/></header>
      {discarding && <div className="recover"><p>修改意见尚未保存。</p><button onClick={() => setDiscarding(false)}>继续编辑</button><button onClick={() => dialog.current?.close()}>放弃意见并关闭</button></div>}
      <div className="artwork-detail-columns">
        <div className="artwork-detail-visual">
          <div className="artwork-preview-stage">{artworkPreview(focused.preview) ? <ImageRegionPreview key={artworkKey(focused)} src={artworkPreview(focused.preview)!} title={focused.candidate.title} width={focused.candidate.width} height={focused.candidate.height} value={region} disabled={busy||journal?.status==="pending"||!view?.allowed_actions?.includes("hetu.task_feedback.save")} onChange={setRegion}/> : <p className="muted">预览不可用</p>}</div>
          {images.length > 1 && <div className="artwork-filmstrip" aria-label="同批图片">{images.map(image => <button key={artworkKey(image)} aria-label={image.candidate.title} aria-pressed={image.candidate.candidate_id === focused.candidate.candidate_id} disabled={busy || !!comment.trim() || journal?.status === "pending"} onClick={() => { setSelected(image.candidate.candidate_id); setRegion(view?.last_feedback?.target_refs?.find((target:any)=>target.kind==="candidate"&&target.candidate_ref.submission_id===batch&&target.candidate_ref.candidate_id===image.candidate.candidate_id)?.image_region);setReceipt(undefined); setMessage(""); }}>
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
            {(needsReload||!view)&&journal?.status!=="pending"&&<button disabled={busy} onClick={()=>void load(batch,true)}>重新读取当前批次</button>}
            <label><span className="muted">{focused.candidate.title}</span><textarea aria-label="图片修改意见" placeholder="写下需要调整的地方" value={comment} disabled={busy || journal?.status === "pending"} onChange={event => setComment(event.target.value)}/></label>
            <div className="actions"><button disabled={busy || needsReload || !comment.trim() || !view?.allowed_actions?.includes("hetu.task_feedback.save") || journal?.status === "pending"} onClick={() => void save()}>按此修改</button>{receipt && <>
              {desktop.promptDelivery?.drafts&&<button disabled={busy||delivery!=="idle"} onClick={()=>continueInAgent(receipt)}>放入当前草稿</button>}
              <button disabled={busy} onClick={() => void continueFeedback(receipt,"copy")}>复制继续提示词</button>
            </>}</div>
            {delivery==="unknown"&&<p role="status">草稿接收结果尚未确认，请先查看当前会话。</p>}
            {message && <p role="status">{message}</p>}
            <TaskFeedbackHistory key={artworkKey(focused)} task={taskRef} revision={view?.expected?.sha256}
              read={(after,signal)=>readTaskFeedbackPage(async input=>data((await desktop.tasks("call",taskRef,{name:"hetu_list_task_feedback",arguments:{task_ref:taskRef,candidate_ref:{task_ref:taskRef,submission_id:batch,candidate_id:focused.candidate.candidate_id},...input}})).structuredContent),after,signal)}
              filter={target=>target.kind==="candidate"&&target.candidate_ref.submission_id===batch&&target.candidate_ref.candidate_id===focused.candidate.candidate_id}
              disabled={busy||!!comment.trim()||journal?.status==="pending"}
              continueLabel="放入当前草稿"
              onContinue={desktop.promptDelivery?.drafts&&delivery==="idle"?entry=>continueInAgent(entry.feedback_ref):undefined}
              onCopy={entry=>void continueFeedback(entry.feedback_ref,"copy")}
              onPosition={target=>{if(target.kind==="candidate"){setRegion(target.image_region);setMessage("");}}}/>
          </section>
          <details className="artwork-source"><summary>固定来源与关联</summary><pre>{JSON.stringify({ task_ref: taskRef, submission_id: batch, candidate_id: focused.candidate.candidate_id, sha256: focused.candidate.sha256, subject_refs: focused.candidate.subject_refs ?? [], provenance: focused.provenance }, null, 2)}</pre></details>
        </aside>
      </div>
    </section>
  </dialog>;
}
