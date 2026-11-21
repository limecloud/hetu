import React, {forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState} from "react";
import {ManuscriptText} from "./manuscript.tsx";
import {ScreenplayText} from "./screenplay.tsx";
import {ManuscriptSearch} from "./manuscript-search.tsx";
import {mappedSourceSelection, type MappedSelection} from "./source-selection.ts";
import {readerRanges, sourceQuotes} from "./annotation-anchors.ts";
import {readingProfile, readingStyle, type ReadingKind} from "./reading.ts";
import {searchLabel} from "./search-labels.ts";

export interface ManuscriptReadingHandle { reader: HTMLElement | null; scroll: HTMLDivElement | null }
export interface ManuscriptReadingProps {
  text: string; title?: string; label: string; format?: string; kind?: ReadingKind;
  preferences?: Record<string, any>; language?: string; className?: string;
  onSelection?: (value: MappedSelection) => void; onScroll?: () => void;
  changes?: {from: number; to: number}[]; changeKind?: "insert" | "delete";
}
const noHighlights = () => {};

/** 只读表现不带业务桥接；候选、历史、导入及比较使用同一源文映射。 */
export const ManuscriptReading = forwardRef<ManuscriptReadingHandle, ManuscriptReadingProps>(function ManuscriptReading({
  text, title, label, format = "plain", kind = "novel", preferences = {}, language = preferences.language,
  className = "", onSelection, onScroll, changes = [], changeKind,
}, ref) {
  const reader = useRef<HTMLElement>(null), scroll = useRef<HTMLDivElement>(null), container = useRef<HTMLElement>(null);
  const editor = useRef<null>(null), findButton = useRef<HTMLButtonElement>(null);
  const [finding, setFinding] = useState(false), [raw, setRaw] = useState(false), [selection, setSelection] = useState<MappedSelection | null>(null);
  const id = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const highlight = "hetu-diff-" + id;
  const style = readingStyle(readingProfile(preferences, kind), 100, raw);
  useImperativeHandle(ref, () => ({reader: reader.current, scroll: scroll.current}));
  useLayoutEffect(() => {
    if (!reader.current || typeof CSS.highlights === "undefined" || !changes.length) return;
    const quotes = sourceQuotes(text, changes.filter(range => range.to > range.from));
    CSS.highlights.set(highlight, new Highlight(...readerRanges(reader.current, text, quotes.map(value => value.quote))));
    return () => { CSS.highlights.delete(highlight); };
  }, [text, raw, changes, highlight]);
  function select() {
    if (!reader.current) return;
    const value = mappedSourceSelection(reader.current, text);
    if (value) {setSelection(value); onSelection?.(value);}
  }
  function closeSearch() {setFinding(false); findButton.current?.focus();}
  return <section ref={container} className={"manuscript-reading reading-surface " + className} aria-label={label}
    data-document-theme={preferences.document_theme ?? "system"} data-change-kind={changeKind}
    style={style as React.CSSProperties} onKeyDown={event => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f" && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation(); setFinding(true);
      }
    }}>
    {changes.length > 0 && <style>{`::highlight(${highlight}) {background:var(--${changeKind === "delete" ? "diff-delete" : "diff-insert"},var(--jade-soft));color:var(--ink);text-decoration:${changeKind === "delete" ? "line-through" : "underline"};}`}</style>}
    <div className="manuscript-reading-tools">
      <button ref={findButton} type="button" aria-expanded={finding} onClick={() => setFinding(!finding)}>{searchLabel("search.title", language)}</button>
      {format !== "plain" && <button type="button" aria-pressed={raw} onClick={() => setRaw(!raw)}>{language === "en" ? "Source" : "原稿"}</button>}
    </div>
    <div className="manuscript-reading-scroll" ref={scroll} onScroll={onScroll} tabIndex={0} aria-label={label + (language === "en" ? " text" : "阅读区")}>
      {finding && <ManuscriptSearch source={text} format={format} title={title ?? ""} raw={raw} editing={false} disabled={false} selection={selection}
        reader={reader} editor={editor} scroll={scroll} language={language} highlights={noHighlights} close={closeSearch}/>}
      {format === "fountain" && !raw
        ? <ScreenplayText ref={reader} text={text} title={title ?? ""} onMouseUp={select} onKeyUp={select}/>
        : <ManuscriptText ref={reader} text={text} title={title} format={format === "markdown" && !raw ? "markdown" : "plain"} novel={kind === "novel" && !raw} onMouseUp={select} onKeyUp={select}/>}
    </div>
  </section>;
});
