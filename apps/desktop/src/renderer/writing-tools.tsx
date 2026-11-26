import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkRef } from "@hetu/plugin-sdk";
import { toolsForWork, type WritingTool, type WritingPromptRequest } from "../writing-prompts.ts";
import { desktop } from "./bridge.ts";
import { Icon, IconButton } from "./workbench.tsx";
import {ProfessionalToolsDialog} from "./professional-tools.tsx";
import type {ProfessionalTarget} from "../professional-contract.ts";

function PromptPreview({ tool, request, close }: { tool: WritingTool; request: WritingPromptRequest; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), attempt = useRef(0);
  const [prompt, setPrompt] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const delivery = desktop.promptDelivery;
  const [deliveryState, setDeliveryState] = useState<"idle" | "sending" | "accepted" | "drafted" | "rejected" | "unknown">("idle");
  const delivering = useRef(false);
  async function generate() {
    const id = ++attempt.current;
    setBusy(true); setError(""); setPrompt(""); setCopied(false);
    try {
      const result = await desktop.writingPrompt(request);
      if (id === attempt.current) setPrompt(result.prompt);
    } catch (error) { if (id === attempt.current) setError((error as Error).message); }
    finally { if (id === attempt.current) setBusy(false); }
  }
  useEffect(() => {
    dialog.current?.showModal(); void generate();
    return () => { attempt.current++; };
  }, []);
  async function copy() {
    const id = attempt.current;
    setBusy(true); setError("");
    try { await desktop.copy(prompt); if (id === attempt.current) setCopied(true); }
    catch (error) { if (id === attempt.current) setError((error as Error).message); }
    finally { if (id === attempt.current) setBusy(false); }
  }
  async function send(mode: "send" | "draft") {
    if (!delivery || !prompt || busy || delivering.current || deliveryState !== "idle") return;
    delivering.current = true;
    const id = attempt.current;
    setBusy(true); setCopied(false); setError(""); setDeliveryState("sending");
    try {
      const result = await delivery.send(prompt, mode, request.work_ref);
      if (id === attempt.current) { setDeliveryState(result.isError ? "rejected" : mode === "send" ? "accepted" : "drafted");if (!result.isError && desktop.agentSessionHost === true) { dialog.current?.close(); window.dispatchEvent(new CustomEvent("hetu:agent-open",{detail:{work_ref:request.work_ref}})); } }
    } catch { if (id === attempt.current) setDeliveryState("unknown"); }
    finally { if (id === attempt.current) setBusy(false); }
  }
  const deliveryMessage = {
    idle: "", sending: "正在交给当前 Agent…", accepted: "宿主已接收请求，等待 Agent 处理。",
    drafted: "已放入当前对话草稿，请在对话中发送。", rejected: "宿主未接收请求，可复制提示词后继续。",
    unknown: "发送结果尚未确认，请先查看当前对话，避免重复执行。",
  }[deliveryState];
  return createPortal(<dialog ref={dialog} className="writing-prompt" aria-label={tool.label + "提示词"} onClose={close}>
    <header><h2>{tool.label}提示词</h2><IconButton icon="close" label="关闭提示词" onClick={() => dialog.current?.close()}/></header>
    <p>{delivery ? desktop.agentSessionHost ? "放入河图内的当前终端，核对后按Enter发送。也可复制请求。" : "交给当前对话中的 Agent 处理，也可复制提示词。" : "复制到 Codex、Claude Code 等外部 Agent 中继续。"}</p>
    {busy && !prompt && <p role="status">正在准备固定上下文…</p>}
    {prompt && <textarea aria-label="外部 Agent 提示词" readOnly value={prompt} spellCheck={false}/>}
    {error && <p role="alert">{error}</p>}
    {copied && <p role="status">提示词已复制，请在外部 Agent 中粘贴。</p>}
    {deliveryMessage && <p role="status">{deliveryMessage}</p>}
    <footer><button type="button" onClick={() => dialog.current?.close()}>关闭</button>{!prompt && error && <button type="button" disabled={busy} onClick={() => void generate()}>重试</button>}<button type="button" className={delivery ? undefined : "primary"} disabled={busy || !prompt} onClick={() => void copy()}>复制提示词</button>{delivery?.drafts && <button type="button" className={delivery?.directSend === false ? "primary" : undefined} disabled={busy || !prompt || deliveryState !== "idle"} onClick={() => void send("draft")}>{desktop.agentSessionHost ? "放入当前终端" : "放入对话草稿"}</button>}{delivery && delivery.directSend !== false && <button type="button" className="primary" disabled={busy || !prompt || deliveryState !== "idle"} onClick={() => void send("send")}>发送给当前 Agent</button>}</footer>
  </dialog>, document.body);
}

export function WritingTools({ work, documentId, revisionId, selection, disabled, blocked }: {
  work: WorkRef;
  documentId: string;
  revisionId: string;
  selection?: { byte_start: number; byte_end: number; quote: string } | null;
  disabled?: boolean;
  blocked?: string;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [preview, setPreview] = useState<{tool: WritingTool; request: WritingPromptRequest}>();
  const [professional,setProfessional]=useState<ProfessionalTarget>();
  useEffect(()=>{setProfessional(undefined);},[work.workspace_id,work.kind,work.object_id,documentId]);
  return <><details ref={menu} className="popover-menu writing-tools">
    <summary aria-label="外部 Agent 写作工具" title="外部 Agent 写作工具"><Icon name="sparkles"/></summary>
    <div className="menu-panel writing-tools-panel" role="menu" aria-label="写作工具">
      <p className="writing-tools-hint">{blocked || (desktop.promptDelivery ? "预览请求，交给当前 Agent 处理" : "生成提示词，复制到外部 Agent 中继续")}</p>
      {toolsForWork(work.kind).map(tool => <button key={tool.id} type="button" role="menuitem" disabled={disabled || !!blocked} title={tool.description} onClick={() => {
        if (menu.current) menu.current.open = false;
        setPreview({tool, request: {work_ref: work, tool_id: tool.id, object_ref: {document_id: documentId, revision_id: revisionId, ...(selection ?? {})}}});
      }}><strong>{tool.label}</strong><span>{tool.description}</span></button>)}
      <button type="button" role="menuitem" disabled={disabled||!!blocked} onClick={()=>{if(menu.current)menu.current.open=false;setProfessional({page:work.kind==="drama"?"drama.reader":"novel.reader",object:{document_id:documentId,revision_id:revisionId,...(selection??{})}});}}>专业工具</button>
    </div>
  </details>{preview && <PromptPreview {...preview} close={() => setPreview(undefined)}/>} {professional&&<ProfessionalToolsDialog work={work} target={professional} onClose={()=>setProfessional(undefined)}/>}</>;
}
