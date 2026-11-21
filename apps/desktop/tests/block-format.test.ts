import test from "node:test";
import assert from "node:assert/strict";
import {EditorState, Transaction, type TransactionSpec} from "@codemirror/state";
import type {EditorView} from "@codemirror/view";
import {history, undo, undoDepth} from "@codemirror/commands";
import {editorSource, editorSourceHistory} from "../src/renderer/editor-source.ts";
import {markdownEditing} from "../src/renderer/editor-format.ts";
import {styledDocument} from "../src/renderer/styled-markdown.ts";
import {inlineInput} from "../src/renderer/inline-input.ts";
import {setBlockPresentation} from "../src/renderer/block-format.ts";
import {runTextCommand} from "../src/renderer/text-commands.ts";
import {manuscriptFormat, manuscriptVisibleText} from "../../../packages/workbench-ui/src/manuscript-format.ts";

function editor(source: string, from: number, to = from) {
  let state = EditorState.create({doc: source, selection: {anchor: from, head: to}, extensions: [editorSource.init(() => source), editorSourceHistory, history(), markdownEditing, styledDocument, inlineInput]});
  return {get state() {return state;}, composing: false, dispatch(spec: Transaction | TransactionSpec) {state = spec instanceof Transaction ? spec.state : state.update(spec).state;}, focus() {}} as EditorView;
}
test("段落对齐、焦点和取消只改结构，光标、强调、外围字节与单次撤销保持", () => {
  const source = "前\r\n\r\n甲**乙**。\n\n尾", view = editor(source, 4);
  assert(setBlockPresentation(view, {alignment: "center"}));
  assert.equal(view.state.doc.sliceString(view.state.selection.main.head - 1, view.state.selection.main.head), "甲");
  assert.equal(manuscriptFormat(view.state.doc.toString()).markup.spans.length, 1);
  assert(setBlockPresentation(view, {alignment: "right"}));
  assert.equal(manuscriptFormat(view.state.doc.toString()).markup.spans.length, 1);
  const depth = undoDepth(view.state); assert(setBlockPresentation(view, {alignment: "right"})); assert.equal(undoDepth(view.state), depth);
  assert(setBlockPresentation(view, {block: "focus"}));
  assert(setBlockPresentation(view, {block: undefined}));
  assert(setBlockPresentation(view, {alignment: undefined}));
  assert.equal(view.state.field(editorSource), source);
  assert(undo(view)); assert(view.state.doc.toString().includes('data-hetu-align="right"'));
});
test("多段分组与取消保留内文的原始混合换行，分段对齐互不改变邻段", () => {
  const source = "甲\r\n\r\n乙\n\n丙", view = editor(source, 0, 7);
  assert(setBlockPresentation(view, {block: "panel"}));
  assert(view.state.field(editorSource).includes(source));
  assert(setBlockPresentation(view, {block: undefined})); assert.equal(view.state.field(editorSource), source);
  assert(setBlockPresentation(view, {alignment: "center"}));
  assert.equal(manuscriptFormat(view.state.doc.toString()).markup.spans.length, 3);
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
});
test("空段格式保留后续输入的行内意图，代码块不转换为分组", () => {
  const view = editor("", 0); runTextCommand(view, "bold", "markdown");
  assert(setBlockPresentation(view, {alignment: "center"}));
  const position = view.state.selection.main.head;
  view.dispatch({changes: {from: position, insert: "文字"}, selection: {anchor: position + 2}, userEvent: "input.type"});
  assert.equal(manuscriptVisibleText(view.state.doc.toString()).trim(), "文字"); assert(view.state.doc.toString().includes("**文字**"));
  const code = editor("```\n代码\n```", 5); assert.equal(setBlockPresentation(code, {block: "panel"}), false);
});
