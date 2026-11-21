import test from "node:test";
import assert from "node:assert/strict";
import {Compartment, EditorState, Transaction, type TransactionSpec, type Extension} from "@codemirror/state";
import type {EditorView} from "@codemirror/view";
import {history, redo, undo} from "@codemirror/commands";
import {markdown} from "@codemirror/lang-markdown";
import {editorSource, editorSourceHistory} from "../src/renderer/editor-source.ts";
import {captureEditorContext, contextBlockRange, contextBlockEdit} from "../src/renderer/editor-context-target.ts";
import {styledDocument} from "../src/renderer/styled-markdown.ts";
import {groupView, groupedMarkdown, revealGroup} from "../src/renderer/grouped-markdown.ts";

function editor(source: string, from: number, to = from, extensions: Extension[] = []) {
  let state = EditorState.create({doc: source, selection: {anchor: from, head: to}, extensions: [editorSource.init(() => source), editorSourceHistory, history(), markdown(), extensions]});
  return {get state() {return state;}, dom: {isConnected: true}, composing: false,
    dispatch(spec: Transaction | TransactionSpec) {state = spec instanceof Transaction ? spec.state : state.update(spec).state;}, focus() {}} as EditorView;
}
test("右键块副本、删除和单次撤销重做保留混合换行与范围外字节", () => {
  const source = "前🌿\r\n\r\n中段\n\n末\r尾", view = editor(source, 6);
  const target = captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!;
  assert.equal(target.sourceText, "中段");
  assert.equal(target.quote.byte_start, Buffer.byteLength("前🌿\r\n\r\n"));
  assert(target.editBlock("duplicate"));
  assert.equal(view.state.field(editorSource), source.replace("中段", "中段\n\n中段"));
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  assert(redo(view)); assert.equal(view.state.field(editorSource), source.replace("中段", "中段\n\n中段"));
  captureEditorContext(view, "markdown", false, {canUndo: true, canRedo: false})!.editBlock("delete");
  assert.equal(view.state.field(editorSource), source);
});
test("多段选区末端换行不包含下一段，删除末段消耗前置分隔", () => {
  const view = editor("首\r\n甲\n乙\r\n尾", 2, 6);
  assert.deepEqual(contextBlockRange(view.state), {from: 2, to: 5});
  assert.equal(contextBlockEdit(view.state, "duplicate").source, "首\r\n甲\n乙\r\n甲\n乙\r\n尾");
  const end = editor("首\r\n\r\n末", 3);
  assert.equal(contextBlockEdit(end.state, "delete").source, "首");
});
test("代码围栏和多行列表项作为完整块，操作不破坏语法边界", () => {
  const source = "首\n\n```text\n甲🌿\n乙\n```\n\n尾", view = editor(source, source.indexOf("乙"));
  const range = contextBlockRange(view.state);
  assert.equal(view.state.sliceDoc(range.from, range.to), "```text\n甲🌿\n乙\n```");
  assert.equal(contextBlockEdit(view.state, "delete").source, "首\n\n尾");
  const list = editor("- 甲\n  延续\n- 乙", 7);
  assert.equal(list.state.sliceDoc(...Object.values(contextBlockRange(list.state)) as [number, number]), "- 甲\n  延续");
});
test("固定菜单目标拒绝迟到粘贴、选区变化和输入法组合", () => {
  const view = editor("甲🌿乙", 1, 3), context = {canUndo: false, canRedo: false};
  const captured = captureEditorContext(view, "plain", false, context)!;
  view.dispatch({selection: {anchor: 0}});
  assert.throws(() => captured.insert("迟到"), /选区已变化/);
  const changed = captureEditorContext(view, "plain", false, context)!;
  view.dispatch({changes: {from: 0, insert: "新"}});
  assert.throws(() => changed.cut(), /正文或选区已变化/);
  Object.defineProperty(view, "composing", {value: true});
  assert.equal(captureEditorContext(view, "plain", false, context), undefined);
});
test("选区剪切不扩大成整段，段落插入可一次撤销", () => {
  const view = editor("前\r\n甲🌿乙\n末", 3, 5), original = view.state.field(editorSource);
  captureEditorContext(view, "plain", false, {canUndo: false, canRedo: false})!.cut();
  assert.equal(view.state.field(editorSource), "前\r\n甲乙\n末");
  assert(undo(view)); assert.equal(view.state.field(editorSource), original);
  captureEditorContext(view, "plain", false, {canUndo: false, canRedo: false})!.editBlock("above");
  assert.equal(view.state.field(editorSource), "前\r\n\r\n甲🌿乙\n末");
  assert(undo(view)); assert.equal(view.state.field(editorSource), original);
});
test("分组内全选和删除不越过内页边界，菜单打开后锁定禁止迟到修改", () => {
  const source = '前\r\n\r\n<div data-hetu-block="page">\r\n\r\n内页\n\n甲🌿\r\n\r\n</div>\n\n尾', position = source.replace(/\r\n?/g, "\n").indexOf("甲");
  const view = editor(source, position, position, [styledDocument, groupedMarkdown]); revealGroup(view, position);
  const group = view.state.field(groupView).groups[0];
  captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!.selectAll();
  assert.equal(view.state.selection.main.from, group.bodyFrom); assert.equal(view.state.selection.main.to, group.bodyTo);
  captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!.editBlock("delete");
  assert.equal(view.state.field(editorSource), source.replace("内页\n\n甲🌿", ""));
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  const editable = new Compartment(), locked = editor("甲", 0, 0, [editable.of(EditorState.readOnly.of(false))]);
  const target = captureEditorContext(locked, "plain", false, {canUndo: false, canRedo: false})!;
  locked.dispatch({effects: editable.reconfigure(EditorState.readOnly.of(true))});
  assert.throws(() => target.insert("迟到"), /正文或选区已变化/); assert.equal(locked.state.doc.toString(), "甲");
});
