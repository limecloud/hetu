import test from "node:test";
import assert from "node:assert/strict";
import {Compartment, EditorState, Transaction, type TransactionSpec, type Extension} from "@codemirror/state";
import type {EditorView} from "@codemirror/view";
import {history, redo, undo, undoDepth} from "@codemirror/commands";
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

test("段落上下移动保留混合换行、emoji选区和一次撤销重做", () => {
  const source = "前\r\n\r\n甲🌿乙\n\n尾", normalized = source.replace(/\r\n?/g, "\n");
  const from = normalized.indexOf("🌿"), view = editor(source, from, from + 2);
  const target = captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!;
  assert(target.canMoveUp); assert(target.canMoveDown); assert(target.editBlock("up"));
  assert.equal(view.state.field(editorSource), "甲🌿乙\r\n\r\n前\n\n尾");
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), "🌿");
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  assert(redo(view)); assert.equal(view.state.field(editorSource), "甲🌿乙\r\n\r\n前\n\n尾");
});

test("多段反向选区整体下移，原始内部分隔和选择方向保持", () => {
  const source = "甲\r\n\r\n乙\n丙\r\n\r\n丁", normalized = source.replace(/\r\n?/g, "\n");
  const from = normalized.indexOf("乙"), to = normalized.indexOf("丙") + 1, view = editor(source, to, from);
  const target = captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!;
  assert(target.editBlock("down"));
  assert.equal(view.state.field(editorSource), "甲\r\n\r\n丁\r\n\r\n乙\n丙");
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), "乙\n丙");
  assert(view.state.selection.main.anchor > view.state.selection.main.head);
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
});

test("排序将带空行的代码围栏和多行列表项作为完整相邻内容", () => {
  const source = "首\n\n```text\n甲🌿\n\n乙\n```\n\n尾", view = editor(source, source.indexOf("尾"));
  assert(captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!.editBlock("up"));
  assert.equal(view.state.field(editorSource), "首\n\n尾\n\n```text\n甲🌿\n\n乙\n```");
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  const listSource = "前\n\n- 甲\n  延续\n- 乙\n\n后", list = editor(listSource, listSource.indexOf("乙"));
  assert(captureEditorContext(list, "markdown", false, {canUndo: false, canRedo: false})!.editBlock("up"));
  assert.equal(list.state.field(editorSource), "前\n\n- 乙\n- 甲\n  延续\n\n后");
});

test("卡片和段落样式连同开闭标记移动，内页排序不越界", () => {
  for (const attributes of ['data-hetu-block="card"', 'data-hetu-align="center"']) {
    const container = `<div ${attributes}>\r\n\r\n内页\n\n甲🌿\r\n\r\n</div>`;
    const source = "前\r\n\r\n" + container + "\n\n尾", normalized = source.replace(/\r\n?/g, "\n");
    const view = editor(source, normalized.indexOf("尾"), undefined, [styledDocument, groupedMarkdown]);
    assert(captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!.editBlock("up"));
    assert.equal(view.state.field(editorSource), "前\r\n\r\n尾\n\n" + container);
    assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  }
  const source = '前\n\n<div data-hetu-block="page">\n\n内页\n\n甲\n\n</div>\n\n后', at = source.indexOf("甲");
  const view = editor(source, at, at, [styledDocument, groupedMarkdown]); revealGroup(view, at);
  let target = captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!;
  assert.equal(target.canMoveDown, false); assert.equal(target.editBlock("down"), false);
  assert.equal(undoDepth(view.state), 0); assert(target.editBlock("up"));
  assert.equal(view.state.field(editorSource), source.replace("内页\n\n甲", "甲\n\n内页"));
  target = captureEditorContext(view, "markdown", false, {canUndo: true, canRedo: false})!;
  assert.equal(target.canMoveUp, false); assert.equal(target.editBlock("up"), false);
});

test("字母排序按可见文字稳定比较，保留混合换行槽与反向完整块选区", () => {
  const source = "外围🌿\r\n**zebra**\n\n# Apple\r\napple\r\nitem 10\nitem 2\r\n尾", logical = source.replace(/\r\n?/g, "\n");
  const view = editor(source, logical.indexOf("item 2") + 6, logical.indexOf("zebra"));
  const target = captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!;
  assert(target.canSort); assert(target.sortBlocks("ascending"));
  assert.equal(view.state.field(editorSource), "外围🌿\r\n\n# Apple\napple\r\nitem 10\r\nitem 2\n**zebra**\r\n尾");
  assert(view.state.selection.main.anchor > view.state.selection.main.head);
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), "\n# Apple\napple\nitem 10\nitem 2\n**zebra**");
  assert.equal(undoDepth(view.state), 1); assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  assert(redo(view)); assert.equal(view.state.field(editorSource), "外围🌿\r\n\n# Apple\napple\r\nitem 10\r\nitem 2\n**zebra**\r\n尾");
});

test("升序保持等价拼写次序，降序反转完整顺序，数字按字母比较", () => {
  const source = "zebra\nApple\napple\nitem 10\nitem 2\nÉclair\néclair\nß\nss\n🌿";
  for (const language of ["zh-CN", "en"]) {
    const view = editor(source, 0, source.length);
    assert(captureEditorContext(view, "plain", false, {canUndo: false, canRedo: false})!.sortBlocks("ascending", language));
    assert.equal(view.state.doc.toString(), "🌿\nApple\napple\nÉclair\néclair\nitem 10\nitem 2\nß\nss\nzebra");
    assert(captureEditorContext(view, "plain", false, {canUndo: true, canRedo: false})!.sortBlocks("descending", language));
    assert.equal(view.state.doc.toString(), "zebra\nss\nß\nitem 2\nitem 10\néclair\nÉclair\napple\nApple\n🌿");
  }
  const cases = "apple\nApple\néclair\nEclair\nÉclair\neclair\nss\nß\na 10\na 2\nZebra\nzebra", view = editor(cases, 0, cases.length);
  assert(captureEditorContext(view, "plain", false, {canUndo: false, canRedo: false})!.sortBlocks("ascending", "zh-CN"));
  assert.equal(view.state.doc.toString(), "a 10\na 2\napple\nApple\néclair\nÉclair\nEclair\neclair\nss\nß\nZebra\nzebra");
  assert(captureEditorContext(view, "plain", false, {canUndo: true, canRedo: false})!.sortBlocks("descending", "zh-CN"));
  assert.equal(view.state.doc.toString(), "zebra\nZebra\nß\nss\neclair\nEclair\nÉclair\néclair\nApple\napple\na 2\na 10");
});

test("排序不拆代码、嵌套列表、Setext标题、引用或卡片，按页面标题比较", () => {
  const fence = "```text\r\nzulu\r\n\r\n更多\r\n```", card = '<div data-hetu-block="card">\r\n\r\nBeta\n\n卡片内文\r\n\r\n</div>';
  const source = "前\r\n\r\n" + fence + "\n\n" + card + "\r\n\r\nA段\n尾", logical = source.replace(/\r\n?/g, "\n");
  const view = editor(source, logical.indexOf("zulu"), logical.indexOf("A段") + 2, [styledDocument, groupedMarkdown]);
  assert(captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!.sortBlocks("ascending"));
  assert.equal(view.state.field(editorSource), "前\r\n\r\n\n\nA段\r\n" + card + "\r\n" + fence + "\n尾");
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  for (const source of ["- Zebra\n  续行\n  - 内项\n- Alpha", "Zebra\n---\nAlpha", "> Zebra\n> 续行\n\nAlpha"]) {
    const view = editor(source, 0, source.length);
    assert(captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!.sortBlocks("ascending"));
    const result = view.state.field(editorSource); assert(result.indexOf("Alpha") < result.indexOf("Zebra"));
    if (source.startsWith("-")) assert(result.includes("- Zebra\n  续行\n  - 内项"));
    else if (source.includes("---")) assert(result.includes("Zebra\n---"));
    else assert(result.includes("> Zebra\n> 续行"));
    assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  }
});

test("内页排序保留标题和外部字节，单块及原顺序不制造撤销", () => {
  const source = '外\r\n\r\n<div data-hetu-block="page">\r\n\r\n页题\r\n\r\nZulu\nAlpha\r\n\r\n</div>\n\n尾', logical = source.replace(/\r\n?/g, "\n"), at = logical.indexOf("Alpha");
  const view = editor(source, at, at, [styledDocument, groupedMarkdown]); revealGroup(view, at);
  captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!.selectAll();
  assert(captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!.sortBlocks("ascending"));
  assert.equal(view.state.field(editorSource), source.replace("Zulu\nAlpha", "Alpha\nZulu"));
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to).includes("页题"), false);
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
  for (const [source, from, to] of [["Alpha\nZulu", 0, 10], ["单块", 0, 2], ["单块\n二块", 0, 0]] as const) {
    const view = editor(source, from, to), target = captureEditorContext(view, "plain", false, {canUndo: false, canRedo: false})!;
    assert.equal(target.canSort, source.includes("Zulu")); assert.equal(target.sortBlocks("ascending"), false); assert.equal(undoDepth(view.state), 0);
  }
  const identical = editor("相同\r\n相同", 0, 5);
  assert.equal(captureEditorContext(identical, "plain", false, {canUndo: false, canRedo: false})!.sortBlocks("descending"), false);
  assert.equal(undoDepth(identical.state), 0);
});

test("长文末尾尚未解析的围栏先完整读取，再作为整块排序", () => {
  const prefix = "保留行\r\n".repeat(10000), fence = "```text\nZulu\n\n原样\n```", source = prefix + fence + "\nAlpha";
  const logical = source.replace(/\r\n?/g, "\n"), view = editor(source, logical.indexOf("Zulu"), logical.length);
  assert(captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!.sortBlocks("ascending"));
  assert.equal(view.state.field(editorSource).slice(0, prefix.length), prefix);
  assert.equal(view.state.field(editorSource).slice(prefix.length), "Alpha\n" + fence);
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
});

test("原稿模式按实际可见标记排序，锁定或迟到的排序不修改正文", () => {
  const source = "# Zulu\nAlpha", plain = editor(source, 0, source.length);
  assert.equal(captureEditorContext(plain, "markdown", true, {canUndo: false, canRedo: false})!.sortBlocks("ascending"), false);
  assert.equal(undoDepth(plain.state), 0);
  const locked = new Compartment(), view = editor("Zulu\nAlpha", 0, 10, [locked.of(EditorState.readOnly.of(false))]);
  const previous = captureEditorContext(view, "plain", false, {canUndo: false, canRedo: false})!;
  view.dispatch({effects: locked.reconfigure(EditorState.readOnly.of(true))});
  assert.throws(() => previous.sortBlocks("ascending"), /选区已变化/);
  assert.equal(captureEditorContext(view, "plain", false, {canUndo: false, canRedo: false})!.sortBlocks("ascending"), false);
  assert.equal(view.state.field(editorSource), "Zulu\nAlpha"); assert.equal(undoDepth(view.state), 0);
});

test("四千块排序保留全部原文并以一次事务撤销", () => {
  const ordered = Array.from({length: 4096}, (_, index) => "条目" + String(index).padStart(4, "0"));
  const source = ordered.map((_, index) => ordered[index * 127 % ordered.length]).join("\r\n"), view = editor(source, 0, source.replace(/\r\n/g, "\n").length);
  assert(captureEditorContext(view, "markdown", false, {canUndo: false, canRedo: false})!.sortBlocks("ascending"));
  assert.equal(view.state.field(editorSource), ordered.join("\r\n")); assert.equal(undoDepth(view.state), 1);
  assert(undo(view)); assert.equal(view.state.field(editorSource), source);
});
