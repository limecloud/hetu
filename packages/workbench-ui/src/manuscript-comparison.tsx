import React, {useMemo, useRef, useState} from "react";
import {compareManuscripts, changedSpan, type DiffBlock, type ManuscriptDifference} from "./manuscript-diff.ts";
import {ManuscriptReading, type ManuscriptReadingHandle} from "./manuscript-reading.tsx";
import {ManuscriptText} from "./manuscript.tsx";
import {ScreenplayText} from "./screenplay.tsx";
import {manuscriptFormat, manuscriptVisibleText} from "./manuscript-format.ts";
import {readingProfile, readingStyle, type ReadingKind} from "./reading.ts";

function compactRows(rows: ManuscriptDifference[]) {
  const compact: ManuscriptDifference[] = [];
  for (const row of rows) {
    const previous = compact.at(-1);
    const canMerge = previous && previous.kind === row.kind
      && (!previous.before || !row.before || previous.before.to === row.before.from)
      && (!previous.after || !row.after || previous.after.to === row.after.from);
    if (!canMerge) { compact.push(row); continue; }
    compact[compact.length - 1] = {
      kind: row.kind,
      before: previous.before && row.before ? {from: previous.before.from, to: row.before.to, text: previous.before.text + row.before.text} : previous.before ?? row.before,
      after: previous.after && row.after ? {from: previous.after.from, to: row.after.to, text: previous.after.text + row.after.text} : previous.after ?? row.after,
    };
  }
  return compact;
}

/** 只比较已交付的固定字符串；批准、保存和冲突仍归调用方的应用用例。 */
export function ManuscriptComparison({before, after, beforeLabel = "前稿", afterLabel = "后稿", title, format = "plain", kind = "novel", preferences = {}, language = preferences.language}: {
  before: string; after: string; beforeLabel?: string; afterLabel?: string; title?: string; format?: string; kind?: ReadingKind; preferences?: Record<string, any>; language?: string;
}) {
  const en = language === "en", result = useMemo(() => {
    const value = compareManuscripts(before, after, format);
    return {...value, rows: value.rows.filter(row => !(format === "markdown" && title && row.kind === "equal" && row.before?.from === 0
      && !manuscriptVisibleText(row.before.text, manuscriptFormat(row.before.text, title)).trim()))};
  }, [before, after, format, title]);
  const large = before.length + after.length > 512 * 1024 || result.rows.length > 2000;
  const rows = useMemo(() => large ? compactRows(result.rows) : result.rows, [large, result.rows]);
  const [full, setFull] = useState(false), [sync, setSync] = useState(true), [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [side, setSide] = useState<"before" | "after">("before");
  const first = useRef<ManuscriptReadingHandle>(null), second = useRef<ManuscriptReadingHandle>(null), syncing = useRef(false);
  const count = result.rows.filter(row => row.kind !== "equal").length;
  const marks = useMemo(() => {
    const before: {from: number; to: number}[] = [], after: {from: number; to: number}[] = [];
    for (const row of rows) {
      if (row.kind === "equal") continue;
      if (row.before && row.after) {const span = changedSpan(row.before, row.after); before.push(span.before); after.push(span.after);}
      else {if (row.before) before.push(row.before); if (row.after) after.push(row.after);}
    }
    return {before, after};
  }, [rows]);
  const visible = new Set<number>();
  rows.forEach((row, index) => {if (row.kind !== "equal") for (let i = Math.max(0, index - 1); i <= Math.min(rows.length - 1, index + 1); i++) visible.add(i);});
  for (const index of expanded) visible.add(index);
  function blockTop(handle: ManuscriptReadingHandle, block: DiffBlock, spans: NodeListOf<HTMLElement> | undefined) {
    if (!spans?.length || !handle.scroll) return;
    let low = 0, high = spans.length;
    while (low < high) {const mid = (low + high) >> 1; if (Number(spans[mid].dataset.sourceTo) <= block.from) low = mid + 1; else high = mid;}
    const node = spans[low];
    if (!node || Number(node.dataset.sourceFrom) >= block.to) return;
    return node.getBoundingClientRect().top - handle.scroll.getBoundingClientRect().top + handle.scroll.scrollTop;
  }
  function synchronize(side: "before" | "after") {
    if (!sync || syncing.current) return;
    const source = (side === "before" ? first : second).current, target = (side === "before" ? second : first).current;
    if (!source?.scroll?.clientHeight || !target?.scroll?.clientHeight || !source.reader || !target.reader) return;
    const other = side === "before" ? "after" : "before";
    // 场次／段落的实际顶端随当前字体重新度量，绝不按全文高度比例映射。
    const sourceSpans = source.reader.querySelectorAll<HTMLElement>("[data-source-from]"), targetSpans = target.reader.querySelectorAll<HTMLElement>("[data-source-from]");
    const paired = rows.filter(row => row[side] && row[other]);
    let low = 0, high = paired.length;
    while (low < high) {
      const mid = (low + high) >> 1, top = blockTop(source, paired[mid][side]!, sourceSpans);
      if (top === undefined || top <= source.scroll.scrollTop + 24) low = mid + 1; else high = mid;
    }
    const position = (index: number) => {
      const row = paired[index]; if (!row) return;
      const from = blockTop(source, row[side]!, sourceSpans), to = blockTop(target, row[other]!, targetSpans);
      return from !== undefined && to !== undefined ? {from, to} : undefined;
    };
    let anchor = position(low - 1), next = position(low);
    anchor ??= next;
    if (!anchor) return;
    const fraction = next && next.from > anchor.from ? Math.max(0, Math.min(1, (source.scroll.scrollTop - anchor.from) / (next.from - anchor.from))) : 0;
    const top = anchor.to + (next ? fraction * (next.to - anchor.to) : Math.max(0, source.scroll.scrollTop - anchor.from));
    syncing.current = true; target.scroll.scrollTop = top;
    requestAnimationFrame(() => {syncing.current = false;});
  }
  function passage(block: DiffBlock | undefined, label: string) {
    if (!block) return <p className="muted">{en ? "No text" : "此处无内容"}</p>;
    const text = block.text.replace(/(?:\r\n|\r|\n)+$/, "");
    if (large) return <pre className="comparison-plain-passage" aria-label={label}>{text}</pre>;
    return format === "fountain" ? <ScreenplayText text={text} title=""/> : <ManuscriptText text={text} title={block.from === 0 ? title : undefined} format={format === "markdown" ? "markdown" : "plain"} novel={kind === "novel"} aria-label={label}/>;
  }
  const groups: React.ReactNode[] = [];
  for (let i = 0; !full && i < rows.length; i++) {
    if (!full && !visible.has(i)) {
      const start = i; while (i + 1 < rows.length && !visible.has(i + 1)) i++;
      const end = i;
      groups.push(<button key={"gap" + start} className="comparison-context" type="button" onClick={() => setExpanded(old => new Set([...old, ...Array.from({length: end - start + 1}, (_, index) => start + index)]))}>{en ? `Show ${end - start + 1} unchanged passages` : `展开 ${end - start + 1} 段未改动内容`}</button>);
      continue;
    }
    const row: ManuscriptDifference = rows[i];
    groups.push(<div className="comparison-pair" data-change={row.kind} key={i}>
      <section aria-label={beforeLabel + " " + (i + 1)}><p className="comparison-side-label">{beforeLabel} {row.kind !== "equal" && <span>{en ? "− Original" : "− 原文"}</span>}</p>{passage(row.before, beforeLabel)}</section>
      <section aria-label={afterLabel + " " + (i + 1)}><p className="comparison-side-label">{afterLabel} {row.kind !== "equal" && <span>{en ? "+ Result" : "+ 结果"}</span>}</p>{passage(row.after, afterLabel)}</section>
    </div>);
  }
  return <section className="manuscript-comparison reading-surface" data-full={full} data-active-side={side} aria-label={en ? "Manuscript comparison" : "正文比较"} style={readingStyle(readingProfile(preferences, kind)) as React.CSSProperties} data-document-theme={preferences.document_theme ?? "system"}>
    <div className="comparison-tools"><span role="status">{count ? en ? `${count} changed passages` : `${count} 组改动` : en ? "Text is identical" : "正文相同"}</span>
      <button type="button" aria-pressed={!full} onClick={() => setFull(false)}>{en ? "Changes and context" : "改动与上下文"}</button>
      <button type="button" aria-pressed={full} onClick={() => setFull(true)}>{en ? "Full text" : "全部正文"}</button>
      {full && !large && <label><input type="checkbox" checked={sync} onChange={event => setSync(event.target.checked)}/>{en ? "Sync scrolling" : "同步滚动"}</label>}
    </div>
    {result.coarse && <p role="status" className="muted">{en ? "Large changes are shown as full passages. Review both texts." : "大段改动按整段展示，请核对两侧完整内容。"}</p>}
    {full && <div className="comparison-side-switch" role="group" aria-label={en ? "Displayed text" : "全文显示"}>
      <button type="button" aria-pressed={side === "before"} onClick={() => setSide("before")}>{beforeLabel}</button>
      <button type="button" aria-pressed={side === "after"} onClick={() => setSide("after")}>{afterLabel}</button>
    </div>}
    <div className="comparison-labels"><h3>{beforeLabel}</h3><h3>{afterLabel}</h3></div>
    {full ? <div className="comparison-full">
      <div data-side="before">{large ? <pre className="comparison-plain-passage" aria-label={beforeLabel}>{before}</pre> : <ManuscriptReading ref={first} text={before} title={title} label={beforeLabel} format={format} kind={kind} preferences={preferences} changes={marks.before} changeKind="delete" onScroll={() => synchronize("before")}/>}</div>
      <div data-side="after">{large ? <pre className="comparison-plain-passage" aria-label={afterLabel}>{after}</pre> : <ManuscriptReading ref={second} text={after} title={title} label={afterLabel} format={format} kind={kind} preferences={preferences} changes={marks.after} changeKind="insert" onScroll={() => synchronize("after")}/>}</div>
    </div> : null}<div className="comparison-changes">{groups}</div>
  </section>;
}
