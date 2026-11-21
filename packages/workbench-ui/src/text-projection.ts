import {manuscriptFormat, type TextSpan} from "./manuscript-format.ts";
import {parseFountain, screenplayBody, fountainRuns} from "./fountain.ts";

export interface ProjectedSpan extends TextSpan { offset: number; length?: number }
export interface TextProjection { text: string; spans: ProjectedSpan[] }

/** 搜索、复制和定位共用可见文本；范围仍指向未经重写的原稿。 */
export function textProjection(source: string, format: string, title = "", raw = false): TextProjection {
  if (raw || !["markdown", "fountain"].includes(format)) {
    if (!source.includes("\r")) return {text: source, spans: [{from: 0, to: source.length, offset: 0}]};
    const spans: ProjectedSpan[] = [], parts: string[] = [];
    let from = 0, offset = 0;
    for (const separator of source.matchAll(/\r\n?|\n/g)) {
      const to = separator.index!;
      if (to > from) {parts.push(source.slice(from, to)); spans.push({from, to, offset}); offset += to - from;}
      parts.push("\n"); spans.push({from: to, to: to + separator[0].length, offset, length: 1}); offset++; from = to + separator[0].length;
    }
    if (from < source.length) {parts.push(source.slice(from)); spans.push({from, to: source.length, offset});}
    return {text: parts.join(""), spans};
  }
  const rows = format === "markdown" ? manuscriptFormat(source, title).lines.filter(line => !line.hidden).map(line => ({runs: line.runs, to: line.to, breakTo: line.breakTo}))
    : screenplayBody(parseFountain(source), source, title).map(line => ({runs: fountainRuns(source, line.textFrom, line.textTo), to: line.to,
      breakTo: line.to + (source.slice(line.to).match(/^(\r\n?|\n)/)?.[0].length ?? 0)}));
  const chunks: string[] = [], spans: ProjectedSpan[] = [];
  let offset = 0;
  for (const [index, row] of rows.entries()) {
    if (index) {
      const previous = rows[index - 1]; chunks.push("\n");
      if (previous.breakTo > previous.to) spans.push({from: previous.to, to: previous.breakTo, offset, length: 1});
      offset++;
    }
    for (const run of row.runs) { chunks.push(source.slice(run.from, run.to)); spans.push({from: run.from, to: run.to, offset}); offset += run.to - run.from; }
  }
  return {text: chunks.join(""), spans};
}

export function projectedRange(projection: TextProjection, from: number, to: number) {
  if (to <= from) return;
  function containing(position: number, end: boolean) {
    let low = 0, high = projection.spans.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1, span = projection.spans[mid], limit = span.offset + (span.length ?? span.to - span.from);
      if (position < span.offset || end && position === span.offset) high = mid - 1;
      else if (position > limit || !end && position === limit) low = mid + 1;
      else return span;
    }
    return undefined;
  }
  const start = containing(from, false), end = containing(to, true);
  if (!start || !end) return;
  const sourceFrom = start.from + from - start.offset, sourceTo = end.length !== undefined && to === end.offset + end.length ? end.to : end.from + to - end.offset;
  return {from: sourceFrom, to: sourceTo};
}
