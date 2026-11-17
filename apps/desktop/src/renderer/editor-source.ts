import { StateEffect, StateField, type ChangeSet, type EditorState, type Text } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";

function positions(source: string, document: Text) {
  const starts = [0];
  for (const match of source.matchAll(/\r\n?|\n/g)) starts.push(match.index! + match[0].length);
  return (offset: number) => {
    const line = document.lineAt(offset);
    return starts[line.number - 1] + offset - line.from;
  };
}

/** CodeMirror 使用逻辑换行；只将实际编辑映射回原文，保留范围外的换行字节。 */
export function applyEditorChanges(source: string, document: Text, changes: ChangeSet) {
  const offset = positions(source, document);
  const separator = source.match(/\r\n?|\n/)?.[0] ?? "\n";
  const parts: string[] = [];
  let cursor = 0;
  changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
    parts.push(source.slice(cursor, offset(from)), inserted.toString().replace(/\n/g, separator));
    cursor = offset(to);
  });
  parts.push(source.slice(cursor));
  return parts.join("");
}

export const restoreEditorSource = StateEffect.define<string>();
const restoreEditorBreaks = StateEffect.define<readonly string[]>();
export const editorSource = StateField.define<string>({
  create: state => state.doc.toString(),
  update(source, transaction) {
    const restored = transaction.effects.findLast(effect => effect.is(restoreEditorSource));
    if (restored) return restored.value;
    const breaks = transaction.effects.findLast(effect => effect.is(restoreEditorBreaks));
    if (breaks && breaks.value.length === transaction.newDoc.lines - 1)
      return transaction.newDoc.toJSON().map((line, index) => line + (breaks.value[index] ?? "")).join("");
    return transaction.docChanged ? applyEditorChanges(source, transaction.startState.doc, transaction.changes) : source;
  },
});
// 历史只记录换行格式，不为每次键入保留一份完整长文。
export const editorSourceHistory = invertedEffects.of(transaction => transaction.docChanged
  ? [restoreEditorBreaks.of(transaction.startState.field(editorSource).match(/\r\n?|\n/g) ?? [])] : []);

export function editorSourceSelection(state: EditorState, from: number, to: number) {
  const source = state.field(editorSource), offset = positions(source, state.doc);
  const start = offset(from), end = offset(to), encoder = new TextEncoder();
  return { byte_start: encoder.encode(source.slice(0, start)).length,
    byte_end: encoder.encode(source.slice(0, end)).length, quote: source.slice(start, end) };
}
