import {parser, Strikethrough, TaskList} from "@lezer/markdown";
import type {SyntaxNode} from "@lezer/common";
import {manuscriptLines, type ManuscriptLine} from "./manuscript-lines.ts";
import {markdownStyleMarkup, presentationAt, type ManuscriptPresentation, type StyleMarkup} from "./manuscript-styles.ts";

export interface TextSpan { from: number; to: number }
export const manuscriptMarkdownExtensions = [Strikethrough, TaskList];
const manuscriptParser = parser.configure(manuscriptMarkdownExtensions);
export interface ManuscriptRun extends TextSpan { styles: ("strong" | "emphasis" | "code" | "strike")[]; attributes?: ManuscriptPresentation }
export interface FormattedLine extends ManuscriptLine {
  kind: "prose" | "heading" | "quote" | "code" | "rule" | "raw";
  level?: number;
  hidden?: boolean;
  marker?: string;
  runs: ManuscriptRun[];
  attributes?: ManuscriptPresentation;
}
export interface ManuscriptFormat { lines: FormattedLine[]; hidden: TextSpan[]; styles: (TextSpan & {style: ManuscriptRun["styles"][number]})[]; markup: StyleMarkup }

/** 仅隐藏语法树确认的结构；片段始终直接对应原稿，不解码后再猜位置。 */
export function manuscriptFormat(source: string, title = ""): ManuscriptFormat {
  // 保持UTF-16位置不变，让解析器正确识别CRLF和单独CR的段落边界。
  const tree = manuscriptParser.parse(source.replace(/\r(?=\n)/g, " ").replace(/\r/g, "\n")), physical = manuscriptLines(source);
  const hidden: TextSpan[] = [], styles: ManuscriptFormat["styles"] = [];
  const blocks: {from: number; to: number; kind: FormattedLine["kind"]; level?: number}[] = [];
  const hiddenLines = new Set<number>();
  const markup = markdownStyleMarkup(source, tree);
  const listMarkers = new Map<number, string>();
  const lineAt = (offset: number) => {
    let low = 0, high = physical.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (physical[mid].from <= offset) low = mid; else high = mid - 1; }
    return physical[low];
  };
  function hide(from: number, to: number) { if (to > from) hidden.push({from, to}); }
  function visit(node: SyntaxNode) {
    const name = node.name;
    if (["HTMLBlock", "HTMLTag", "Link", "Image", "LinkReference"].includes(name)) return;
    if (name === "StrongEmphasis" || name === "Emphasis" || name === "InlineCode" || name === "Strikethrough") styles.push({from: node.from, to: node.to, style: name === "StrongEmphasis" ? "strong" : name === "Emphasis" ? "emphasis" : name === "Strikethrough" ? "strike" : "code"});
    if (/^(?:ATX|Setext)Heading[1-6]$/.test(name)) blocks.push({from: node.from, to: node.to, kind: "heading", level: Number(name.at(-1))});
    if (name === "Blockquote") blocks.push({from: node.from, to: node.to, kind: "quote"});
    if (name === "FencedCode" || name === "CodeBlock") blocks.push({from: node.from, to: node.to, kind: "code"});
    if (name === "HorizontalRule") { blocks.push({from: node.from, to: node.to, kind: "rule"}); hide(node.from, node.to); }
    if (name === "EmphasisMark" || name === "StrikethroughMark") hide(node.from, node.to);
    if (name === "ListMark" || name === "TaskMarker") {
      const line = lineAt(node.from);
      listMarkers.set(line.from, name === "TaskMarker" ? /[xX]/.test(source.slice(node.from, node.to)) ? "☑" : "☐" : /^\d/.test(source.slice(node.from, node.to)) ? source.slice(node.from, node.to) : "•");
      let end = node.to; while (end < line.to && /[ \t]/.test(source[end])) end++;
      hide(node.from, end);
    }
    if (name === "Escape") hide(node.from, node.from + 1);
    if (name === "QuoteMark") hide(node.from, node.to + (source[node.to] === " " ? 1 : 0));
    if (name === "HeaderMark") {
      if (node.parent?.name.startsWith("Setext")) { const line = lineAt(node.from); hiddenLines.add(line.from); hide(line.from, line.to); }
      else {
        const leading = node.from === node.parent?.from;
        let from = node.from, to = node.to;
        if (leading) while (to < source.length && /[ \t]/.test(source[to])) to++;
        else while (from > 0 && /[ \t]/.test(source[from - 1])) from--;
        hide(from, to);
      }
    }
    if (name === "CodeMark") {
      if (node.parent?.name === "FencedCode") { const line = lineAt(node.from); hiddenLines.add(line.from); hide(line.from, line.to); }
      else hide(node.from, node.to);
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  }
  visit(tree.topNode);
  for (const marker of markup.markers) hide(marker.from, marker.to);
  for (const span of markup.spans.filter(span => span.tag === "div")) {
    hiddenLines.add(lineAt(span.opening.from).from); hiddenLines.add(lineAt(span.closing.from).from);
  }
  hidden.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: TextSpan[] = [];
  for (const span of hidden) {
    const last = merged.at(-1);
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to); else merged.push({...span});
  }
  const first = tree.topNode.firstChild;
  if (title.trim() && first && /^(?:ATX|Setext)Heading1$/.test(first.name)) {
    let visible = "", offset = first.from;
    for (const mark of merged.filter(mark => mark.from < first.to && mark.to > first.from)) { visible += source.slice(offset, Math.max(offset, mark.from)); offset = Math.max(offset, mark.to); }
    visible += source.slice(offset, first.to);
    if (visible.trim() === title.trim()) for (const line of physical) if (line.from >= first.from && line.from < first.to) hiddenLines.add(line.from);
  }
  blocks.sort((a, b) => a.from - b.from || b.to - a.to);
  styles.sort((a, b) => a.from - b.from || b.to - a.to);
  let blockIndex = 0, hiddenIndex = 0, styleIndex = 0;
  let activeBlocks: typeof blocks = [], activeHidden: TextSpan[] = [], activeStyles: typeof styles = [];
  const lines: FormattedLine[] = physical.map(line => {
    activeBlocks = activeBlocks.filter(block => block.to > line.from);
    activeHidden = activeHidden.filter(mark => mark.to > line.from);
    activeStyles = activeStyles.filter(style => style.to > line.from);
    while (blockIndex < blocks.length && blocks[blockIndex].from <= line.to) activeBlocks.push(blocks[blockIndex++]);
    while (hiddenIndex < merged.length && merged[hiddenIndex].from < line.to) activeHidden.push(merged[hiddenIndex++]);
    while (styleIndex < styles.length && styles[styleIndex].from < line.to) activeStyles.push(styles[styleIndex++]);
    const block = activeBlocks.at(-1);
    const kind = block?.kind ?? (line.prose ? "prose" : "raw");
    const cuts = new Set([line.from, line.to]);
    for (const range of [...activeHidden, ...activeStyles]) if (range.from < line.to && range.to > line.from) { cuts.add(Math.max(line.from, range.from)); cuts.add(Math.min(line.to, range.to)); }
    const offsets = [...cuts].sort((a, b) => a - b), runs: ManuscriptRun[] = [];
    for (let i = 1; i < offsets.length; i++) {
      const from = offsets[i - 1], to = offsets[i];
      if (to <= from || activeHidden.some(mark => mark.from <= from && mark.to >= to)) continue;
      const attributes = presentationAt(markup, from, to);
      runs.push({from, to, styles: activeStyles.filter(style => style.from <= from && style.to >= to).map(style => style.style), ...(Object.keys(attributes).length ? {attributes} : {})});
    }
    const attributes = presentationAt(markup, line.from);
    return {...line, kind, level: block?.level, hidden: hiddenLines.has(line.from), marker: listMarkers.get(line.from), runs, ...(Object.keys(attributes).length ? {attributes} : {})};
  });
  return {lines, hidden: merged, styles, markup};
}

/** 搜索和复制可以消费相同的可见文本，语法标记不会混入内容索引。 */
export function manuscriptVisibleText(source: string, format = manuscriptFormat(source)) {
  return format.lines.filter(line => !line.hidden).map(line => line.runs.map(run => source.slice(run.from, run.to)).join("")).join("\n");
}
