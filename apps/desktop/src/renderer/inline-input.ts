import {EditorState, StateEffect, StateField, Transaction, type TransactionSpec} from "@codemirror/state";
import {isolateHistory} from "@codemirror/commands";
import type {EditorView} from "@codemirror/view";
import {manuscriptFormat} from "@hetu/workbench-ui/manuscript-format";
import {presentationAt, presentationTag, validColor, validFont, type InlinePresentation, type ManuscriptPresentation} from "@hetu/workbench-ui/manuscript-styles";
import {currentPresentation, styledDocument} from "./styled-markdown.ts";

export type InputStyle = "bold" | "italic" | "strike" | "code";
type Intent = {position: number; styles: InputStyle[]; attributes?: InlinePresentation; composition?: {from: number; to: number}};
export const inputStyleIntent = StateEffect.define<Intent | null>();
export const inlineComposition = StateEffect.define<"start" | "finish">();
const names = {strong: "bold", emphasis: "italic", strike: "strike", code: "code"} as const;
const marks = {bold: "**", italic: "*", strike: "~~", code: "`"};

/** 输入格式属于光标，不为尚未输入的文字制造正文或修订。 */
export const inlineInputIntent = StateField.define<Intent | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(inputStyleIntent)) return effect.value;
      if (effect.is(inlineComposition) && effect.value === "start" && value) return {...value, composition: {from: transaction.startState.selection.main.from, to: transaction.startState.selection.main.to}};
    }
    if (!value) return null;
    if (transaction.isUserEvent("undo") || transaction.isUserEvent("redo")) return null;
    if (value.composition && transaction.docChanged) return {...value, position: transaction.newSelection.main.head, composition: {from: transaction.changes.mapPos(value.composition.from, -1), to: transaction.changes.mapPos(value.composition.to, 1)}};
    if (transaction.docChanged || transaction.selection && (!transaction.selection.main.empty || transaction.selection.main.head !== value.position)) return null;
    return value;
  },
});

function inheritedStyles(state: EditorState): InputStyle[] {
  const position = state.selection.main.head, line = state.doc.lineAt(position), offset = position - line.from;
  return [...new Set(manuscriptFormat(line.text).styles.filter(span => {
    const size = span.style === "strong" || span.style === "strike" ? 2 : 1;
    return span.from + size <= offset && offset <= span.to - size;
  }).map(span => names[span.style]))];
}
function inlineAttributes(value: InlinePresentation = {}): InlinePresentation {
  return {...(value.color ? {color: value.color} : {}), ...(value.font ? {font: value.font} : {})};
}
function inheritedAttributes(state: EditorState): InlinePresentation {
  const line = state.doc.lineAt(state.selection.main.head);
  return inlineAttributes({...currentPresentation(state), ...presentationAt(manuscriptFormat(line.text).markup, state.selection.main.head - line.from)});
}
function sameAttributes(a: InlinePresentation = {}, b: InlinePresentation = {}) {return a.color === b.color && a.font === b.font;}

export function presentationContext(state: EditorState) {
  const selection = state.selection.main;
  if (selection.empty) return {presentation: {...currentPresentation(state), ...(state.field(inlineInputIntent, false)?.attributes ?? inheritedAttributes(state))}, mixedPresentation: [] as (keyof ManuscriptPresentation)[]};
  const cached = state.field(styledDocument, false), parsed = cached?.format ?? (cached ? undefined : manuscriptFormat(state.doc.toString()));
  const runs = parsed?.lines.flatMap(line => line.runs).filter(run => run.from < selection.to && run.to > selection.from) ?? [];
  const presentation = {...currentPresentation(state), ...inlineAttributes(runs[0]?.attributes)}, mixedPresentation: (keyof ManuscriptPresentation)[] = [];
  for (const key of ["font", "color"] as const) if (runs.some(run => run.attributes?.[key] !== presentation[key])) {delete presentation[key]; mixedPresentation.push(key);}
  const lines = parsed?.lines.filter(line => !line.hidden && line.from < selection.to && line.to > selection.from && line.runs.length) ?? [];
  for (const key of ["alignment", "block"] as const) if (lines.length) {
    const value = (line: typeof lines[number]) => line.attributes?.[key] ?? (key === "alignment" ? "left" : undefined);
    if (lines.some(line => value(line) !== value(lines[0]))) {delete presentation[key]; mixedPresentation.push(key);}
    else if (lines[0].attributes?.[key]) Object.assign(presentation, {[key]: lines[0].attributes[key]});
  }
  return {presentation, mixedPresentation};
}

export function setInputPresentation(view: EditorView, patch: InlinePresentation) {
  if (view.composing || view.state.readOnly || !view.state.selection.main.empty || view.state.field(inlineInputIntent, false) === undefined) return false;
  if (patch.color && !validColor(patch.color) || patch.font && !validFont(patch.font)) return false;
  const intent = view.state.field(inlineInputIntent), attributes = inlineAttributes({...(intent?.attributes ?? inheritedAttributes(view.state)), ...patch});
  view.dispatch({effects: inputStyleIntent.of({position: view.state.selection.main.head, styles: intent?.styles ?? inheritedStyles(view.state), attributes}), annotations: isolateHistory.of("before")});
  view.focus(); return true;
}

/** 已有选区只改指定属性，文字、其他片段样式和外围原文保持。 */
export function setInlinePresentation(view: EditorView, patch: InlinePresentation) {
  if (view.composing || view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
  if (patch.color && !validColor(patch.color) || patch.font && !validFont(patch.font)) return false;
  const selection = view.state.selection.main;
  if (selection.empty) return setInputPresentation(view, patch);
  const context = presentationContext(view.state);
  if ((Object.keys(patch) as (keyof InlinePresentation)[]).every(key => !context.mixedPresentation.includes(key) && context.presentation[key] === patch[key])) return true;
  const changes: {from: number; to: number; insert: string}[] = [];
  let anchor: number | undefined, head: number | undefined, delta = 0;
  const format = view.state.field(styledDocument, false)?.format ?? manuscriptFormat(view.state.doc.toString());
  const spans = [...format.styles, ...format.markup.spans.filter(span => span.tag === "span")];
  let expandedFrom = selection.from, expandedTo = selection.to, expanded = true;
  while (expanded) {
    expanded = false;
    for (const span of spans) if (span.from < expandedTo && span.to > expandedFrom && (span.from < expandedFrom || span.to > expandedTo)) {
      expandedFrom = Math.min(expandedFrom, span.from); expandedTo = Math.max(expandedTo, span.to); expanded = true;
    }
  }
  const first = view.state.doc.lineAt(expandedFrom), last = view.state.doc.lineAt(expandedTo);
  for (let number = first.number; number <= last.number; number++) {
    const line = view.state.doc.line(number), parsed = format.lines[number - 1];
    if (parsed.hidden) continue;
    const low = Math.max(expandedFrom, line.from), high = Math.min(expandedTo, line.to);
    if (high <= low) continue;
    const runs: Run[] = [], selected: Run[] = [];
    const sliceRuns = (from: number, to: number, target: Run[], track = false) => {
      for (const run of parsed.runs) for (const [a, b, apply] of [[from, Math.min(to, selection.from), false], [Math.max(from, selection.from), Math.min(to, selection.to), true], [Math.max(from, selection.to), to, false]] as const) {
        const start = Math.max(a, run.from), end = Math.min(b, run.to);
        if (end <= start) continue;
        const value: Run = {text: view.state.sliceDoc(start, end), styles: run.styles.map(style => names[style]),
          attributes: inlineAttributes({...inlineAttributes(run.attributes), ...(apply ? patch : {})})};
        target.push(value); if (track && apply) selected.push(value);
      }
    };
    sliceRuns(low, high, runs, true);
    if (selected.length) {selected[0].selectionStart = true; selected.at(-1)!.caret = true;}
    const expected: Run[] = []; sliceRuns(line.from, line.to, expected);
    const written = encodeParagraph(runs, view.state.sliceDoc(line.from, low), view.state.sliceDoc(high, line.to), compact(expected));
    if (!written || selected.length && (written.selectionStart === undefined || written.caret === undefined)) return false;
    changes.push({from: low, to: high, insert: written.text});
    if (written.selectionStart !== undefined) anchor ??= low + written.selectionStart + delta;
    if (written.caret !== undefined) head = low + written.caret + delta;
    delta += written.text.length - (high - low);
  }
  if (!changes.length || anchor === undefined || head === undefined) return false;
  view.dispatch({changes, selection: selection.anchor <= selection.head ? {anchor, head} : {anchor: head, head: anchor},
    annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")], effects: inputStyleIntent.of(null), scrollIntoView: true});
  view.focus(); return true;
}

export function toggleInputStyle(view: EditorView, style: InputStyle) {
  if (view.state.field(inlineInputIntent, false) === undefined || !view.state.selection.main.empty) return false;
  const styles = new Set(view.state.field(inlineInputIntent)?.styles ?? inheritedStyles(view.state));
  if (styles.has(style)) styles.delete(style);
  else {if (style === "code") styles.clear(); else styles.delete("code"); styles.add(style);}
  view.dispatch({effects: inputStyleIntent.of({position: view.state.selection.main.head, styles: [...styles], attributes: view.state.field(inlineInputIntent)?.attributes ?? inheritedAttributes(view.state)}), annotations: isolateHistory.of("before")});
  view.focus(); return true;
}

type Run = {text: string; styles: InputStyle[]; attributes?: InlinePresentation; caret?: boolean; selectionStart?: boolean};
type Written = {text: string; caret?: number; selectionStart?: number};
type Encoding = {bold: string; italic: string; order: InputStyle[]; factor: boolean; alternateNested?: boolean};
function append(target: Written, value: Written) {
  if (value.caret !== undefined) target.caret = target.text.length + value.caret;
  if (value.selectionStart !== undefined) target.selectionStart = target.text.length + value.selectionStart;
  target.text += value.text;
}
function wrap(opening: string, body: Written, closing: string): Written {
  return {text: opening + body.text + closing, caret: body.caret === undefined ? undefined : opening.length + body.caret,
    selectionStart: body.selectionStart === undefined ? undefined : opening.length + body.selectionStart};
}

/** 对实际输入所处的行内范围编码，外围原稿和换行不参与重排。 */
function write(runs: Run[], encoding: Encoding, depth = 0): Written {
  if (!runs.length) return {text: ""};
  if (runs.every(run => !run.text)) return {text: "", caret: runs.some(run => run.caret) ? 0 : undefined, selectionStart: runs.some(run => run.selectionStart) ? 0 : undefined};
  if (runs.every(run => sameAttributes(run.attributes, runs[0].attributes))) {
    const tag = presentationTag("span", runs[0].attributes ?? {});
    if (tag) return wrap(tag, write(runs.map(run => ({...run, attributes: undefined})), encoding, depth), "</span>");
  } else {
    const result: Written = {text: ""};
    for (let index = 0; index < runs.length;) {
      let end = index + 1; while (end < runs.length && sameAttributes(runs[index].attributes, runs[end].attributes)) end++;
      append(result, write(runs.slice(index, end), encoding, depth)); index = end;
    }
    return result;
  }
  const common = encoding.factor || runs.every(run => sameStyles(run.styles, runs[0].styles))
    ? encoding.order.find(style => runs.every(run => run.styles.includes(style))) : undefined;
  if (common) {
    if (common === "code") {
      const body: Written = {text: ""};
      for (const run of runs) append(body, {text: run.text, caret: run.caret ? run.text.length : undefined, selectionStart: run.selectionStart ? 0 : undefined});
      const delimiter = "`".repeat(Math.max(0, ...[...body.text.matchAll(/`+/g)].map(match => match[0].length)) + 1);
      const pad = /^`|`$/.test(body.text) || /^ .* $/.test(body.text) ? " " : "";
      return wrap(delimiter + pad, body, pad + delimiter);
    }
    const body = write(runs.map(run => ({...run, styles: run.styles.filter(style => style !== common)})), encoding, depth + 1);
    const delimiter = common === "italic" && encoding.alternateNested && depth ? "*" : common === "bold" || common === "italic" ? encoding[common] : marks[common];
    return wrap(delimiter, body, delimiter);
  }
  const result: Written = {text: ""};
  for (let index = 0; index < runs.length;) {
    const first = runs[index];
    if (!first.styles.length) {
      const text = first.text.replace(/[\\`*_~[\]<>]/g, "\\$&");
      append(result, {text, caret: first.caret ? text.length : undefined, selectionStart: first.selectionStart ? 0 : undefined}); index++;
    } else {
      const style = encoding.order.find(style => first.styles.includes(style))!; let end = index + 1;
      while (end < runs.length && (encoding.factor ? runs[end].styles.includes(style) : sameStyles(first.styles, runs[end].styles))) end++;
      append(result, write(runs.slice(index, end), encoding, depth)); index = end;
    }
  }
  return result;
}

function sameStyles(a: readonly InputStyle[], b: readonly InputStyle[]) {
  return a.length === b.length && a.every(style => b.includes(style));
}
function visibleRuns(source: string, from = 0, to = source.length): Run[] {
  return manuscriptFormat(source).lines[0].runs.filter(run => run.from < to && run.to > from).map(run => ({
    text: source.slice(Math.max(from, run.from), Math.min(to, run.to)), styles: [...new Set(run.styles.map(style => names[style]))], attributes: inlineAttributes(run.attributes),
  }));
}
function compact(runs: Run[]) {
  const result: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const previous = result.at(-1);
    if (previous && sameStyles(previous.styles, run.styles) && sameAttributes(previous.attributes, run.attributes)) previous.text += run.text;
    else result.push({text: run.text, styles: run.styles, attributes: run.attributes});
  }
  return result;
}

/** 标记相邻时可能改变语义；以同一呈现解析器核对整行，避免改坏两侧内容。 */
function encodeParagraph(runs: Run[], before: string, after: string, expected: Run[]): Written | null {
  const matches = (written: Written) => {
    // 范围外的字节不变；其可见文字和样式也必须保持。
    const actual = compact(visibleRuns(before + written.text + after));
    return actual.length === expected.length && actual.every((run, index) => run.text === expected[index].text && sameStyles(run.styles, expected[index].styles) && sameAttributes(run.attributes, expected[index].attributes));
  };
  // 优先连续共同格式；仅在定界符歧义时尝试等价的标准 Markdown 写法。
  for (const factor of [true, false]) for (const alternateNested of [false, true]) for (const italic of ["*", "_"]) for (const bold of ["**", "__"]) for (const order of [
    ["bold", "italic", "strike", "code"], ["italic", "bold", "strike", "code"], ["strike", "bold", "italic", "code"],
  ] as InputStyle[][]) {
    const result = write(runs, {bold, italic, order, factor, alternateNested});
    if (matches(result)) return result;
  }
  return null;
}

function encode(runs: Run[], source: string, from: number, to: number): Written | null {
  const paragraphs: Run[][] = [[]];
  for (const run of runs) {
    const parts = run.text.split("\n");
    for (let index = 0; index < parts.length; index++) {
      if (index) paragraphs.push([]);
      paragraphs.at(-1)!.push({...run, text: parts[index], caret: run.caret && index === parts.length - 1});
    }
  }
  const result: Written = {text: ""};
  for (let index = 0; index < paragraphs.length; index++) {
    const first = index === 0, last = index === paragraphs.length - 1;
    const expected = compact([...(first ? visibleRuns(source, 0, from) : []), ...paragraphs[index], ...(last ? visibleRuns(source, to) : [])]);
    const written = encodeParagraph(paragraphs[index], first ? source.slice(0, from) : "", last ? source.slice(to) : "", expected);
    if (!written) return null;
    if (index) result.text += "\n";
    append(result, written);
  }
  return result;
}

function styledInput(state: EditorState, from: number, to: number, text: string, styles: InputStyle[], caret: number, attributes: InlinePresentation = {}) {
  const line = state.doc.lineAt(from);
  if (state.doc.lineAt(to).number !== line.number) return null;
  const parsed = manuscriptFormat(line.text), spans: {from: number; to: number}[] = parsed.styles.filter(span => {
    const size = span.style === "strong" || span.style === "strike" ? 2 : 1;
    return span.from + size <= from - line.from && span.to - size >= to - line.from;
  });
  spans.push(...parsed.markup.spans.filter(span => span.tag === "span" && span.contentFrom <= from - line.from && span.contentTo >= to - line.from).map(span => ({from: span.from, to: span.to})));
  const start = spans.length ? Math.min(...spans.map(span => span.from)) + line.from : from;
  const end = spans.length ? Math.max(...spans.map(span => span.to)) + line.from : to;
  const runs: Run[] = [];
  const existing = (a: number, b: number) => {
    for (const run of parsed.lines[0].runs) {
      const low = Math.max(a, line.from + run.from), high = Math.min(b, line.from + run.to);
      if (high > low) runs.push({text: state.sliceDoc(low, high), styles: run.styles.map(style => names[style]), attributes: inlineAttributes(run.attributes)});
    }
  };
  existing(start, from);
  // 强调标记不能包住边界空白；空白不改变光标的下一次输入格式。
  const inserted = (value: string, mark = false) => {
    if (styles.includes("code")) {if (value || mark) runs.push({text: value, styles, attributes, caret: mark}); return;}
    const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(value)!;
    if (parts[1]) runs.push({text: parts[1], styles: [], attributes});
    if (parts[2]) runs.push({text: parts[2], styles, attributes});
    if (parts[3]) runs.push({text: parts[3], styles: [], attributes});
    if (mark) {if (value) runs[runs.length - 1].caret = true; else runs.push({text: "", styles, attributes, caret: true});}
  };
  inserted(text.slice(0, caret), true); inserted(text.slice(caret)); existing(to, end);
  const output = encode(runs, line.text, start - line.from, end - line.from);
  if (!output) return null;
  return {changes: {from: start, to: end, insert: output.text}, selection: {anchor: start + (output.caret ?? output.text.length)}};
}

export const inlineInput = [inlineInputIntent, EditorState.transactionFilter.of(transaction => {
  let intent = transaction.startState.field(inlineInputIntent, false);
  if (transaction.startState.readOnly) return transaction;
  if (transaction.isUserEvent("delete") && !intent?.composition) {
    const changes: {from: number; to: number; text: string}[] = [];
    transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => changes.push({from, to, text: inserted.toString()}));
    if (changes.length === 1 && !changes[0].text && transaction.newSelection.main.empty) {
      const {from, to} = changes[0], line = transaction.startState.doc.lineAt(from);
      if (transaction.startState.doc.lineAt(to).number === line.number) {
        const parsed = manuscriptFormat(line.text), a = from - line.from, b = to - line.from;
        const emptied = parsed.styles.filter(span => span.from <= a && span.to >= b && parsed.lines[0].runs
          .filter(run => run.from < span.to && run.to > span.from).every(run => run.from >= a && run.to <= b));
        if (emptied.length) {
          const styles = intent?.styles ?? [...new Set(emptied.map(span => names[span.style]))];
          const attributes = intent?.attributes ?? inheritedAttributes(transaction.startState);
          const result = styledInput(transaction.startState, from, to, "", styles, 0, attributes);
          if (result) return {...result, effects: [...transaction.effects, inputStyleIntent.of({styles, attributes, position: result.selection.anchor})],
            annotations: [Transaction.userEvent.of(transaction.annotation(Transaction.userEvent)!), isolateHistory.of("after")], scrollIntoView: transaction.scrollIntoView};
        }
      }
    }
  }
  if (!intent && transaction.isUserEvent("input") && transaction.docChanged && transaction.startState.selection.main.empty) {
    let newline = false;
    transaction.changes.iterChanges((_from, _to, _newFrom, _newTo, inserted) => {if (inserted.lines > 1) newline = true;});
    if (newline) {
      const styles = inheritedStyles(transaction.startState), attributes = inheritedAttributes(transaction.startState);
      if (styles.length || Object.keys(attributes).length) intent = {styles, attributes, position: transaction.startState.selection.main.head};
    }
  }
  if (!intent) return transaction;
  const finish = transaction.effects.some(effect => effect.is(inlineComposition) && effect.value === "finish");
  if (finish && intent.composition) {
    const {from, to} = intent.composition;
    if (from === to) return {effects: inputStyleIntent.of({...intent, composition: undefined})};
    const result = styledInput(transaction.startState, from, to, transaction.startState.sliceDoc(from, to), intent.styles, to - from, intent.attributes);
    if (!result) return {effects: inputStyleIntent.of(null)};
    return {...result, effects: inputStyleIntent.of({styles: intent.styles, attributes: intent.attributes, position: result.selection.anchor}), annotations: [Transaction.userEvent.of("input.type.compose"), isolateHistory.of("after")], scrollIntoView: true};
  }
  if (intent.composition || !transaction.isUserEvent("input.type") && !transaction.isUserEvent("input.paste") && transaction.annotation(Transaction.userEvent) !== "input" || transaction.changes.empty) return transaction;
  const changes: {from: number; to: number; text: string; newFrom: number}[] = [];
  transaction.changes.iterChanges((from, to, newFrom, _newTo, inserted) => changes.push({from, to, text: inserted.toString(), newFrom}));
  if (changes.length !== 1 || !transaction.newSelection.main.empty) return transaction;
  const {from, to, text, newFrom} = changes[0];
  const result = styledInput(transaction.startState, from, to, text, intent.styles, transaction.newSelection.main.head - newFrom, intent.attributes);
  if (!result) return transaction;
  const annotations = [Transaction.userEvent.of(transaction.annotation(Transaction.userEvent) ?? "input.type")];
  const isolated = transaction.annotation(isolateHistory); if (isolated) annotations.push(isolateHistory.of(isolated));
  return {...result, effects: [...transaction.effects, inputStyleIntent.of({styles: intent.styles, attributes: intent.attributes, position: result.selection.anchor})], annotations, scrollIntoView: transaction.scrollIntoView} satisfies TransactionSpec;
})];

export function finishInlineComposition(view: EditorView) {
  if (view.state.field(inlineInputIntent, false)?.composition) view.dispatch({effects: inlineComposition.of("finish")});
}
