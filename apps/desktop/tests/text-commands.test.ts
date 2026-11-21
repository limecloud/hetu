import test from "node:test";
import assert from "node:assert/strict";
import {EditorState, EditorSelection, type TransactionSpec} from "@codemirror/state";
import {history, undo, redo} from "@codemirror/commands";
import type {EditorView} from "@codemirror/view";
import {runTextCommand, setScreenplayElement, insertPlainText} from "../src/renderer/text-commands.ts";
import {editorSource, editorSourceHistory} from "../src/renderer/editor-source.ts";
import {activeTextCommands} from "../src/renderer/text-command-context.ts";
import {markdownEditing} from "../src/renderer/editor-format.ts";

function editor(source: string, from = 0, to = from) {
  let state = EditorState.create({doc: source, selection: EditorSelection.single(from, to), extensions: [editorSource.init(() => source), editorSourceHistory, history()]});
  const view = {get state() {return state;}, composing: false, dispatch(spec: TransactionSpec) {state = state.update(spec).state;}, focus() {}} as EditorView;
  return view;
}

test("格式状态来自确切语法与共同选区，混合块和标记外光标不冒充选中样式", () => {
  const source = "# **粗体**\n\n> *引用*\n\n正文 `代码`";
  const context = (from: number, to = from) => activeTextCommands(EditorState.create({doc: source, selection: EditorSelection.single(from, to), extensions: [markdownEditing]}), "markdown");
  assert.deepEqual(context(source.indexOf("粗体"), source.indexOf("粗体") + 2), ["bold", "heading1"]);
  assert.deepEqual(context(source.indexOf("引用"), source.indexOf("引用") + 2), ["italic", "quote"]);
  assert.deepEqual(context(source.indexOf("代码"), source.indexOf("代码") + 2), ["code", "paragraph"]);
  assert.deepEqual(context(source.indexOf("\n")), ["heading1"]);
  assert.deepEqual(context(source.indexOf("粗体"), source.indexOf("引用") + 2), []);
  const fountain = EditorState.create({doc: "***台词***", selection: EditorSelection.single(3, 5)});
  assert.deepEqual(activeTextCommands(fountain, "fountain"), ["bold", "italic"]);
  assert.deepEqual(activeTextCommands(fountain, "plain"), []);
});

test("格式操作保留范围外混合换行，命令与输入分别单次撤销", () => {
  const source = "首行\r\n中文🌿内容\n尾行\r结尾", view = editor(source, 3, 9);
  assert(runTextCommand(view, "bold", "markdown"));
  assert.equal(view.state.field(editorSource), "首行\r\n**中文🌿内容**\n尾行\r结尾");
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), "中文🌿内容");
  assert(insertPlainText(view, "替换"));
  assert.equal(view.state.field(editorSource), "首行\r\n**替换**\n尾行\r结尾");
  assert(undo(view)); assert.equal(view.state.field(editorSource), "首行\r\n**中文🌿内容**\n尾行\r结尾");
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  assert(redo(view)); assert.equal(view.state.field(editorSource), "首行\r\n**中文🌿内容**\n尾行\r结尾");
});

test("强调跨段切换与部分取消保留其他文字的格式", () => {
  const combined = editor("普通", 0, 2);
  runTextCommand(combined, "bold", "markdown");
  runTextCommand(combined, "italic", "markdown");
  assert.equal(combined.state.doc.toString(), "***普通***");
  runTextCommand(combined, "italic", "markdown");
  assert.equal(combined.state.doc.toString(), "**普通**");
  runTextCommand(combined, "bold", "markdown");
  assert.equal(combined.state.doc.toString(), "普通");
  const view = editor("甲\n乙\n丙", 0, 5);
  runTextCommand(view, "bold", "markdown");
  assert.equal(view.state.doc.toString(), "**甲**\n**乙**\n**丙**");
  runTextCommand(view, "bold", "markdown");
  assert.equal(view.state.doc.toString(), "甲\n乙\n丙");
  const partial = editor("**甲乙丙**", 3, 4);
  runTextCommand(partial, "bold", "markdown");
  assert.equal(partial.state.doc.toString(), "**甲**乙**丙**");
  assert.equal(partial.state.sliceDoc(partial.state.selection.main.from, partial.state.selection.main.to), "乙");
  const backward = editor("前中文尾", 3, 1);
  runTextCommand(backward, "bold", "markdown");
  assert.equal(backward.state.doc.toString(), "前**中文**尾");
  assert.equal(backward.state.sliceDoc(backward.state.selection.main.from, backward.state.selection.main.to), "中文");
  assert(backward.state.selection.main.anchor > backward.state.selection.main.head);
});

test("标题、引用与分隔只改变所需结构，TXT不伪装支持格式", () => {
  const view = editor("正文\r\n二段\n末", 0, 5);
  runTextCommand(view, "heading1", "markdown");
  assert.equal(view.state.field(editorSource), "# 正文\r\n# 二段\n末");
  runTextCommand(view, "paragraph", "markdown");
  assert.equal(view.state.field(editorSource), "正文\r\n二段\n末");
  runTextCommand(view, "quote", "markdown");
  assert.equal(view.state.field(editorSource), "> 正文\r\n> 二段\n末");
  runTextCommand(view, "quote", "markdown");
  assert.equal(view.state.field(editorSource), "正文\r\n二段\n末");
  runTextCommand(view, "separator", "markdown");
  assert.equal(view.state.field(editorSource), "正文\r\n二段\r\n\r\n---\r\n\n末");
  const plain = editor("文字", 0, 2);
  assert.equal(runTextCommand(plain, "bold", "plain"), false); assert.equal(plain.state.doc.toString(), "文字");
});

test("删除线与三种列表保留混合换行、内容及单次撤销，剧本不冒充列表格式", () => {
  const source = "中文🌿\r\n第二项\n末尾", view = editor(source, 0, 8);
  runTextCommand(view, "task_list", "markdown");
  assert.equal(view.state.field(editorSource), "- [ ] 中文🌿\r\n- [ ] 第二项\n末尾");
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  runTextCommand(view, "ordered_list", "markdown");
  assert.equal(view.state.field(editorSource), "1. 中文🌿\r\n2. 第二项\n末尾");
  runTextCommand(view, "bullet_list", "markdown");
  assert.equal(view.state.field(editorSource), "- 中文🌿\r\n- 第二项\n末尾");
  runTextCommand(view, "bullet_list", "markdown");
  assert.equal(view.state.field(editorSource), source);
  const strike = editor("前**中文🌿**尾", 3, 7);
  runTextCommand(strike, "strike", "markdown");
  assert.equal(strike.state.doc.toString(), "前**~~中文🌿~~**尾");
  runTextCommand(strike, "strike", "markdown");
  assert.equal(strike.state.doc.toString(), "前**中文🌿**尾");
  assert.equal(runTextCommand(view, "task_list", "fountain"), false);
});

test("Fountain元素转换保留标题页、场号、缩进及混合换行，不伪造人物", () => {
  const underlined = editor("_台词_", 1, 3);
  runTextCommand(underlined, "italic", "fountain");
  assert.equal(underlined.state.doc.toString(), "_*台词*_");
  const source = "Title: 夜航\r\n\r\n.INT. 渡口 - NIGHT #1#\n\n  !低声说话  \r@江岚\n!船来了吗？🌿\n末";
  const logical = source.replace(/\r\n?|\n/g, "\n"), at = logical.indexOf("  !");
  const view = editor(source, at + 3);
  setScreenplayElement(view, "character");
  assert.equal(view.state.field(editorSource), source.replace("  !低声说话  ", "  @低声说话  "));
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  const dialogue = editor(source, logical.indexOf("!船"));
  setScreenplayElement(dialogue, "dialogue");
  assert.equal(dialogue.state.field(editorSource), source.replace("!船", "船"));
  setScreenplayElement(dialogue, "parenthetical");
  assert.equal(dialogue.state.field(editorSource), source.replace("!船来了吗？🌿", "(船来了吗？🌿)"));
  const action = editor("!独立行动", 2);
  assert.throws(() => setScreenplayElement(action, "dialogue"), /人物提示/);
  assert.equal(action.state.doc.toString(), "!独立行动");
});
