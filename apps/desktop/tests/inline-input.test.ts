import test from "node:test";
import assert from "node:assert/strict";
import {EditorState, Transaction, type TransactionSpec} from "@codemirror/state";
import {history, undo, redo, undoDepth} from "@codemirror/commands";
import type {EditorView} from "@codemirror/view";
import {continueMarkdownList, deleteMarkdownMarkup} from "../src/renderer/markdown-input.ts";
import {inlineInput, inlineComposition, finishInlineComposition, setInputPresentation, setInlinePresentation, presentationContext} from "../src/renderer/inline-input.ts";
import {markdownEditing} from "../src/renderer/editor-format.ts";
import {editorSource, editorSourceHistory} from "../src/renderer/editor-source.ts";
import {runTextCommand} from "../src/renderer/text-commands.ts";
import {activeTextCommands} from "../src/renderer/text-command-context.ts";
import {manuscriptFormat, manuscriptVisibleText} from "../../../packages/workbench-ui/src/manuscript-format.ts";

function editor(source = "", position = source.replace(/\r\n?/g, "\n").length) {
  let state = EditorState.create({doc: source, selection: {anchor: position}, extensions: [editorSource.init(() => source), editorSourceHistory, history(), markdownEditing, inlineInput]});
  return {get state() {return state;}, composing: false, dispatch(spec: TransactionSpec | Transaction) {state = spec instanceof Transaction ? spec.state : state.update(spec).state;}, focus() {}} as EditorView;
}
function input(view: EditorView, text: string, userEvent = "input.type") {
  const selection = view.state.selection.main;
  view.dispatch({changes: {from: selection.from, to: selection.to, insert: text}, selection: {anchor: selection.from + text.length}, userEvent});
}
function stylesOf(view: EditorView, text: string) {
  const source = view.state.doc.toString(), at = source.indexOf(text), parsed = manuscriptFormat(source);
  assert(at >= 0, source);
  return parsed.styles.filter(span => span.from <= at && span.to >= at + text.length).map(span => span.style).sort();
}

test("空选区格式开关不写正文，输入与格式一起撤销，切换后继续普通输入", () => {
  const view = editor();
  runTextCommand(view, "bold", "markdown");
  assert.equal(view.state.doc.toString(), ""); assert.equal(undoDepth(view.state), 0);
  assert(activeTextCommands(view.state, "markdown").includes("bold"));
  input(view, "粗体"); assert.equal(view.state.doc.toString(), "**粗体**");
  runTextCommand(view, "bold", "markdown"); assert.equal(view.state.doc.toString(), "**粗体**");
  input(view, "普通"); assert.equal(view.state.doc.toString(), "**粗体**普通");
  assert(undo(view)); assert.equal(view.state.doc.toString(), "**粗体**");
  assert(undo(view)); assert.equal(view.state.doc.toString(), "");
  assert(redo(view)); assert.equal(view.state.doc.toString(), "**粗体**");
});

test("组合格式和原有格式中的中途输入保持前后文字样式及范围外源字节", () => {
  const cases = [
    {source: "**甲乙**", position: 3, command: "bold", expected: []},
    {source: "***甲乙***", position: 4, command: "bold", expected: ["emphasis"]},
    {source: "***甲乙***", position: 4, command: "italic", expected: ["strong"]},
    {source: "*甲乙*", position: 2, command: "bold", expected: ["emphasis", "strong"]},
    {source: "~~甲乙~~", position: 3, command: "bold", expected: ["strike", "strong"]},
  ] as const;
  for (const value of cases) for (const adjacent of ["", "旁"]) {
    const source = "前\r\n" + adjacent + value.source + adjacent + "\n尾", view = editor(source, 2 + adjacent.length + value.position);
    runTextCommand(view, value.command, "markdown"); input(view, "新");
    assert.deepEqual(stylesOf(view, "新"), value.expected, view.state.doc.toString());
    assert.deepEqual(stylesOf(view, "甲"), stylesOf(editor(value.source), "甲"), view.state.doc.toString());
    assert.deepEqual(stylesOf(view, "乙"), stylesOf(editor(value.source), "乙"), view.state.doc.toString());
    assert(view.state.field(editorSource).startsWith("前\r\n")); assert(view.state.field(editorSource).endsWith("\n尾"));
    assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  }
});

test("删除最后一个格式字不残留空标记，继续输入继承样式并可撤销", () => {
  for (const source of ["**甲**", "***甲***", "~~甲~~", "`甲`", "__甲__"]) {
    const at = source.indexOf("甲"), view = editor(source, at + 1);
    const original = stylesOf(view, "甲");
    view.dispatch({changes: {from: at, to: at + 1}, selection: {anchor: at}, userEvent: "delete.backward"});
    assert.equal(view.state.doc.toString(), "", source);
    input(view, "乙"); assert.deepEqual(stylesOf(view, "乙"), original);
    assert(undo(view)); assert.equal(view.state.doc.toString(), "");
    assert(undo(view)); assert.equal(view.state.doc.toString(), source);
  }
  const rule = editor("---", 3);
  rule.dispatch({changes: {from: 2, to: 3}, selection: {anchor: 2}, userEvent: "delete.backward"});
  assert.equal(rule.state.doc.toString(), "--");
});

test("132种原有格式、相邻文字与光标格式切换保持可见文字和两侧样式", () => {
  const styles = {bold: "strong", italic: "emphasis", strike: "strike", code: "code"} as const;
  for (const body of ["甲乙", "**甲乙**", "*甲乙*", "***甲乙***", "~~甲乙~~", "~~**甲乙**~~", "~~*甲乙*~~", "~~***甲乙***~~", "`甲乙`", "__甲乙__", "_甲乙_"]) {
    for (const adjacent of ["", "旁", "text"]) for (const command of Object.keys(styles) as (keyof typeof styles)[]) {
      const source = adjacent + body + adjacent, view = editor(source, adjacent.length + body.indexOf("乙"));
      const original = stylesOf(view, "甲"), style = styles[command];
      const expected = original.includes(style) ? original.filter(value => value !== style) : command === "code" ? ["code"] : [...original.filter(value => value !== "code"), style].sort();
      runTextCommand(view, command, "markdown"); input(view, "新");
      const actual = view.state.doc.toString(), detail = JSON.stringify({source, command, actual});
      assert.equal(manuscriptVisibleText(actual), manuscriptVisibleText(source).replace("甲乙", "甲新乙"), detail);
      assert.deepEqual(stylesOf(view, "新"), expected, detail);
      assert.deepEqual(stylesOf(view, "甲"), original, detail); assert.deepEqual(stylesOf(view, "乙"), original, detail);
    }
  }
});

test("连续输入、空白与字面标记不破坏格式，代码保留真实字符", () => {
  const view = editor(); runTextCommand(view, "bold", "markdown");
  for (const text of ["开", "头", " ", "结", "尾🌿"]) input(view, text);
  assert.equal(manuscriptVisibleText(view.state.doc.toString()), "开头 结尾🌿");
  assert.deepEqual(stylesOf(view, "开头"), ["strong"]); assert.deepEqual(stylesOf(view, "结尾🌿"), ["strong"]);
  const code = editor(); runTextCommand(code, "code", "markdown"); input(code, "**字面**`内容");
  assert.equal(manuscriptVisibleText(code.state.doc.toString()), "**字面**`内容");
  assert.deepEqual(stylesOf(code, "字面"), ["code"]);
});

test("组合输入期间不插入标记，提交后格式与输入单次撤销", () => {
  const view = editor(); runTextCommand(view, "bold", "markdown");
  view.dispatch({effects: inlineComposition.of("start")}); input(view, "zhong", "input.type.compose.start");
  assert.equal(view.state.doc.toString(), "zhong");
  view.dispatch({changes: {from: 0, to: 5, insert: "中"}, selection: {anchor: 1}, userEvent: "input.type.compose"});
  finishInlineComposition(view); assert.equal(view.state.doc.toString(), "**中**");
  assert(undo(view)); assert.equal(view.state.doc.toString(), "");
});

test("光标颜色和字体不制造空正文，组合格式、默认恢复和输入撤销保持", () => {
  const view = editor();
  assert(setInputPresentation(view, {color: "red", font: "serif"}));
  assert.equal(view.state.doc.toString(), ""); assert.equal(undoDepth(view.state), 0);
  input(view, "甲"); runTextCommand(view, "bold", "markdown"); input(view, "乙");
  assert.equal(manuscriptVisibleText(view.state.doc.toString()), "甲乙");
  assert.deepEqual(stylesOf(view, "乙"), ["strong"]);
  assert(setInputPresentation(view, {color: undefined})); input(view, "丙");
  const source = view.state.doc.toString(), parsed = manuscriptFormat(source);
  for (const text of ["甲", "乙", "丙"]) {
    const position = source.indexOf(text), run = parsed.lines[0].runs.find(run => run.from <= position && run.to > position)!;
    assert.equal(run.attributes?.font, "serif"); assert.equal(run.attributes?.color, text === "丙" ? undefined : "red");
  }
  assert(undo(view)); assert.equal(manuscriptVisibleText(view.state.doc.toString()), "甲乙");
});

test("选区颜色和字体保留混合强调、周围属性及混合换行，默认恢复只改选中字", () => {
  const source = '前\r\n<span data-hetu-color="red">甲**乙丙**丁</span>\n尾', normalized = source.replace(/\r\n/g, "\n");
  const from = normalized.indexOf("乙"), to = normalized.indexOf("丁");
  const view = editor(source, from); view.dispatch({selection: {anchor: from, head: to}});
  assert(setInlinePresentation(view, {font: "mono", color: undefined}));
  const output = view.state.doc.toString(), parsed = manuscriptFormat(output);
  assert.equal(manuscriptVisibleText(output), "前\n甲乙丙丁\n尾");
  for (const text of ["甲", "乙", "丙", "丁"]) {
    const position = output.indexOf(text), run = parsed.lines.flatMap(line => line.runs).find(run => run.from <= position && run.to > position)!;
    assert.equal(run.attributes?.color, ["乙", "丙"].includes(text) ? undefined : "red");
    assert.equal(run.attributes?.font, ["乙", "丙"].includes(text) ? "mono" : undefined);
  }
  assert.deepEqual(stylesOf(view, "乙"), ["strong"]); assert.deepEqual(stylesOf(view, "丙"), ["strong"]);
  assert(view.state.field(editorSource).startsWith("前\r\n")); assert(view.state.field(editorSource).endsWith("\n尾"));
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
});

test("跨行片段局部恢复保留邻字属性、混合换行和单次撤销，混合段落不伪装左对齐", () => {
  const source = '前\r\n<span data-hetu-color="red" data-hetu-font="serif">甲**乙\n丙**丁</span>\r\n尾', normalized = source.replace(/\r\n/g, "\n");
  const view = editor(source, normalized.indexOf("乙"));
  view.dispatch({selection: {anchor: normalized.indexOf("乙"), head: normalized.indexOf("丙") + 1}});
  assert(setInlinePresentation(view, {color: undefined, font: "mono"}));
  const output = view.state.doc.toString(), runs = manuscriptFormat(output).lines.flatMap(line => line.runs);
  for (const text of ["甲", "乙", "丙", "丁"]) {
    const position = output.indexOf(text), run = runs.find(run => run.from <= position && run.to > position)!;
    const selected = ["乙", "丙"].includes(text);
    assert.equal(run.attributes?.color, selected ? undefined : "red"); assert.equal(run.attributes?.font, selected ? "mono" : "serif");
    if (selected) assert.deepEqual(run.styles, ["strong"]);
  }
  assert.deepEqual(view.state.field(editorSource).match(/\r\n|\n/g), source.match(/\r\n|\n/g));
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  const paragraphs = editor('<div data-hetu-align="center">\n\n居中\n\n</div>\n\n普通');
  paragraphs.dispatch({selection: {anchor: 0, head: paragraphs.state.doc.length}});
  assert(presentationContext(paragraphs.state).mixedPresentation.includes("alignment"));
});

test("格式末尾换段与多行纯文本粘贴分别编码，范围外文字和换行保持", () => {
  const view = editor("**正文**", 4);
  runTextCommand(view, "bold", "markdown"); input(view, "\n", "input");
  assert.equal(view.state.doc.toString(), "**正文**\n");
  input(view, "- 列表"); assert.equal(view.state.doc.toString(), "**正文**\n- 列表");
  const paste = editor(); runTextCommand(paste, "bold", "markdown");
  input(paste, "第一行\n第二行", "input.paste");
  assert.equal(paste.state.doc.toString(), "**第一行**\n**第二行**");
  assert.deepEqual(stylesOf(paste, "第一行"), ["strong"]); assert.deepEqual(stylesOf(paste, "第二行"), ["strong"]);
  assert(undo(paste)); assert.equal(paste.state.doc.toString(), "");
});

test("列表回车续写、任务状态重置、空项退出及退格保持源换行", () => {
  const newline = continueMarkdownList;
  for (const [source, next] of [["- 项目", "- 项目\r\n- "], ["1. 项目", "1. 项目\r\n2. "], ["- [x] 项目", "- [x] 项目\r\n- [ ] "]] as const) {
    const view = editor("前\r\n\r\n" + source); assert(newline(view));
    assert.equal(view.state.field(editorSource), "前\r\n\r\n" + next);
    assert(newline(view)); assert.equal(view.state.field(editorSource), "前\r\n\r\n" + source + "\r\n");
  }
  const view = editor("- 项目", 2); assert(deleteMarkdownMarkup(view)); assert.equal(view.state.doc.toString(), "项目");
  for (const position of [0, 2, 6]) {
    const task = editor("- [x] 任务", position); assert(deleteMarkdownMarkup(task)); assert.equal(task.state.doc.toString(), "任务");
    assert(undo(task)); assert.equal(task.state.doc.toString(), "- [x] 任务");
  }
  const code = editor("```\n- 项目\n```", 8); assert.equal(newline(code), false);
  const codeTask = editor("```\n- [x] 任务\n```", 10); assert.equal(deleteMarkdownMarkup(codeTask), false);
});
