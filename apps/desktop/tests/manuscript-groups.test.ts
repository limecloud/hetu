import test from "node:test";
import assert from "node:assert/strict";
import {EditorState, Transaction, type TransactionSpec} from "@codemirror/state";
import type {EditorView} from "@codemirror/view";
import {history, undo} from "@codemirror/commands";
import {manuscriptFormat} from "../../../packages/workbench-ui/src/manuscript-format.ts";
import {manuscriptGroups, childGroups, groupAt} from "../../../packages/workbench-ui/src/manuscript-groups.ts";
import {editorSource, editorSourceHistory} from "../src/renderer/editor-source.ts";
import {styledDocument} from "../src/renderer/styled-markdown.ts";
import {groupView, groupedMarkdown, revealGroup} from "../src/renderer/grouped-markdown.ts";
import {captureCardPresentation} from "../src/renderer/block-format.ts";

const source = '前言。\r\n\r\n<div data-hetu-block="page">\r\n\r\n第一组\r\n\r\n内文🌿。\r\n\r\n<div data-hetu-block="card">\n\n第二组\n\n卡片内文。\n\n</div>\r\n\r\n尾段。\r\n\r\n</div>\r\n\r\n后记。';

test("分组标题、预览和嵌套范围只从固定原文派生，字节与Unicode位置保持", () => {
  const groups = manuscriptGroups(source, manuscriptFormat(source));
  assert.equal(groups.length, 2); assert.equal(groups[0].title, "第一组"); assert.equal(groups[1].title, "第二组");
  assert.equal(groups[1].preview, "卡片内文。");
  assert.deepEqual(childGroups(groups).map(group => group.title), ["第一组"]);
  assert.deepEqual(childGroups(groups, groups[0]).map(group => group.title), ["第二组"]);
  assert.equal(groupAt(groups, source.indexOf("卡片内文")), groups[1]);
  assert.equal(groupAt(groups, source.indexOf("内文🌿"), source.indexOf("尾段") + 2), groups[0]);
  assert.equal(groupAt(groups, source.indexOf("后记")), undefined);
  assert.equal(source.slice(groups[1].bodyFrom, groups[1].bodyTo), "第二组\n\n卡片内文。");
});

test("卡片预览固定原文，套用保留混合换行并独立撤销，取消和过期配置不改稿", () => {
  let state = EditorState.create({doc: source, extensions: [editorSource.init(() => source), editorSourceHistory, history(), styledDocument, groupedMarkdown]});
  const view = {get state() {return state;}, composing: false, dispatch(spec: Transaction | TransactionSpec) {state = spec instanceof Transaction ? spec.state : state.update(spec).state;}} as EditorView;
  const inside = state.doc.toString().indexOf("卡片内文"), edit = captureCardPresentation(view, inside)!;
  assert.equal(state.field(editorSource), source); assert.equal(undo(view), false);
  revealGroup(view, inside); view.dispatch({selection: {anchor: inside}});
  assert(edit.apply({cardLayout: "large", cardPreview: "none", cardGradient: "#112233,#ddeeff"}));
  const saved = state.field(editorSource);
  assert.equal(saved.replace(/<div data-hetu-block="card"[^>]*>/, '<div data-hetu-block="card">'), source);
  assert.equal(manuscriptGroups(state.doc.toString(), manuscriptFormat(state.doc.toString()))[1].attributes.cardLayout, "large");
  assert(undo(view)); assert.equal(state.field(editorSource), source);
  const stale = captureCardPresentation(view, state.doc.toString().indexOf("卡片内文"))!;
  view.dispatch({changes: {from: inside, insert: "新"}});
  const current = state.field(editorSource);
  assert.equal(stale.apply({cardLayout: "square"}), false); assert.equal(state.field(editorSource), current);
});

test("编辑分组导航不产生正文和撤销，内部编辑与撤销保留整篇源及边界映射", () => {
  let state = EditorState.create({doc: source, extensions: [editorSource.init(() => source), editorSourceHistory, history(), styledDocument, groupedMarkdown]});
  const view = {get state() {return state;}, composing: false, dispatch(spec: Transaction | TransactionSpec) {state = spec instanceof Transaction ? spec.state : state.update(spec).state;}} as EditorView;
  const inside = state.doc.toString().indexOf("卡片内文");
  revealGroup(view, inside); assert.equal(state.field(groupView).groups.find(group => group.from === state.field(groupView).focus)?.title, "第二组");
  assert.equal(state.field(editorSource), source); assert.equal(undo(view), false);
  view.dispatch({selection: {anchor: state.doc.length}});
  assert.equal(state.selection.main.head, state.field(groupView).groups[1].bodyTo);
  view.dispatch({changes: {from: inside, insert: "新增"}, selection: {anchor: inside + 2}, userEvent: "input.type"});
  assert.equal(state.field(groupView).groups.find(group => group.from === state.field(groupView).focus)?.title, "第二组");
  assert.equal(state.field(editorSource), source.replace("卡片内文", "新增卡片内文"));
  assert(undo(view)); assert.equal(state.field(editorSource), source);
  revealGroup(view, state.doc.toString().indexOf("后记")); assert.equal(state.field(groupView).focus, null);
  assert.equal(state.field(editorSource), source);
});
