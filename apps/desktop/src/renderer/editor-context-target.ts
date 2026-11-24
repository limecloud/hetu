import {EditorSelection, Transaction, type EditorState} from "@codemirror/state";
import {isolateHistory, indentMore, indentLess} from "@codemirror/commands";
import {ensureSyntaxTree, language, syntaxTree} from "@codemirror/language";
import type {EditorView} from "@codemirror/view";
import {editorSource, editorSourceRange, editorSourceSelection, editorSourcePositions, editorClipboardText, restoreEditorSource} from "./editor-source.ts";
import {groupView} from "./grouped-markdown.ts";
import {styledDocument} from "./styled-markdown.ts";
import {runTextCommand, insertPlainText, type TextCommand, type TextFormat} from "./text-commands.ts";
import {setInlinePresentation} from "./inline-input.ts";
import {setBlockPresentation, captureCardPresentation} from "./block-format.ts";
import type {InlinePresentation, BlockPresentation} from "@hetu/workbench-ui/manuscript-styles";
import type {EditorContext} from "./editor.tsx";
import {manuscriptFormat} from "@hetu/workbench-ui/manuscript-format";

export type BlockOperation = "duplicate" | "delete" | "above" | "below" | "up" | "down";
interface Range {from: number; to: number}
interface BlockChange extends Range {insert: string; source: string; cursor: number; selection?: {anchor: number; head: number}}
function scopeOf(state: EditorState) {
  const groups = state.field(groupView, false), active = groups?.groups.find(group => group.from === groups.focus);
  return {groups, active, from: active?.bodyFrom ?? 0, to: active?.bodyTo ?? state.doc.length};
}

/** 原子分组与代码围栏不能因右键命中一行而被拆坏。 */
function contextSyntaxTree(state: EditorState) {
  const tree = state.facet(language) ? ensureSyntaxTree(state, state.doc.length, 250) : syntaxTree(state);
  if (!tree) throw new Error("文稿结构还在解析，请稍后再打开段落菜单。");
  return tree;
}
export function contextBlockRange(state: EditorState, selection: Range = state.selection.main): Range {
  const tree = contextSyntaxTree(state);
  const scope = scopeOf(state);
  const group = scope.groups?.groups.find(group => group !== scope.active && group.from >= scope.from && group.to <= scope.to && selection.from === group.from && selection.to === group.to);
  if (group) return {from: group.from, to: group.to};
  const first = state.doc.lineAt(selection.from), atEnd = state.doc.lineAt(selection.to);
  const last = selection.to > selection.from && selection.to === atEnd.from ? state.doc.line(atEnd.number - 1) : atEnd;
  let from = Math.max(scope.from, first.from), to = Math.min(scope.to, last.to);
  for (const position of [selection.from, Math.max(selection.from, selection.to - 1)]) {
    let node = tree.resolveInner(position, position === state.doc.lineAt(position).to ? -1 : 1);
    for (; node.parent; node = node.parent) if (atomicBlock(node.name)) {
      from = Math.max(scope.from, Math.min(from, state.doc.lineAt(node.from).from));
      to = Math.min(scope.to, Math.max(to, state.doc.lineAt(node.to).to)); break;
    }
  }
  // 块样式和分组的开闭标记与内文属于同一个可移动范围。
  const containers = state.field(styledDocument, false)?.markup.spans.filter(span => span.tag === "div" && span.from >= scope.from && span.to <= scope.to) ?? [];
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const span of containers) if (span.from < to && span.to > from && (span.from < from || span.to > to)) {
      from = Math.min(from, state.doc.lineAt(span.from).from); to = Math.max(to, state.doc.lineAt(span.to).to); expanded = true;
    }
  }
  return {from, to};
}

function atomicBlock(name: string) {
  return ["FencedCode", "CodeBlock", "ListItem", "Blockquote"].includes(name) || name.startsWith("SetextHeading");
}

function sortableBlocks(state: EditorState): Range[] {
  if (state.selection.main.empty) return [];
  const scope = scopeOf(state), selected = contextBlockRange(state);
  let from = Math.max(selected.from, scope.from), to = Math.min(selected.to, scope.to);
  if (scope.active?.titleLine) {
    const title = contextBlockRange(state, scope.active.titleLine), line = state.doc.lineAt(title.to);
    from = Math.max(from, line.number < state.doc.lines ? state.doc.line(line.number + 1).from : scope.to);
  }
  if (from > to) return [];
  const protectedRanges: Range[] = [];
  contextSyntaxTree(state).iterate({from, to, enter(node) {
    if (!atomicBlock(node.name) || node.from < from || node.to > to) return;
    protectedRanges.push({from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.to).to}); return false;
  }});
  for (const span of state.field(styledDocument, false)?.markup.spans ?? []) if (span.tag === "div" && span.from >= from && span.to <= to)
    protectedRanges.push({from: state.doc.lineAt(span.from).from, to: state.doc.lineAt(span.to).to});
  const merged: Range[] = [];
  for (const range of protectedRanges.sort((a, b) => a.from - b.from || b.to - a.to)) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({...range});
  }
  const result: Range[] = [];
  let protectedIndex = 0;
  for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number;) {
    const line = state.doc.line(number);
    while (protectedIndex < merged.length && merged[protectedIndex].to < line.from) protectedIndex++;
    const protectedRange = merged[protectedIndex], range = protectedRange && protectedRange.from <= line.from
      ? {from: Math.max(from, protectedRange.from), to: Math.min(to, protectedRange.to)} : {from: Math.max(from, line.from), to: Math.min(to, line.to)};
    result.push(range); number = state.doc.lineAt(range.to).number + 1;
  }
  return result;
}

/** 排序原始完整块；分隔槽保持原字节，比较只消费一次可见文本投影。 */
export function contextBlockSort(state: EditorState, direction: "ascending" | "descending", format: TextFormat = "markdown", raw = false, language = "zh-CN", blocks = sortableBlocks(state)): BlockChange | null {
  if (blocks.length < 2) return null;
  const source = state.field(editorSource), offset = editorSourcePositions(state), logical = state.doc.toString();
  const locale = language === "en" ? "en" : "zh-CN";
  const formatted = format === "markdown" && !raw ? manuscriptFormat(logical) : undefined;
  const groups = new Map((state.field(groupView, false)?.groups ?? []).map(group => [group.from, group]));
  let lineIndex = 0;
  const values = blocks.map((block, index) => {
    const from = offset(block.from), to = offset(block.to), group = groups.get(block.from);
    let key = logical.slice(block.from, block.to);
    if (formatted) {
      const lines: string[] = [];
      while (lineIndex < formatted.lines.length && formatted.lines[lineIndex].from < block.from) lineIndex++;
      while (lineIndex < formatted.lines.length && formatted.lines[lineIndex].from <= block.to) {
        const line = formatted.lines[lineIndex++];
        if (!line.hidden) lines.push(line.runs.map(run => logical.slice(run.from, run.to)).join(""));
      }
      key = group?.to === block.to ? group.title : lines.join("\n");
    }
    return {index, from, to, content: source.slice(from, to), key: key.trim().toLocaleLowerCase(locale).toLocaleUpperCase(locale).toLocaleLowerCase(locale)};
  });
  const collator = new Intl.Collator(locale, {usage: "sort", numeric: false, sensitivity: "accent"});
  const ordered = [...values].sort((a, b) => collator.compare(a.key, b.key) || a.index - b.index);
  if (direction === "descending") ordered.reverse();
  if (ordered.every((value, index) => value.index === index)) return null;
  const from = values[0].from, to = values.at(-1)!.to;
  const insert = ordered.map((value, index) => value.content + (index < values.length - 1 ? source.slice(values[index].to, values[index + 1].from) : "")).join("");
  if (insert === source.slice(from, to)) return null;
  const selection = state.selection.main.anchor > state.selection.main.head ? {anchor: blocks.at(-1)!.to, head: blocks[0].from} : {anchor: blocks[0].from, head: blocks.at(-1)!.to};
  return {from, to, insert, source: source.slice(0, from) + insert + source.slice(to), cursor: selection.head, selection};
}

export function contextBlockEdit(state: EditorState, operation: Exclude<BlockOperation, "up" | "down">, block = contextBlockRange(state)): BlockChange {
  const source = state.field(editorSource), raw = editorSourceRange(state, block.from, block.to), scope = scopeOf(state);
  const limits = editorSourceRange(state, scope.from, scope.to);
  const newline = source.match(/\r\n?|\n/)?.[0] ?? "\n", content = source.slice(raw.from, raw.to);
  let from = raw.from, to = raw.to, insert = "", cursor = block.from;
  if (operation === "duplicate") {
    const gap = source.slice(raw.to, limits.to).match(/^(?:\r\n|\r|\n){1,2}/)?.[0] ?? newline;
    from = to; insert = gap + content; cursor = block.to + gap.replace(/\r\n?/g, "\n").length;
  } else if (operation === "above") {to = from; insert = newline;}
  else if (operation === "below") {from = to; insert = newline; cursor = block.to + 1;}
  else {
    const after = source.slice(to, limits.to).match(/^(?:\r\n|\r|\n){1,2}/)?.[0];
    if (after) to += after.length;
    else from -= source.slice(limits.from, from).match(/(?:\r\n|\r|\n){1,2}$/)?.[0].length ?? 0;
    cursor = source.slice(0, from).replace(/\r\n?/g, "\n").length;
  }
  return {from, to, insert, source: source.slice(0, from) + insert + source.slice(to), cursor};
}

function adjacentBlock(state: EditorState, direction: "up" | "down", block: Range) {
  const scope = scopeOf(state), step = direction === "up" ? -1 : 1;
  let number = state.doc.lineAt(direction === "up" ? block.from : block.to).number + step;
  for (; number > 0 && number <= state.doc.lines; number += step) {
    const line = state.doc.line(number);
    if (line.from < scope.from || line.to > scope.to) return null;
    if (!line.text.trim()) continue;
    const next = contextBlockRange(state, {from: line.from, to: line.to});
    return next.from >= scope.from && next.to <= scope.to && (next.to < block.from || next.from > block.to) ? next : null;
  }
  return null;
}

/** 交换完整原文片段和中间分隔，不重排混合换行或内页外围字节。 */
export function contextBlockMove(state: EditorState, direction: "up" | "down", block = contextBlockRange(state)): BlockChange | null {
  const neighbor = adjacentBlock(state, direction, block);
  if (!neighbor) return null;
  const source = state.field(editorSource), raw = editorSourceRange(state, block.from, block.to), other = editorSourceRange(state, neighbor.from, neighbor.to);
  const current = source.slice(raw.from, raw.to), adjacent = source.slice(other.from, other.to);
  const from = Math.min(raw.from, other.from), to = Math.max(raw.to, other.to);
  const gap = direction === "up" ? source.slice(other.to, raw.from) : source.slice(raw.to, other.from);
  const insert = direction === "up" ? current + gap + adjacent : adjacent + gap + current;
  const destination = direction === "up" ? neighbor.from : block.from + (adjacent + gap).replace(/\r\n?/g, "\n").length;
  const move = (position: number) => destination + Math.min(block.to - block.from, Math.max(0, position - block.from));
  const selection = {anchor: move(state.selection.main.anchor), head: move(state.selection.main.head)};
  return {from, to, insert, source: source.slice(0, from) + insert + source.slice(to), cursor: selection.head, selection};
}

export function captureEditorContext(view: EditorView, format: TextFormat, raw: boolean, context: EditorContext) {
  if (view.composing) return;
  const document = view.state.doc, selection = view.state.selection, state = view.state;
  const block = contextBlockRange(state), range = selection.main.empty ? block : selection.main;
  const valid = () => view.dom.isConnected && !view.composing && view.state.readOnly === state.readOnly && view.state.doc === document && view.state.selection.eq(selection);
  const requireCurrent = () => {if (!valid()) throw new Error("正文或选区已变化，请重新打开右键菜单。");};
  const sorting = sortableBlocks(state);
  function apply(change: BlockChange | null, event = "input.block") {
    if (!change) return false;
    const logical = (offset: number) => state.field(editorSource).slice(0, offset).replace(/\r\n?/g, "\n").length;
    view.dispatch({changes: {from: logical(change.from), to: logical(change.to), insert: change.insert.replace(/\r\n?/g, "\n")},
      effects: restoreEditorSource.of(change.source), selection: change.selection ?? EditorSelection.cursor(Math.min(change.cursor, change.source.replace(/\r\n?/g, "\n").length)),
      annotations: [Transaction.userEvent.of(event), isolateHistory.of("full")]});
    view.focus(); return true;
  }
  function edit(operation: BlockOperation) {
    requireCurrent(); if (view.state.readOnly) return false;
    return apply(operation === "up" || operation === "down" ? contextBlockMove(state, operation, block) : contextBlockEdit(state, operation, block), operation === "delete" ? "delete.block" : "input.block");
  }
  return {
    context, valid, requireCurrent, empty: selection.main.empty, readOnly: state.readOnly, block,
    canMoveUp: !!adjacentBlock(state, "up", block), canMoveDown: !!adjacentBlock(state, "down", block),
    canSort: sorting.length > 1,
    sortBlocks(direction: "ascending" | "descending", language?: string) {
      requireCurrent(); if (view.state.readOnly) return false;
      return apply(contextBlockSort(state, direction, format, raw, language, sorting));
    },
    text: editorClipboardText(state, range.from, range.to, format === "markdown" && !raw),
    sourceText: editorSourceSelection(state, range.from, range.to).quote,
    quote: editorSourceSelection(state, range.from, range.to),
    blockQuote: editorSourceSelection(state, block.from, block.to),
    command(command: TextCommand) {requireCurrent(); return runTextCommand(view, command, format);},
    indent(more: boolean) {requireCurrent(); if (view.state.readOnly) return false; const changed = (more ? indentMore : indentLess)(view); view.focus(); return changed;},
    presentation(patch: InlinePresentation) {requireCurrent(); return setInlinePresentation(view, patch);},
    blockPresentation(patch: BlockPresentation) {requireCurrent(); return setBlockPresentation(view, patch);},
    captureCard() {requireCurrent(); return captureCardPresentation(view);},
    insert(text: string) {requireCurrent(); return insertPlainText(view, text);},
    cut() {
      requireCurrent(); if (state.readOnly) return false;
      if (selection.main.empty) return edit("delete");
      view.dispatch({...state.replaceSelection(""), annotations: [Transaction.userEvent.of("delete.cut"), isolateHistory.of("full")]}); view.focus(); return true;
    },
    editBlock: edit,
    selectAll() {
      requireCurrent(); const scope = scopeOf(state);
      view.dispatch({selection: {anchor: scope.from, head: scope.to}}); view.focus();
    },
    selectBlock() {requireCurrent(); view.dispatch({selection: {anchor: block.from, head: block.to}}); view.focus();},
  };
}
export type EditorContextTarget = NonNullable<ReturnType<typeof captureEditorContext>>;
