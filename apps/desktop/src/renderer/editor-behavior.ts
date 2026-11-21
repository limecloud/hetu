import {StateField, Transaction, type Extension} from "@codemirror/state";
import {Decoration, EditorView, keymap, type DecorationSet} from "@codemirror/view";

export interface WritingBehavior { focusParagraph?: boolean; typewriter?: boolean; smartPairs?: boolean }
const pairs: Record<string, string> = {"(": ")", "[": "]", "{": "}", "“": "”", "‘": "’", "（": "）", "【": "】", "《": "》", '"': '"', "'": "'"};
const currentParagraph = StateField.define<DecorationSet>({
  create: state => Decoration.set([Decoration.line({class: "cm-writing-paragraph"}).range(state.doc.lineAt(state.selection.main.head).from)]),
  update: (value, transaction) => transaction.docChanged || transaction.selection
    ? Decoration.set([Decoration.line({class: "cm-writing-paragraph"}).range(transaction.newDoc.lineAt(transaction.newSelection.main.head).from)]) : value,
  provide: field => EditorView.decorations.from(field),
});

function centerTypingLine(view: EditorView) {
  if (view.composing) return;
  const stage = view.dom.closest<HTMLElement>(".manuscript-stage") ?? view.scrollDOM;
  view.requestMeasure({
    read: editor => editor.composing ? null : editor.coordsAtPos(editor.state.selection.main.head),
    write: coordinates => { if (coordinates && !view.composing) stage.scrollTop += coordinates.top - stage.getBoundingClientRect().top - stage.clientHeight * .45; },
  });
}

/** 写作行为只产生同一编辑事务；显示偏好与历史、保存及作者决定分离。 */
export function writingBehavior(options: WritingBehavior): Extension[] {
  const extensions: Extension[] = [];
  if (options.focusParagraph) extensions.push(currentParagraph);
  if (options.typewriter) extensions.push(EditorView.updateListener.of(update => {
    if (update.docChanged && !update.view.composing && update.transactions.some(transaction => transaction.isUserEvent("input.type"))) centerTypingLine(update.view);
  }), EditorView.domEventHandlers({compositionend: (_event, view) => { setTimeout(() => { if (view.dom.isConnected) centerTypingLine(view); }, 0); }}));
  if (options.smartPairs) extensions.push(EditorView.inputHandler.of((view, from, to, text) => {
    if (view.composing || view.state.readOnly || text.length !== 1 || view.state.selection.ranges.length !== 1) return false;
    if (from === to && Object.values(pairs).includes(text) && view.state.doc.sliceString(from, from + 1) === text) {
      view.dispatch({selection: {anchor: from + 1}, annotations: Transaction.userEvent.of("select")}); return true;
    }
    const close = pairs[text];
    if (!close) return false;
    // 英文单词中的单引号保持为撇号，不擅自补齐。
    if (text === "'" && from === to && /[\p{L}\p{N}]/u.test(view.state.doc.sliceString(Math.max(0, from - 1), from))) return false;
    view.dispatch({changes: from === to ? {from, insert: text + close} : [{from, insert: text}, {from: to, insert: close}],
      selection: {anchor: from + 1, head: to + 1}, scrollIntoView: true, annotations: Transaction.userEvent.of("input.type")});
    return true;
  }), keymap.of([{key: "Backspace", run: view => {
    const selection = view.state.selection.main, head = selection.head;
    if (view.composing || view.state.readOnly || !selection.empty || head === 0 || view.state.selection.ranges.length !== 1) return false;
    const open = view.state.doc.sliceString(head - 1, head), close = view.state.doc.sliceString(head, head + 1);
    if (!pairs[open] || pairs[open] !== close) return false;
    view.dispatch({changes: {from: head - 1, to: head + 1}, selection: {anchor: head - 1}, annotations: Transaction.userEvent.of("delete.backward")}); return true;
  }}]));
  return extensions;
}
