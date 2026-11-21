import React, {useEffect, useRef, useState} from "react";
import {Icon, IconButton, ManuscriptText} from "@hetu/workbench-ui";
import {desktop} from "./bridge.ts";
import {resourceReadingParts, resourceReadingTitle} from "./resource-source.ts";
import "./surface-pages.css";
import {useObjectContextMenu} from "./text-context-menus.tsx";
import {manuscriptVisibleText} from "@hetu/workbench-ui/manuscript-format";

export interface ResourceSelection {resource_id: string; revision: number; title: string}

/** 仅改变资料呈现；固定引用和原稿保持原字节。 */
export function ResourceBody({text, title}: {text: string; title: string}) {
  return <div className="resource-reading-body">{resourceReadingParts(text).map((part, index) => part.source ?
    <details key={index} className="resource-source"><summary>固定原文来源</summary>
      <dl><dt>文稿</dt><dd>{part.source.document_id}</dd><dt>修订</dt><dd>{part.source.revision_id}</dd><dt>内容摘要</dt><dd>{part.source.sha256}</dd></dl>
      <details><summary>原始引用</summary><pre>{part.text}</pre></details>
    </details> : part.text.trim() ? <ManuscriptText key={index} text={part.text.replace(/^(?:\r\n|\r|\n)+|(?:\r\n|\r|\n)+$/g, "")} title={index === 0 ? title : undefined} format="markdown"/> : null)}</div>;
}

export function ResourceReading({selection, onClose, onManage, onAI}: {selection: ResourceSelection; onClose(): void; onManage(): void; onAI(): void}) {
  const [value, setValue] = useState<any>(), [error, setError] = useState("");
  const [retry, setRetry] = useState(0), [busy, setBusy] = useState(true);
  const context = useObjectContextMenu(setError);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {back.current?.focus({preventScroll: true});}, []);
  useEffect(() => {
    let current = true; setBusy(true); setError(""); setValue(undefined);
    desktop.resources("get", {resource_id: selection.resource_id, revision: selection.revision}).then(result => {
      if (current) setValue(result);
    }).catch(error => {if (current) setError(error.message);}).finally(() => {if (current) setBusy(false);});
    return () => {current = false;};
  }, [selection.resource_id, selection.revision, retry]);
  const resource = value?.resource;
  const title = resource ? resourceReadingTitle(resource.body ?? "", resource.title) : selection.title;
  return <section className="resource-reading reading-surface" aria-label="附件资料详情" aria-busy={busy}>
    <header className="resource-reading-toolbar">
      <button ref={back} onClick={onClose}><Icon name="back"/>返回文稿</button>
      <div className="actions"><IconButton icon="refresh" label="重新读取当前附件" disabled={busy} onClick={() => setRetry(value => value + 1)}/><button onClick={onAI}><Icon name="sparkles"/>让 AI 整理资料</button><button onClick={onManage}>资料与素材</button></div>
    </header>
    <div className="resource-reading-scroll" tabIndex={0} aria-label="附件正文滚动区">
      <div className="resource-reading-page" tabIndex={0} {...context(title, () => {const plain = getSelection()?.toString() || (resource ? manuscriptVisibleText(resource.body ?? "") : ""); return [
        {id: "copy", label: "复制", disabled: !resource, action: () => desktop.copy(plain)},
        {id: "source", label: "复制完整原稿", disabled: !resource, action: () => desktop.copy(resource.body ?? "")},
        {id: "manage", label: "资料与素材", action: onManage},
        {id: "ai", label: "让 AI 整理资料", action: onAI},
      ];})}>
        <h1>{title}</h1>
        {busy && <p role="status">正在读取资料…</p>}
        {error && <div role="alert"><p>资料未能读取：{error}</p><button onClick={() => setRetry(value => value + 1)}>重新读取资料</button></div>}
        {resource && <><ResourceBody text={resource.body || "此资料没有正文。"} title={title}/>
          {resource.source_notes && <details className="resource-source"><summary>来源说明</summary><ManuscriptText text={resource.source_notes} format="markdown"/></details>}
        </>}
      </div>
    </div>
  </section>;
}
