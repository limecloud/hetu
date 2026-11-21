import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import {textProjection, projectedRange} from "./text-projection.ts";
import {sourceQuotes, sourceOffsets, readerRange, readerRanges, type SourceQuote} from "./annotation-anchors.ts";

import {searchText, type SearchOptions, type SearchJob} from "./text-search.ts";
import {Icon, IconButton} from "./icons.tsx";
import {setReaderHighlights} from "./search-highlights.ts";
import {searchLabel, searchError, type SearchMessageKey} from "./search-labels.ts";


type Key = SearchMessageKey;
export interface SearchMatch {from: number; to: number; replacement: string; contiguous: boolean; quote: SourceQuote; excerpt: {before: string; match: string; after: string}}

function excerpt(text: string, from: number, to: number) {
  let start = Math.max(0, from - 48), end = Math.min(text.length, to + 80);
  if (start && /[\uDC00-\uDFFF]/.test(text[start])) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end++;
  const before = text.slice(start, from).split(/\r\n?|\n/).at(-1) ?? "";
  const after = text.slice(to, end).split(/\r\n?|\n/, 1)[0] ?? "";
  return {before, match: text.slice(from, to), after};
}

export function ManuscriptSearch({source, format, title, raw, editing, disabled, selection, reader, editor, scroll, language, highlights, close, workSearch, presentation = "inline", onReveal, visible = true, queryRequest}: {
  source: string; format: string; title: string; raw: boolean; editing: boolean; disabled: boolean; selection: SourceQuote | null;
  reader: React.RefObject<HTMLElement>; editor: React.RefObject<{locate?: (quote: SourceQuote) => void; replace: (source: string, edits: {from: number; to: number; insert: string}[]) => boolean}>; scroll: React.RefObject<HTMLDivElement>;
  language?: string; highlights: (matches: SourceQuote[], current: number) => void; close: () => void;
  workSearch?: (options: SearchOptions) => React.ReactNode;
  presentation?: "inline" | "sidebar"; onReveal?: () => void; visible?: boolean;
  queryRequest?: {query: string; nonce: number};
}) {
  const t = (key: Key, values?: Record<string, number>) => searchLabel(key, language, values);
  const [options, setOptions] = useState<SearchOptions>({query: "", caseSensitive: false, wholeWord: false, regex: false, segmented: false});
  const [replacement, setReplacement] = useState(""), [showReplace, setShowReplace] = useState(false), [composing, setComposing] = useState(false);
  const [scope, setScope] = useState<{source: string; quote: SourceQuote}>(), [matches, setMatches] = useState<SearchMatch[]>([]), [index, setIndex] = useState(0);
  const [status, setStatus] = useState<"idle"|"searching"|"ready"|"cancelled">("idle"), [error, setError] = useState(""), [truncated, setTruncated] = useState(false), [wrapped, setWrapped] = useState(false);
  const [preview, setPreview] = useState<{source: string; items: SearchMatch[]}>(), job = useRef<SearchJob>(), generation = useRef(0);
  const [workScope, setWorkScope] = useState(false);
  const [revealRequest, setRevealRequest] = useState(0);
  const queryInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!queryRequest) return;
    setOptions(previous => ({...previous, query: queryRequest.query, regex: false, wholeWord: false}));
    setScope(undefined); setWorkScope(false); queryInput.current?.focus({preventScroll: true});
  }, [queryRequest]);
  const sidebar = presentation === "sidebar";
  const projection = useMemo(() => textProjection(source, format, title, raw), [source, format, title, raw]);
  const scoped = !scope || scope.source === source;
  useEffect(() => {
    const epoch = ++generation.current; job.current?.cancel(); setPreview(undefined); setMatches([]); setIndex(0); setWrapped(false); setError("");
    if (!options.query || workScope) { setStatus("idle"); return; }
    if (composing) {setStatus("idle"); return;}
    if (!scoped) { setStatus("idle"); setError("search.selection_changed"); return; }
    setStatus("searching");
    const timer = setTimeout(() => {
      const current = searchText(projection.text, options, replacement); job.current = current;
      void current.result.then(result => {
        if (epoch !== generation.current) return;
        const boundary = scope && sourceOffsets(source, scope.quote);
        const items = result.matches.flatMap(match => {
          const range = projectedRange(projection, match.from, match.to);
          if (!range || boundary && (range.from < boundary.from || range.to > boundary.to)) return [];
          return [{...range, excerpt: excerpt(projection.text, match.from, match.to), replacement: match.replacement, contiguous: source.slice(range.from, range.to).replace(/\r\n?/g, "\n") === projection.text.slice(match.from, match.to).replace(/\r\n?/g, "\n")}];
        });
        setMatches(sourceQuotes(source, items)); setTruncated(result.truncated); setStatus("ready");
      }).catch(error => { if (epoch === generation.current) {setError((error as Error).message); setStatus("idle");} });
    }, 120);
    return () => { clearTimeout(timer); generation.current++; job.current?.cancel(); };
  }, [projection, options, replacement, composing, scope, scoped, workScope]);
  const owner = useRef({});
  const active = matches[index];
  useLayoutEffect(() => {
    if (!visible) {highlights([], 0); setReaderHighlights(owner.current); return;}
    highlights(matches.map(match => match.quote), index);
    if (!editing && reader.current && typeof CSS.highlights !== "undefined") {
      const ranges = readerRanges(reader.current, source, matches.map(match => match.quote)), selected = active ? readerRange(reader.current, source, active.quote) ?? [] : [];
      setReaderHighlights(owner.current, ranges, selected);
    }
    if (active) {
      if (editing) editor.current?.locate?.(active.quote);
      else {
        const range = reader.current && readerRange(reader.current, source, active.quote, true)?.[0];
        let stage: HTMLElement | null = scroll.current;
        while (stage && !/(auto|scroll)/.test(getComputedStyle(stage).overflowY)) stage = stage.parentElement;
        stage ??= document.scrollingElement as HTMLElement;
        if (range && stage) {
          const target = range.getBoundingClientRect(), viewport = stage.getBoundingClientRect();
          const inset = (scroll.current?.querySelector<HTMLElement>(".manuscript-search")?.offsetHeight ?? 0) + 16;
          if (target.top < viewport.top + inset || target.bottom > viewport.bottom - 16)
            stage.scrollTop += target.top - viewport.top - inset;
        }
      }
    }
    return () => setReaderHighlights(owner.current);
  }, [matches, index, editing, showReplace, revealRequest, visible]);
  useEffect(() => () => highlights([], 0), []);
  function navigate(delta: number) { if (!matches.length) return; const next = index + delta; setWrapped(next < 0 || next >= matches.length); setIndex((next + matches.length) % matches.length); }
  function prepare(all: boolean) {
    const items = all ? matches : active ? [active] : [];
    if (!items.length || !editing || disabled) return;
    if (items.some(match => !match.contiguous)) { setError("search.format_boundary"); return; }
    if (all && truncated) { setError("search.refine"); return; }
    setPreview({source, items});
  }
  function replace() {
    if (!preview || preview.source !== source || disabled || !editing) return;
    if (!editor.current?.replace(source, preview.items.map(match => ({from: match.from, to: match.to, insert: match.replacement})))) { setError("search.target_changed"); return; }
    setPreview(undefined);
  }
  const message = (key: string) => searchError(key, language);
  const resultStatus = <><span role="status" aria-live="polite">{composing ? t("search.composing") : status === "searching" ? t("search.searching") : matches.length ? t("search.count", {current: index + 1, count: matches.length}) : options.query && status === "ready" ? t("search.none") : ""}</span>
    <button type="button" aria-label={t("search.previous")} disabled={!matches.length} onClick={() => navigate(-1)}>↑</button><button type="button" aria-label={t("search.next")} disabled={!matches.length} onClick={() => navigate(1)}>↓</button></>;
  const resultStart = Math.floor(index / 100) * 100;
  const scopeControl = <label>{t("search.scope")}<select aria-label={t("search.scope")} value={workScope ? "work" : scope ? "selection" : "document"} onChange={event => {setWorkScope(event.target.value === "work"); setScope(event.target.value === "selection" && selection ? {source, quote: selection} : undefined);}}>
    <option value="document">{t("search.document")}</option><option value="selection" disabled={!selection && !scope}>{t("search.selection")}</option>{workSearch && <option value="work">{t("search.work")}</option>}</select></label>;
  const filterControls = <>{sidebar && scopeControl}<div className="search-filter-checks">{(["caseSensitive", "wholeWord", "regex", "segmented", "diacriticsInsensitive"] as const).map(key => <label key={key}><input type="checkbox" checked={!!options[key]} onChange={event => setOptions({...options, [key]: event.target.checked, ...(key === "segmented" ? {wholeWord: false} : key === "wholeWord" ? {segmented: false} : {})})}/>{t("search." + key as Key)}</label>)}</div></>;
  const scopeKind = workScope ? "work" : scope ? "selection" : "document";
  const menuItem = (label: string, checked: boolean, radio: boolean, action: () => void, inactive = false) => <button type="button" key={label} role={radio ? "menuitemradio" : "menuitemcheckbox"} aria-checked={checked} disabled={inactive} onClick={action}><span className="search-menu-check" aria-hidden="true">{checked ? "✓" : ""}</span><span>{label}</span></button>;
  const sidebarFilters = <div role="menu" aria-label={t("search.advanced")}>
    <div role="group" aria-label={t("search.scope")}>
      {menuItem(t("search.document"), scopeKind === "document", true, () => {setWorkScope(false); setScope(undefined);})}
      {workSearch && menuItem(t("search.work"), workScope, true, () => {setWorkScope(true); setScope(undefined);})}
      {menuItem(t("search.selection"), scopeKind === "selection", true, () => {setWorkScope(false); if(selection)setScope({source, quote: selection});}, !selection && !scope)}
    </div><hr/>
    <div role="group" aria-label={t("search.mode")}>
      {menuItem(t("search.plain_text"), !options.regex, true, () => setOptions({...options, regex: false}))}
      {menuItem(t("search.regex"), options.regex, true, () => setOptions({...options, regex: true}))}
    </div><hr/>
    {menuItem(t("search.caseSensitive"), options.caseSensitive, false, () => setOptions({...options, caseSensitive: !options.caseSensitive}))}
    {menuItem(t("search.diacriticsInsensitive"), !!options.diacriticsInsensitive, false, () => setOptions({...options, diacriticsInsensitive: !options.diacriticsInsensitive}))}
    {menuItem(t("search.include_partial"), !options.wholeWord, false, () => setOptions({...options, wholeWord: !options.wholeWord, segmented: false}))}
    {menuItem(t("search.segmented"), options.segmented, false, () => setOptions({...options, segmented: !options.segmented, wholeWord: false}))}
  </div>;
  return <section className="document-search manuscript-search" data-layout={presentation} aria-label={t("search.title")}>
    {sidebar && <div className="search-heading">
      <details className="popover-menu search-mode"><summary aria-label={t("search.mode")}><strong>{t(showReplace && editing ? "search.find_replace" : "search.find")}</strong><Icon name="chevron" size={12}/></summary><div className="menu-panel">
        <button aria-pressed={!showReplace} onClick={() => setShowReplace(false)}>{t("search.find")}</button><button disabled={!editing || workScope || disabled} aria-pressed={showReplace} onClick={() => setShowReplace(true)}>{t("search.find_replace")}</button>
      </div></details>
      <details className="popover-menu search-filter"><summary aria-label={t("search.advanced")} title={t("search.advanced")}><Icon name="sliders"/></summary><div className="menu-panel">{sidebarFilters}</div></details>
      <IconButton icon="close" label={t("search.close")} onClick={close}/>
    </div>}
    <div className="search-main">{sidebar && <Icon name="search" size={15}/>}<input ref={queryInput} autoFocus={!sidebar} aria-label={t("search.query")} placeholder={t("search.placeholder")} value={options.query} maxLength={1000}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onChange={event => setOptions({...options, query: event.target.value})}
      onKeyDown={event => { if (event.nativeEvent.isComposing || composing) return; if (event.key === "Enter") {event.preventDefault(); navigate(event.shiftKey ? -1 : 1);} if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); close();} }}/>
      {sidebar ? options.query && <IconButton icon="close" label={t("search.clear")} onClick={() => {setOptions({...options, query: ""}); queryInput.current?.focus();}}/> : <>{resultStatus}<IconButton icon="close" label={t("search.close")} onClick={close}/></>}</div>
    {sidebar && !workScope && <div className="search-status">{resultStatus}</div>}
    <div className="search-options">{!sidebar && <>{scopeControl}<details><summary>{t("search.advanced")}</summary><div>{filterControls}</div></details></>}
      {!sidebar && editing && !workScope && <button type="button" aria-expanded={showReplace} disabled={disabled} onClick={() => setShowReplace(!showReplace)}>{t("search.replace")}</button>}
      {status === "searching" && <button type="button" onClick={() => {generation.current++; job.current?.cancel(); setStatus("cancelled");}}>{t("search.cancel")}</button>}</div>
    {status === "cancelled" && <p role="status">{t("search.cancelled")}</p>}{wrapped && <p role="status">{t("search.wrapped")}</p>}
    {truncated && !!matches.length && <p role="status">{t("search.truncated")}</p>}{error && <p className="search-error" role="alert">{message(error)}</p>}
    {workScope && !composing && workSearch?.(options)}
    {editing && !workScope && showReplace && <div className="search-replace"><input aria-label={t("search.replacement")} placeholder={t("search.replacement")} value={replacement} maxLength={100000} onChange={event => setReplacement(event.target.value)}/>
      <button type="button" disabled={disabled || status !== "ready" || !active} onClick={() => prepare(false)}>{t("search.preview_one")}</button><button type="button" disabled={disabled || status !== "ready" || !matches.length || truncated} onClick={() => prepare(true)}>{t("search.preview_all")}</button></div>}
    {preview && editing && <section className="search-preview" aria-label={t("search.preview")}><p>{t("search.preview_count", {count: preview.items.length})}</p>
      <div>{preview.items.slice(0, 50).map(item => <p key={item.from}><del>{source.slice(item.from, item.to)}</del><span aria-hidden="true"> → </span><ins>{item.replacement || t("search.empty")}</ins></p>)}</div>
      {preview.items.length > 50 && <p>{t("search.preview_limited")}</p>}<button type="button" disabled={disabled || preview.source !== source} onClick={replace}>{t("search.apply")}</button><button type="button" onClick={() => setPreview(undefined)}>{t("search.cancel_preview")}</button></section>}
    {sidebar && !workScope && !!matches.length && <nav className="current-search-results" aria-label={t("search.results")}>
      {matches.length > 100 && <p className="muted">{t("search.result_page", {start: resultStart + 1, end: Math.min(resultStart + 100, matches.length), count: matches.length})}</p>}
      <ol start={resultStart + 1}>{matches.slice(resultStart, resultStart + 100).map((match, offset) => {
        const current = resultStart + offset;
        return <li key={match.from}><button type="button" aria-label={t("search.result", {current: current + 1})} aria-current={current === index ? "true" : undefined} onClick={() => {setIndex(current); setWrapped(false); setRevealRequest(value => value + 1); onReveal?.();}}>
          <span>{match.excerpt.before}<mark>{match.excerpt.match}</mark>{match.excerpt.after}</span></button></li>;
      })}</ol>
    </nav>}
  </section>;
}
