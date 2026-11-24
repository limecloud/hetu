import React, {useEffect, useLayoutEffect, useRef, useState} from "react";
import {Icon, IconButton} from "./workbench.tsx";
import {manuscriptLayoutEvent, type AnnotationSurface, type DocumentNote, type SourceQuote} from "./annotation-anchors.ts";

export function ManuscriptAnnotations(props: {
  container: React.RefObject<HTMLElement>;
  surface: () => AnnotationSurface | null;
  quote: SourceQuote | null;
  notes: DocumentNote[];
  revision: string;
  documentId: string;
  current: boolean;
  busy: boolean;
  recovery: boolean;
  saveError?: string;
  listRequest: number;
  composeRequest?: {documentId: string; revision: string; quote: SourceQuote; nonce: number};
  save: (items: DocumentNote[]) => Promise<boolean>;
  recover: () => void;
  ai: (quote: SourceQuote) => void;
  formatting?: React.ReactNode;
}) {
  const [mode, setMode] = useState<string | null>(null);
  const [draft, setDraft] = useState<{quote: SourceQuote; text: string; revision: string; id?: string}>();
  const [geometry, setGeometry] = useState<{left: number; top: number; width: number; showSelection: boolean; markers: {id: string; left: number; top: number}[]}>({left: 8, top: 8, width: 320, showSelection: false, markers: []});
  const panel = useRef<HTMLDivElement>(null), selection = useRef<HTMLDivElement>(null);
  const pointer = useRef<{x: number; y: number}>();
  const callbacks = useRef(props); callbacks.current = props;
  const note = props.notes.find(item => item.id === mode);
  const activeQuote = mode === "compose" ? draft?.quote : note?.source_ref ?? props.quote;
  const canAnchor = (props.current || mode === "selection" && !!props.formatting) && (!note || note.source_ref.revision_id === props.revision) && (mode !== "compose" || draft?.revision === props.revision);
  const active = props.notes.filter(item => props.current && !item.resolved && item.source_ref.revision_id === props.revision);
  const activeRef = useRef(active); activeRef.current = active;
  function close() {
    const target = props.container.current?.querySelector<HTMLButtonElement>('.annotation-marker[aria-expanded="true"]') ?? props.container.current?.querySelector<HTMLButtonElement>('button[aria-label="原文批注"]');
    setMode(null); requestAnimationFrame(() => target?.focus({preventScroll: true}));
  }
  useEffect(() => {
    const opened = props.notes.find(item => item.id === mode)?.source_ref;
    const locatingNote = props.current && opened?.revision_id === props.revision && props.quote
      && opened.byte_start === props.quote.byte_start && opened.byte_end === props.quote.byte_end && opened.quote === props.quote.quote;
    // 从批注列表定位原文时保留当前批注；另选正文才切换到选区工具。
    if (props.quote && mode !== "compose" && !locatingNote) setMode("selection");
    else if (!props.quote && mode === "selection") setMode(null);
  }, [props.quote]);
  useEffect(() => { if (props.listRequest) setMode("list"); }, [props.listRequest]);
  useEffect(() => { if (props.recovery) setMode("list"); }, [props.recovery]);
  function compose() {
    if (!props.current || !props.quote || props.recovery) return;
    setDraft({quote: props.quote, text: "", revision: props.revision}); setMode("compose");
  }
  useEffect(() => {
    const request = props.composeRequest;
    if (!request || request.documentId !== props.documentId || request.revision !== props.revision || !props.current || props.recovery || props.busy) return;
    setDraft({quote: request.quote, text: "", revision: props.revision}); setMode("compose");
  }, [props.composeRequest]);
  useLayoutEffect(() => {
    const container = props.container.current;
    if (!container) return;
    let frame = 0;
    const measure = () => {
      const bounds = container.getBoundingClientRect(), surface = callbacks.current.surface();
      const viewport = container.querySelector<HTMLElement>(".manuscript-scroll")?.getBoundingClientRect() ?? bounds;
      const visibleTop = bounds.top + (container.querySelector<HTMLElement>(".manuscript-header")?.offsetHeight ?? 0);
      const visibleBottom = Math.min(bounds.bottom, viewport.bottom);
      const width = Math.max(0, Math.min(mode === "selection" ? Math.ceil(selection.current?.getBoundingClientRect().width ?? 224) : 320, bounds.width - 16));
      const anchor = activeQuote && canAnchor ? surface?.rect(activeQuote) : null;
      const height = mode === "selection" ? selection.current?.offsetHeight ?? 38 : panel.current?.offsetHeight ?? 240;
      const anchorVisible = !!anchor && anchor.bottom >= visibleTop && anchor.top <= visibleBottom;
      const left = Math.max(8, Math.min(bounds.width - width - 8, anchorVisible ? anchor.left - bounds.left + (mode === "selection" ? (anchor.width - width) / 2 : 0) : bounds.width - width - 12));
      const above = anchor && anchor.top - height - 10 >= visibleTop;
      const targetTop = anchorVisible ? mode === "selection" && above || anchor!.bottom + height + 10 > visibleBottom ? anchor!.top - bounds.top - height - 10 : anchor!.bottom - bounds.top + 10 : 12;
      const top = Math.max(visibleTop - bounds.top + 4, Math.min(bounds.height - height - 8, targetTop));
      let previous = -40;
      const body = container.querySelector<HTMLElement>(".author-editor, .reader, .screenplay-reader")?.getBoundingClientRect();
      const markers = activeRef.current.map(item => ({id: item.id, rect: surface?.rect(item.source_ref)}))
        .filter(item => item.rect && item.rect.top >= visibleTop && item.rect.top <= visibleBottom - 28)
        .sort((a, b) => a.rect!.top - b.rect!.top)
        .map(item => {
          const y = Math.max(item.rect!.top - bounds.top, previous + 28); previous = y;
          return {id: item.id, left: Math.min(bounds.width - 30, Math.max(8, (body?.right ?? bounds.right - 38) - bounds.left + 8)), top: y};
        }).filter(item => item.top <= bounds.height - 28);
      setGeometry(previous => {
        const next = {left, top, width, showSelection: anchorVisible, markers};
        if (previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.showSelection === next.showSelection &&
          previous.markers.length === next.markers.length && previous.markers.every((marker, index) => {
            const other = next.markers[index]; return marker.id === other.id && marker.left === other.left && marker.top === other.top;
          })) return previous;
        return next;
      });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    container.addEventListener("scroll", schedule, true); container.addEventListener(manuscriptLayoutEvent, schedule); window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule); observer.observe(container); if (panel.current) observer.observe(panel.current); if (selection.current) observer.observe(selection.current);
    return () => { cancelAnimationFrame(frame); container.removeEventListener("scroll", schedule, true); container.removeEventListener(manuscriptLayoutEvent, schedule); window.removeEventListener("resize", schedule); observer.disconnect(); };
  }, [props.container, props.current, props.notes, props.quote, props.revision, mode, activeQuote, canAnchor, geometry.showSelection]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.target instanceof Element && event.target.closest("[data-context-menu]")) return;
      if (event.key === "Escape" && [...document.querySelectorAll(".popover-menu[open]")].some(menu => menu.checkVisibility())) return;
      if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === "KeyM" && callbacks.current.quote) { event.preventDefault(); compose(); }
      if (event.key === "Escape" && mode) { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    }
    function outside(event: PointerEvent) {
      pointer.current = {x: event.clientX, y: event.clientY};
      const target = event.target as Element;
      if (!panel.current?.contains(target) && !selection.current?.contains(target) && !target.closest(".annotation-marker") && mode !== "compose") setMode(null);
    }
    function openAnchor(event: PointerEvent) {
      if ((event.target as Element).closest(".annotation-layer") || !callbacks.current.current || event.shiftKey || !pointer.current || Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 4) return;
      const surface = callbacks.current.surface();
      const found = activeRef.current.find(item => surface?.contains(item.source_ref, event.clientX, event.clientY));
      if (found) setMode(found.id);
    }
    window.addEventListener("keydown", key, true); document.addEventListener("pointerdown", outside);
    props.container.current?.addEventListener("pointerup", openAnchor);
    return () => { window.removeEventListener("keydown", key, true); document.removeEventListener("pointerdown", outside); props.container.current?.removeEventListener("pointerup", openAnchor); };
  }, [mode, props.quote, props.current, props.recovery]);
  async function submit() {
    if (!draft?.text.trim()) return;
    const items = draft.id ? props.notes.map(item => item.id === draft.id ? {...item, text: draft.text.trim()} : item)
      : [...props.notes, {id: "note_" + crypto.randomUUID(), text: draft.text.trim(), resolved: false, source_ref: {...draft.quote, document_id: props.documentId, revision_id: draft.revision}}];
    if (await props.save(items)) { setMode(null); setDraft(undefined); }
  }
  // 浮条按可用工作面限宽，不把取整后的测量宽度反写成布局上限。
  const position = {left: geometry.left, top: geometry.top, maxWidth: mode === "selection" ? "calc(100% - 16px)" : geometry.width};
  return <div className="annotation-layer">
    {geometry.markers.map(marker => <button type="button" disabled={props.busy} key={marker.id} className="annotation-marker" style={{left: marker.left, top: marker.top}} aria-label={"查看原文批注 " + (props.notes.findIndex(item => item.id === marker.id) + 1)} aria-expanded={mode === marker.id} title={props.notes.find(item => item.id === marker.id)?.text} onClick={() => { setMode(mode === marker.id ? null : marker.id); }}><Icon name="comment" size={14}/></button>)}
    {mode === "selection" && props.quote && (props.current || props.formatting) && geometry.showSelection && <div className="annotation-selection" role="toolbar" aria-label="选区操作" ref={selection} style={position} onMouseDown={event => event.preventDefault()}>
      {props.formatting}
      <button type="button" disabled={!props.current || props.busy || props.recovery} aria-label="添加批注" title={props.current ? "添加批注 ⌘⌥M / Ctrl+Alt+M" : "保存当前修改后添加固定修订批注"} onClick={compose}><Icon name="comment" size={18}/></button>
      <button type="button" disabled={!props.current} aria-label="让 AI 处理选区" title={props.current ? "让 AI 处理选区" : "保存当前修改后交给 AI"} onClick={() => props.ai(props.quote!)}><Icon name="sparkles" size={18}/></button>
    </div>}
    {mode && mode !== "selection" && <div ref={panel} className="annotation-popover" role="dialog" aria-label="原文批注" style={position}>
      <div className="dialog-heading"><strong>{mode === "compose" ? draft?.id ? "编辑批注" : "添加批注" : mode === "list" ? `原文批注 ${props.notes.length}` : "原文批注"}</strong><IconButton icon="close" label="关闭批注" onClick={close}/></div>
      {props.saveError && <p className="manuscript-load-error" role="alert">批注保存失败：{props.saveError}</p>}
      {props.recovery && <div className="recover"><span>发现未确认的批注操作</span><button disabled={props.busy} onClick={props.recover}>恢复原批注</button></div>}
      {mode === "compose" && draft ? <section>
        <blockquote>{draft.quote.quote}</blockquote>
        <label>对这段的意见<textarea autoFocus aria-label="原文批注意见" value={draft.text} onChange={event => setDraft({...draft, text: event.target.value})}/></label>
        {!draft.id && (!props.current || draft.revision !== props.revision) && <p role="alert">正文已改变，请保存后重新选择原文。</p>}
        <div className="actions"><button type="button" onClick={close}>取消</button><button type="button" onClick={() => void submit()} disabled={props.busy || props.recovery || !draft.text.trim() || (!draft.id && (!props.current || draft.revision !== props.revision))}>保存批注</button></div>
      </section> : mode === "list" ? <div className="annotation-list">{!props.notes.length && <p className="muted">选择已保存原文后添加批注。</p>}{props.notes.map((item, index) => <button type="button" key={item.id} onClick={() => {setMode(item.id); if (props.current && item.source_ref.revision_id === props.revision) props.surface()?.reveal(item.source_ref);}}><span>批注 {index + 1}　{item.resolved ? "已处理" : "未处理"}</span><p>{item.text}</p><small>{item.source_ref.revision_id === props.revision ? "当前修订" : "历史修订，保留原位置"}</small></button>)}</div>
      : note && <section><blockquote>{note.source_ref.quote}</blockquote><p className="annotation-text">{note.text}</p><p className="muted">{note.source_ref.revision_id === props.revision ? props.current ? "当前修订" : "已保存修订，正文有未保存修改" : "历史修订，保留原位置"}</p><div className="actions">
        <button disabled={props.busy || props.recovery} onClick={() => {setDraft({id: note.id, quote: note.source_ref, text: note.text, revision: note.source_ref.revision_id}); setMode("compose");}}>编辑意见</button>
        <button disabled={props.busy || props.recovery} onClick={() => void props.save(props.notes.map(item => item.id === note.id ? {...item, resolved: !item.resolved} : item)).then(ok => {if(ok)setMode("list");})}>{note.resolved ? "重新打开" : "标为已处理"}</button>
      </div></section>}
    </div>}
  </div>;
}
