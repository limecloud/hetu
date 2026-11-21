import {EditorSelection, Transaction, type EditorState} from "@codemirror/state";
import {isolateHistory, indentMore, indentLess} from "@codemirror/commands";
import {syntaxTree} from "@codemirror/language";
import type {EditorView} from "@codemirror/view";
import {editorSource, editorSourceRange, editorSourceSelection, editorClipboardText, restoreEditorSource} from "./editor-source.ts";
import {groupView} from "./grouped-markdown.ts";
import {runTextCommand, insertPlainText, type TextCommand, type TextFormat} from "./text-commands.ts";
import {setInlinePresentation} from "./inline-input.ts";
import {setBlockPresentation, captureCardPresentation} from "./block-format.ts";
import type {InlinePresentation, BlockPresentation} from "@hetu/workbench-ui/manuscript-styles";
import type {EditorContext} from "./editor.tsx";

export type BlockOperation = "duplicate" | "delete" | "above" | "below";
interface Range {from: number; to: number}
function scopeOf(state: EditorState) {
  const groups = state.field(groupView, false), active = groups?.groups.find(group => group.from === groups.focus);
  return {groups, active, from: active?.bodyFrom ?? 0, to: active?.bodyTo ?? state.doc.length};
}

/** 原子分组与代码围栏不能因右键命中一行而被拆坏。 */
export function contextBlockRange(state: EditorState): Range {
  const selection = state.selection.main, scope = scopeOf(state);
  const group = scope.groups?.groups.find(group => group !== scope.active && group.from >= scope.from && group.to <= scope.to && selection.from === group.from && selection.to === group.to);
  if (group) return {from: group.from, to: group.to};
  const first = state.doc.lineAt(selection.from), atEnd = state.doc.lineAt(selection.to);
  const last = selection.to > selection.from && selection.to === atEnd.from ? state.doc.line(atEnd.number - 1) : atEnd;
  let from = Math.max(scope.from, first.from), to = Math.min(scope.to, last.to);
  for (const position of [selection.from, Math.max(selection.from, selection.to - 1)]) {
    let node = syntaxTree(state).resolveInner(position, position === state.doc.lineAt(position).to ? -1 : 1);
    for (; node.parent; node = node.parent) if (["FencedCode", "CodeBlock", "ListItem"].includes(node.name)) {
      from = Math.max(scope.from, Math.min(from, state.doc.lineAt(node.from).from));
      to = Math.min(scope.to, Math.max(to, state.doc.lineAt(node.to).to)); break;
    }
  }
  return {from, to};
}

export function contextBlockEdit(state: EditorState, operation: BlockOperation, block = contextBlockRange(state)) {
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

export function captureEditorContext(view: EditorView, format: TextFormat, raw: boolean, context: EditorContext) {
  if (view.composing) return;
  const document = view.state.doc, selection = view.state.selection, state = view.state;
  const block = contextBlockRange(state), range = selection.main.empty ? block : selection.main;
  const valid = () => view.dom.isConnected && !view.composing && view.state.readOnly === state.readOnly && view.state.doc === document && view.state.selection.eq(selection);
  const requireCurrent = () => {if (!valid()) throw new Error("正文或选区已变化，请重新打开右键菜单。");};
  function edit(operation: BlockOperation) {
    requireCurrent(); if (view.state.readOnly) return false;
    const change = contextBlockEdit(state, operation, block);
    const logical = (offset: number) => state.field(editorSource).slice(0, offset).replace(/\r\n?/g, "\n").length;
    view.dispatch({changes: {from: logical(change.from), to: logical(change.to), insert: change.insert.replace(/\r\n?/g, "\n")},
      effects: restoreEditorSource.of(change.source), selection: EditorSelection.cursor(Math.min(change.cursor, change.source.replace(/\r\n?/g, "\n").length)),
      annotations: [Transaction.userEvent.of(operation === "delete" ? "delete.block" : "input.block"), isolateHistory.of("full")]});
    view.focus(); return true;
  }
  return {
    context, valid, requireCurrent, empty: selection.main.empty, readOnly: state.readOnly, block,
    text: editorClipboardText(state, range.from, range.to, format === "markdown" && !raw),
    sourceText: editorSourceSelection(state, range.from, range.to).quote,
    quote: editorSourceSelection(state, range.from, range.to),
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
