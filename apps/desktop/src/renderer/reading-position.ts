import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { AnnotationSurface } from "./annotation-anchors.ts";
import { viewStorage } from "./view-storage.ts";
import { readerRange, sourceOffsets, type SourceQuote } from "./annotation-anchors.ts";
import type {SavedReadingPosition} from "../reading-state.ts";

export interface ReadingPosition {
  identity: string;
  quote?: SourceQuote;
  inset: number;
  top: number;
}

/** 显示位置只引用当前稿件；不按近似文字迁移到另一修订。 */
export function quoteAt(source: string, offset: number): SourceQuote | undefined {
  if (offset < 0 || offset >= source.length) return;
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(source[offset]) && /[\uD800-\uDBFF]/.test(source[offset - 1])) offset--;
  const quote = String.fromCodePoint(source.codePointAt(offset)!);
  const byte_start = new TextEncoder().encode(source.slice(0, offset)).length;
  return { byte_start, byte_end: byte_start + new TextEncoder().encode(quote).length, quote };
}

export function readerAnchor(element: HTMLElement, source: string, y: number): SourceQuote | undefined {
  const box = element.getBoundingClientRect();
  for (const fraction of [.1, .5, .3, .7, .9]) {
    const caret = document.caretRangeFromPoint(box.left + Math.max(4, box.width * fraction), y);
    if (!caret || !element.contains(caret.startContainer)) continue;
    const node = caret.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const span = node.parentElement?.closest<HTMLElement>("[data-source-from]");
    let offset: number;
    if (span) {
      const start = Number(span.dataset.sourceFrom), end = Number(span.dataset.sourceTo);
      if (span.textContent !== source.slice(start, end) || span.firstChild !== node) continue;
      offset = start + Math.min(caret.startOffset, Math.max(0, end - start - 1));
    } else {
      if (element.textContent !== source || element.firstChild !== node) continue;
      offset = Math.min(caret.startOffset, Math.max(0, source.length - 1));
    }
    const quote = quoteAt(source, offset);
    if (quote && readerRange(element, source, quote)?.[0]?.getBoundingClientRect().height) return quote;
  }
  return;
}


export function useReadingPosition({ storageKey, identity, source, editing, readOnly, reader, editor, scroll, composing, layoutKey, persist }: {
  storageKey: string; identity: string; source: string; editing: boolean; readOnly: boolean;
  reader: RefObject<HTMLElement>; editor: RefObject<AnnotationSurface>; scroll: RefObject<HTMLDivElement>;
  composing: boolean; layoutKey: string;
  persist?: (position: SavedReadingPosition) => void;
}) {
  const displayPosition = useRef<ReadingPosition>(), restoringPosition = useRef(false);
  const stored = useRef<{key: string; loaded: boolean; values: Record<string, ReadingPosition>}>({key: "", loaded: false, values: {}});
  if (stored.current.key !== storageKey || !stored.current.loaded && !!identity) {
    let values: Record<string, ReadingPosition> = {};
    try {
      const parsed = JSON.parse(viewStorage.getItem(storageKey) ?? "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values = Object.fromEntries(Object.entries(parsed as Record<string, ReadingPosition>).filter(([key, value]) => value?.identity === key && Number.isFinite(value.top) && Number.isFinite(value.inset)));
    } catch { /* 损坏的视图位置不影响正文，原作品始终不变。 */ }
    stored.current = {key: storageKey, loaded: !!identity, values};
    displayPosition.current = undefined;
  }
  const positions = stored.current.values;
  function readingRect(position: ReadingPosition) {
    if (!position.quote) return null;
    return editing && !readOnly ? editor.current?.rect(position.quote) : reader.current && readerRange(reader.current, source, position.quote)?.[0]?.getBoundingClientRect();
  }
  function capturePosition(targetIdentity = identity, transient = false) {
    const stage = scroll.current;
    if (!stage || !stage.clientHeight || !identity || restoringPosition.current) return;
    const top = stage.getBoundingClientRect().top;
    let quote, rect;
    for (let delta = 16; delta <= Math.min(160, stage.clientHeight / 2) && !quote; delta += 16) {
      const candidate = editing && !readOnly ? editor.current?.anchorAt?.(top + delta) : reader.current ? readerAnchor(reader.current, source, top + delta) : undefined;
      const bounds = candidate && readingRect({identity: targetIdentity, quote: candidate, top: stage.scrollTop, inset: 0});
      if (bounds?.height) {quote = candidate; rect = bounds;}
    }
    const value: ReadingPosition = { identity: targetIdentity, quote, top: stage.scrollTop, inset: 16 };
    if (rect) value.inset = rect.top - top;
    displayPosition.current = value;
    if (transient) return;
    delete positions[targetIdentity]; positions[targetIdentity] = value;
    for (const key of Object.keys(positions).slice(0, -100)) delete positions[key];
    viewStorage.setItem(storageKey, JSON.stringify(positions));
    persist?.(value);
  }
  const positionCallbacks = useRef({ capturePosition, restore: () => {} });
  positionCallbacks.current.capturePosition = capturePosition;
  useLayoutEffect(() => {
    const stage = scroll.current;
    if (!stage || !identity || composing) return;
    const value = displayPosition.current?.identity === identity ? displayPosition.current : positions[identity];
    displayPosition.current = undefined;
    const valid = value?.identity === identity ? value : undefined;
    restoringPosition.current = true;
    if (valid?.quote && editing && !readOnly) editor.current?.locate?.(valid.quote);
    else if (valid?.quote && reader.current) readerRange(reader.current, source, valid.quote, true);
    let frame = 0;
    let expectedTop = stage.scrollTop;
    const restore = () => {
      if (!restoringPosition.current) return;
      if (Math.abs(stage.scrollTop - expectedTop) > 1) {
        restoringPosition.current = false;
        positionCallbacks.current.capturePosition();
        return;
      }
      const rect = valid && readingRect(valid);
      if (rect) stage.scrollTop += rect.top - stage.getBoundingClientRect().top - valid!.inset;
      else stage.scrollTop = valid?.quote && !sourceOffsets(source, valid.quote) ? 0 : valid?.top ?? 0;
      expectedTop = stage.scrollTop;
    };
    restore();
    frame = requestAnimationFrame(() => { restore(); frame = requestAnimationFrame(() => { restore(); restoringPosition.current = false; positionCallbacks.current.capturePosition(); }); });
    positionCallbacks.current.restore = () => {
      if (restoringPosition.current || !stage.clientHeight) return;
      const saved = positions[identity];
      const rect = saved && readingRect(saved);
      if (rect) stage.scrollTop += rect.top - stage.getBoundingClientRect().top - saved.inset;
    };
    return () => { cancelAnimationFrame(frame); restoringPosition.current = false; };
  }, [storageKey, identity, editing, readOnly, layoutKey, composing]);
  useEffect(() => {
    const stage = scroll.current;
    if (!stage) return;
    let frame = 0;
    const resized = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => positionCallbacks.current.restore()); };
    const observer = new ResizeObserver(resized); observer.observe(stage);
    document.fonts.addEventListener("loadingdone", resized);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); document.fonts.removeEventListener("loadingdone", resized); };
  }, [!!identity]);
  return capturePosition;
}
