export interface SourceQuote { byte_start: number; byte_end: number; quote: string }
export const manuscriptLayoutEvent = "hetu-manuscript-layout";
export interface DocumentNote { id: string; text: string; resolved: boolean; source_ref: SourceQuote & {document_id: string; revision_id: string} }
export interface AnnotationSurface {
  rect: (quote: SourceQuote) => DOMRect | null;
  reveal: (quote: SourceQuote) => void;
  contains: (quote: SourceQuote, x: number, y: number) => boolean;
  anchorAt?: (y: number) => SourceQuote | undefined;
  locate?: (quote: SourceQuote) => void;
}

const located = new WeakMap<SourceQuote, {source: string; offsets: {from: number; to: number} | null}>();

/** 批量来源范围只扫描一次前缀字节，同时供高亮复用已核验的字符位置。 */
export function sourceQuotes<T extends {from: number; to: number}>(source: string, ranges: T[]): (T & {quote: SourceQuote})[] {
  const offsets = [...new Set(ranges.flatMap(range => [range.from, range.to]))].sort((a, b) => a - b), bytes = new Map<number, number>();
  let cursor = 0, total = 0;
  for (const offset of offsets) {
    if (offset < 0 || offset > source.length || offset > 0 && /[\uDC00-\uDFFF]/.test(source[offset] ?? "")) throw new Error("来源范围未处于完整Unicode字符边界。");
    total += new TextEncoder().encode(source.slice(cursor, offset)).length; bytes.set(offset, total); cursor = offset;
  }
  return ranges.map(range => {
    const quote = {byte_start: bytes.get(range.from)!, byte_end: bytes.get(range.to)!, quote: source.slice(range.from, range.to)};
    located.set(quote, {source, offsets: {from: range.from, to: range.to}});
    return {...range, quote};
  });
}

/** 仅定位同一固定原文，不能按相同文本猜测或迁移历史坐标。 */
export function sourceOffsets(source: string, quote: SourceQuote) {
  const cached = located.get(quote);
  if (cached?.source === source) return cached.offsets;
  const bytes = new TextEncoder().encode(source);
  if (quote.byte_start < 0 || quote.byte_end > bytes.length || quote.byte_end <= quote.byte_start) return null;
  const decoder = new TextDecoder("utf-8", {fatal: true});
  try {
    if (decoder.decode(bytes.subarray(quote.byte_start, quote.byte_end)) !== quote.quote) return null;
    const offsets = {from: decoder.decode(bytes.subarray(0, quote.byte_start)).length, to: decoder.decode(bytes.subarray(0, quote.byte_end)).length};
    located.set(quote, {source, offsets});
    return offsets;
  } catch { return null; }
}

export function readerRanges(element: HTMLElement, source: string, quotes: SourceQuote[]) {
  const spans = [...element.querySelectorAll<HTMLElement>("[data-source-from]")].filter(span => !span.classList.contains("manuscript-break") && !!span.firstChild
    && span.textContent === source.slice(Number(span.dataset.sourceFrom), Number(span.dataset.sourceTo)));
  const ranges: Range[] = [];
  for (const quote of quotes) {
    const offsets = sourceOffsets(source, quote); if (!offsets) continue;
    if (spans.length) {
      let low = 0, high = spans.length;
      while (low < high) {const mid = (low + high) >> 1; if (Number(spans[mid].dataset.sourceTo) <= offsets.from) low = mid + 1; else high = mid;}
      for (let index = low; index < spans.length; index++) {
        const span = spans[index];
        const start = Number(span.dataset.sourceFrom), end = Number(span.dataset.sourceTo);
        if (start >= offsets.to) break;
        const from = Math.max(start, offsets.from), to = Math.min(end, offsets.to);
        if (to <= from) continue;
        const range = document.createRange();
        range.setStart(span.firstChild!, from - start); range.setEnd(span.firstChild!, to - start); ranges.push(range);
      }
    } else if (element.textContent === source && element.firstChild?.nodeType === Node.TEXT_NODE) {
      const range = document.createRange(); range.setStart(element.firstChild, offsets.from); range.setEnd(element.firstChild, offsets.to); ranges.push(range);
    }
  }
  return ranges;
}

export function readerRange(element: HTMLElement, source: string, quote: SourceQuote, reveal = false) {
  const offsets = sourceOffsets(source, quote);
  if (!offsets) return null;
  if (reveal) for (const group of element.querySelectorAll<HTMLDetailsElement>("details[data-group-from]")) {
    const open = Number(group.dataset.groupFrom) <= offsets.from && Number(group.dataset.groupTo) >= offsets.to;
    if (group.open !== open) {group.dataset.programmatic = "true"; group.open = open;}
  }
  return readerRanges(element, source, [quote]);
}
