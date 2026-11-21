import {Transaction} from "@codemirror/state";
import {isolateHistory} from "@codemirror/commands";
import {ensureSyntaxTree, syntaxTree} from "@codemirror/language";
import type {EditorView} from "@codemirror/view";
import {manuscriptFormat} from "@hetu/workbench-ui/manuscript-format";
import {manuscriptStyles, presentationTag, validCard, cardKeys, type BlockPresentation, type CardPresentation, type StyledSpan} from "@hetu/workbench-ui/manuscript-styles";
import {manuscriptGroups} from "@hetu/workbench-ui/manuscript-groups";
import type {CardEdit} from "@hetu/workbench-ui/card-configuration";
import {styledDocument} from "./styled-markdown.ts";
import {inlineInputIntent, inputStyleIntent} from "./inline-input.ts";

type Edit = {from: number; to: number; insert: string; position?: (value: number) => number};
type ParagraphRange = {from: number; to: number};
function paragraphAt(view: EditorView, position: number): ParagraphRange | null {
  const line = view.state.doc.lineAt(position);
  if (!line.text.trim()) return {from: line.from, to: line.to};
  let node = (ensureSyntaxTree(view.state, line.to, 30) ?? syntaxTree(view.state)).resolveInner(position, position === line.to ? -1 : 1);
  for (;;) {
    if (["FencedCode", "CodeBlock", "HTMLBlock"].includes(node.name)) return null;
    if (node.name === "Paragraph" || /^(?:ATX|Setext)Heading[1-6]$/.test(node.name)) return {from: view.state.doc.lineAt(node.from).from, to: view.state.doc.lineAt(node.to).to};
    if (!node.parent) return null;
    node = node.parent;
  }
}
function containsOnly(view: EditorView, span: StyledSpan, range: ParagraphRange) {
  return span.contentFrom <= range.from && span.contentTo >= range.to
    && !view.state.sliceDoc(span.contentFrom, range.from).trim() && !view.state.sliceDoc(range.to, span.contentTo).trim();
}
function updateContainer(view: EditorView, span: StyledSpan, patch: BlockPresentation): Edit[] {
  const attributes = {...span.attributes, ...patch};
  if (attributes.block !== "card") for (const key of cardKeys) delete attributes[key];
  const opening = presentationTag("div", attributes);
  if (opening) return opening === view.state.sliceDoc(span.opening.from, span.opening.to) ? [] : [{...span.opening, insert: opening}];
  const original = view.state.sliceDoc(span.contentFrom, span.contentTo);
  const before = original.startsWith("\n\n") ? 2 : original.startsWith("\n") ? 1 : 0;
  const after = original.endsWith("\n\n") ? 2 : original.endsWith("\n") ? 1 : 0;
  return [{from: span.from, to: span.contentFrom + before, insert: ""},
    {from: span.contentFrom + Math.max(before, original.length - after), to: span.to, insert: ""}];
}

/** 弹窗固定原文与卡片范围；导航可继续，正文变化后不能套用旧预览。 */
export function captureCardPresentation(view: EditorView, position = view.state.selection.main.head): CardEdit | undefined {
  if (view.composing || view.state.readOnly) return;
  const document = view.state.doc, source = document.toString();
  const format = view.state.field(styledDocument, false)?.format;
  if (!format) return;
  const group = manuscriptGroups(source, format).filter(group => group.kind === "card" && group.from <= position && group.to >= position).at(-1);
  if (!group) return;
  return {group, apply(value: CardPresentation) {
    if (view.state.doc !== document || view.composing || view.state.readOnly || !validCard({block: "card", ...value})) return false;
    const edits = updateContainer(view, group, {...Object.fromEntries(cardKeys.map(key => [key, undefined])), ...value});
    if (!edits.length) return true;
    const changes = view.state.changes(edits);
    view.dispatch({changes, selection: view.state.selection.map(changes), annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")]});
    return true;
  }};
}
function wrapRange(range: ParagraphRange, patch: BlockPresentation): Edit[] {
  const opening = presentationTag("div", patch) + "\n\n";
  return [{from: range.from, to: range.from, insert: opening, position: () => opening.length},
    {from: range.to, to: range.to, insert: "\n\n</div>", position: () => 0}];
}

/** 对齐以段落为单位；分组保留原文和内层结构，取消时只移除对应容器。 */
export function setBlockPresentation(view: EditorView, patch: BlockPresentation) {
  if (view.composing || view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
  if (patch.alignment && !manuscriptStyles.alignments.includes(patch.alignment) || patch.block && !manuscriptStyles.blocks.includes(patch.block)) return false;
  const selection = view.state.selection.main, source = view.state.doc.toString();
  const format = view.state.field(styledDocument, false)?.format ?? manuscriptFormat(source);
  const containers = format.markup.spans.filter(span => span.tag === "div");
  const hiddenLines = new Set(format.lines.filter(line => line.hidden).map(line => line.from));
  const first = view.state.doc.lineAt(selection.from), last = view.state.doc.lineAt(selection.to > selection.from ? selection.to - 1 : selection.to);
  const paragraphs: ParagraphRange[] = [];
  for (let number = first.number; number <= last.number; number++) {
    const line = view.state.doc.line(number);
    if (!selection.empty && !line.text.trim() || hiddenLines.has(line.from)) continue;
    const range = paragraphAt(view, Math.max(line.from, Math.min(line.to, selection.from)));
    if (range && !paragraphs.some(value => value.from === range.from && value.to === range.to)) paragraphs.push(range);
  }
  if (!paragraphs.length) return false;
  let edits: Edit[] = [];
  if (Object.hasOwn(patch, "block")) {
    const current = containers.filter(span => span.contentFrom <= selection.from && span.contentTo >= selection.to && span.attributes.block).at(-1);
    const range = {from: paragraphs[0].from, to: paragraphs.at(-1)!.to};
    const reusable = current ?? containers.filter(span => containsOnly(view, span, range)).at(-1);
    if (reusable) edits = updateContainer(view, reusable, patch);
    else if (patch.block) {
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const span of containers) if (span.from < range.to && span.to > range.from && !(span.contentFrom <= range.from && span.contentTo >= range.to)) {
          const from = Math.min(range.from, span.from), to = Math.max(range.to, span.to);
          if (from !== range.from || to !== range.to) {range.from = from; range.to = to; expanded = true;}
        }
      }
      edits = wrapRange(range, patch);
    }
  } else for (const range of paragraphs) {
    const reusable = containers.filter(span => containsOnly(view, span, range)).at(-1);
    if (reusable) edits.push(...updateContainer(view, reusable, patch));
    else if (patch.alignment) edits.push(...wrapRange(range, patch));
  }
  if (!edits.length) return true;
  edits.sort((a, b) => a.from - b.from);
  const changes = view.state.changes(edits), next = changes.apply(view.state.doc).toString();
  if ((patch.block || patch.alignment) && !manuscriptFormat(next).markup.spans.length) return false;
  function mapped(position: number) {
    let delta = 0;
    for (const edit of edits) {
      if (position < edit.from) break;
      if (position <= edit.to) return edit.from + delta + (edit.position ? edit.position(position) : Math.min(position - edit.from, edit.insert.length));
      delta += edit.insert.length - (edit.to - edit.from);
    }
    return position + delta;
  }
  const intent = selection.empty && view.state.field(inlineInputIntent, false);
  view.dispatch({changes, selection: {anchor: mapped(selection.anchor), head: mapped(selection.head)},
    effects: intent ? inputStyleIntent.of({...intent, position: mapped(selection.head)}) : [],
    annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")], scrollIntoView: true});
  view.focus(); return true;
}
