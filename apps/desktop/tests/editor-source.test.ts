import assert from "node:assert/strict";
import test from "node:test";
import { EditorState, Transaction } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { editorSource, editorSourceHistory, editorSourceSelection, restoreEditorSource } from "../src/renderer/editor-source.ts";

function state(source: string) {
  return EditorState.create({ doc: source, extensions: [editorSource.init(() => source), editorSourceHistory, history()] });
}

test("原始CRLF、LF、CR和混合换行保持，选区对应原文UTF8", () => {
  for (const source of ["前🌊\r\n甲\r\n末", "前🌊\n甲\n末", "前🌊\r甲\r末", "前🌊\r\n甲\n乙\r末"]) {
    const initial = state(source);
    assert.equal(initial.field(editorSource), source);
    const end = initial.doc.length;
    const range = editorSourceSelection(initial, 4, end);
    assert.equal(range.quote, source.slice(source.indexOf("甲")));
    assert.equal(range.byte_start, Buffer.byteLength(source.slice(0, source.indexOf("甲"))));
    assert.equal(range.byte_end, Buffer.byteLength(source));
    const next = initial.update({ changes: { from: 4, to: 5, insert: "改" } }).state;
    assert.equal(next.field(editorSource), source.replace("甲", "改"));
  }
});

test("局部增删和多个不相邻修改不改范围外字节", () => {
  const initial = state("甲\r\n乙\n丙\r丁");
  const replaced = initial.update({ changes: [{ from: 0, to: 1, insert: "首" }, { from: 6, to: 7, insert: "末" }] }).state;
  assert.equal(replaced.field(editorSource), "首\r\n乙\n丙\r末");
  const inserted = replaced.update({ changes: { from: 3, insert: "\n新" } }).state;
  assert.equal(inserted.field(editorSource), "首\r\n乙\r\n新\n丙\r末");
  const deleted = initial.update({ changes: { from: 1, to: 5, insert: "" } }).state;
  assert.equal(deleted.field(editorSource), "甲\r丁");
});

test("撤销和重做恢复混合换行原字节，外部内容同步保留固定原文", () => {
  const source = "甲\r\n乙\n丙\r丁";
  let current = state(source);
  current = current.update({ changes: { from: 1, to: 6, insert: "\n新\n" } }).state;
  const revised = current.field(editorSource);
  assert.equal(revised, "甲\r\n新\r\n丁");
  const dispatch = (transaction: ReturnType<EditorState["update"]>) => { current = transaction.state; };
  assert.equal(undo({ state: current, dispatch }), true);
  assert.equal(current.field(editorSource), source);
  assert.equal(redo({ state: current, dispatch }), true);
  assert.equal(current.field(editorSource), revised);
  const replacement = "固定\r\n新原文\n末";
  current = current.update({ changes: { from: 0, to: current.doc.length, insert: replacement },
    effects: restoreEditorSource.of(replacement) }).state;
  assert.equal(current.field(editorSource), replacement);
});

test("合并的连续输入撤销到原始换行，重做还原全部输入", () => {
  const source = "甲\r\n乙\n丙";
  let current = state(source);
  current = current.update({ changes: { from: 1, insert: "一" }, annotations: Transaction.userEvent.of("input.type") }).state;
  current = current.update({ changes: { from: 2, insert: "二" }, annotations: Transaction.userEvent.of("input.type") }).state;
  const revised = current.field(editorSource);
  const dispatch = (transaction: ReturnType<EditorState["update"]>) => { current = transaction.state; };
  assert.equal(undo({ state: current, dispatch }), true);
  assert.equal(current.field(editorSource), source);
  assert.equal(redo({ state: current, dispatch }), true);
  assert.equal(current.field(editorSource), revised);
});
