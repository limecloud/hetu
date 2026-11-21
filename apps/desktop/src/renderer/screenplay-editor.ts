import {EditorState, Facet, StateField, Transaction} from "@codemirror/state";
import {Decoration, EditorView, keymap, type DecorationSet} from "@codemirror/view";
import {autocompletion, type CompletionContext} from "@codemirror/autocomplete";
import {parseFountain, screenplayBody, fountainRuns, type FountainScript} from "@hetu/workbench-ui/fountain";
import {restoreEditorSource} from "./editor-source.ts";

const title = Facet.define<string, string>({combine: values => values[0] ?? ""});
export function screenplayStart(source: string, name: string) { return screenplayBody(parseFountain(source), source, name)[0]?.from ?? 0; }
interface ScreenplayModel { script: FountainScript; start: number; decorations: DecorationSet; hidden: DecorationSet }
function model(state: EditorState): ScreenplayModel {
  const source = state.doc.toString(), script = parseFountain(source), marks = [], hidden = [];
  const start = screenplayBody(script, source, state.facet(title))[0]?.from ?? 0;
  if (start > 0) hidden.push(Decoration.replace({block: true}).range(0, start));
  for (const line of script.lines) {
    if (line.from < start) continue;
    marks.push(Decoration.line({class: "screenplay-line screenplay-" + line.kind}).range(line.from));
    if (line.textFrom > line.from) hidden.push(Decoration.replace({}).range(line.from, line.textFrom));
    if (line.textTo < line.to) hidden.push(Decoration.replace({}).range(line.textTo, line.to));
    let offset = line.textFrom;
    for (const run of fountainRuns(source, line.textFrom, line.textTo)) {
      if (run.from > offset) hidden.push(Decoration.replace({}).range(offset, run.from));
      if (run.style && run.to > run.from) marks.push(Decoration.mark({class: "screenplay-" + run.style}).range(run.from, run.to));
      offset = run.to;
    }
    if (offset < line.textTo) hidden.push(Decoration.replace({}).range(offset, line.textTo));
  }
  return {script, start, decorations: Decoration.set([...marks, ...hidden], true), hidden: Decoration.set(hidden, true)};
}
const screenplayModel = StateField.define<ScreenplayModel>({
  create: model,
  update: (value, transaction) => transaction.docChanged || transaction.reconfigured ? model(transaction.state) : value,
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});
export function screenplayContext(state: EditorState) {
  const value = state.field(screenplayModel, false);
  if (!value) return undefined;
  const line = state.doc.lineAt(state.selection.main.head), index = value.script.lines.findIndex(row => row.from === line.from);
  const current = value.script.lines[index], previous = value.script.lines[index - 1];
  const inDialogue = !!previous && ["character", "parenthetical", "dialogue", "lyric"].includes(previous.kind);
  const scenes = value.script.lines.filter(row => row.kind === "scene"), scene = scenes.findLastIndex(row => row.from <= line.from);
  return {element: current?.kind === "blank" ? inDialogue ? "dialogue" : "action" : current?.kind, inDialogue,
    previousScene: scene > 0, nextScene: scene + 1 < scenes.length};
}
function complete(context: CompletionContext) {
  const value = context.state.field(screenplayModel, false);
  if (!value) return null;
  const source = context.state.doc.toString(), line = context.state.doc.lineAt(context.pos);
  const current = value.script.lines.find(row => row.from === line.from);
  if (!current || !["character", "scene"].includes(current.kind) || context.pos < current.textFrom) return null;
  const prefix = source.slice(current.textFrom, context.pos), character = current.kind === "character";
  if (!prefix && !context.explicit) return null;
  const names = new Set(value.script.lines.filter(row => row.kind === current.kind && row.from !== current.from).map(row => {
    const text = source.slice(row.textFrom, row.textTo).trim();
    return character ? text.replace(/\s*\([^)]*\)\s*$/, "").trim() : text;
  }).filter(Boolean));
  const body = source.slice(current.textFrom, current.textTo), extension = character ? body.search(/\s*\([^)]*\)\s*$/) : -1;
  return {from: current.textFrom, to: extension >= 0 ? current.textFrom + extension : current.textTo,
    options: [...names].filter(name => name !== prefix).map(label => ({label, type: character ? "variable" : "text"})), validFor: /^[^\r\n]*$/};
}

/** 格式、补全和输入规则共用同一分集解析；显示不改写原稿。 */
export const screenplayEditing = (name: string) => [title.of(name), screenplayModel,
  EditorView.atomicRanges.of(view => view.state.field(screenplayModel).hidden),
  autocompletion({override: [complete], icons: false, activateOnTyping: true, maxRenderedOptions: 30}),
  keymap.of([{key: "Enter", run: view => {
    if (view.composing || view.state.readOnly || !view.state.selection.main.empty) return false;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    if (view.state.selection.main.head !== line.to || !line.text.trim()) return false;
    const current = screenplayContext(view.state)?.element;
    const insert = current === "character" || current === "parenthetical" ? "\n" : "\n\n";
    view.dispatch({...view.state.replaceSelection(insert), annotations: Transaction.userEvent.of("input.type"), scrollIntoView: true}); return true;
  }}]),
  EditorState.transactionFilter.of(transaction => {
    if (!transaction.docChanged || transaction.effects.some(effect => effect.is(restoreEditorSource))) return transaction;
    const start = transaction.startState.field(screenplayModel).start;
    let beforeBody = false; transaction.changes.iterChangedRanges(from => { if (from < start) beforeBody = true; });
    return beforeBody ? [] : transaction;
  }),
];
