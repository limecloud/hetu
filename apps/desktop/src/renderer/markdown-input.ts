import {Transaction} from "@codemirror/state";
import {isolateHistory} from "@codemirror/commands";
import {deleteMarkupBackward, insertNewlineContinueMarkupCommand} from "@codemirror/lang-markdown";
import {ensureSyntaxTree, syntaxTree} from "@codemirror/language";
import type {EditorView} from "@codemirror/view";

export const continueMarkdownList = insertNewlineContinueMarkupCommand({nonTightLists: false});

/** 取消任务项时同时移除列表与复选框，避免留下失去语义的源标记。 */
export function deleteMarkdownMarkup(view: EditorView) {
  if (view.state.readOnly || view.composing || view.state.selection.ranges.length !== 1) return false;
  const selection = view.state.selection.main, line = view.state.doc.lineAt(selection.head);
  const task = /^([ \t]*)([-+*][ \t]+\[[ xX]\][ \t]+)/.exec(line.text);
  const marker = task && (ensureSyntaxTree(view.state, line.to, 30) ?? syntaxTree(view.state)).resolveInner(line.from + task[0].indexOf("["), 1);
  if (selection.empty && task && marker?.name === "TaskMarker" && selection.head >= line.from + task[1].length && selection.head <= line.from + task[0].length) {
    view.dispatch({changes: {from: line.from + task[1].length, to: line.from + task[0].length}, selection: {anchor: line.from + task[1].length},
      annotations: [Transaction.userEvent.of("delete.backward"), isolateHistory.of("full")], scrollIntoView: true});
    return true;
  }
  return deleteMarkupBackward(view);
}
