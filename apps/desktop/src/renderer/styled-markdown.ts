import {StateField, type EditorState, type Range} from "@codemirror/state";
import {Decoration, EditorView, type DecorationSet} from "@codemirror/view";
import {manuscriptFormat, type ManuscriptFormat} from "@hetu/workbench-ui/manuscript-format";
import {presentationAt, presentationStyle, type StyleMarkup, type ManuscriptPresentation} from "@hetu/workbench-ui/manuscript-styles";

interface StyledDocument {markup: StyleMarkup; format?: ManuscriptFormat; decorations: DecorationSet; hidden: DecorationSet}
const css = (value: Record<string, string>) => Object.entries(value).map(([key, value]) => key.replace(/[A-Z]/g, character => "-" + character.toLowerCase()) + ":" + value).join(";");

function decorate(state: EditorState): StyledDocument {
  const source = state.doc.toString();
  const format = source.includes("data-hetu-") ? manuscriptFormat(source) : undefined;
  const markup = format?.markup ?? {spans: [], markers: []};
  const ranges: Range<Decoration>[] = [], hidden: Range<Decoration>[] = [];
  const lines = new Map<number, {classes: Set<string>; attributes: ManuscriptPresentation}>();
  const line = (position: number) => {
    let value = lines.get(position);
    if (!value) {value = {classes: new Set(), attributes: {}}; lines.set(position, value);}
    return value;
  };
  for (const marker of markup.markers) {
    const range = Decoration.replace({}).range(marker.from, marker.to);
    ranges.push(range); hidden.push(range);
  }
  for (const span of markup.spans) {
    if (span.tag === "span" && span.contentTo > span.contentFrom) {
      ranges.push(Decoration.mark({attributes: {style: css(presentationStyle(span.attributes))}}).range(span.contentFrom, span.contentTo));
    } else if (span.tag === "div") {
      const first = state.doc.lineAt(span.opening.from).number, last = state.doc.lineAt(span.closing.from).number;
      line(state.doc.line(first).from).classes.add("cm-manuscript-marker-line");
      line(state.doc.line(last).from).classes.add("cm-manuscript-marker-line");
      for (let number = first + 1; number < last; number++) Object.assign(line(state.doc.line(number).from).attributes, span.attributes);
    }
  }
  for (const [position, value] of lines) ranges.push(Decoration.line({attributes: {
    class: [...value.classes].join(" "), style: css(presentationStyle(value.attributes)),
    ...(value.attributes.block ? {"data-manuscript-block": value.attributes.block} : {}),
  }}).range(position));
  return {markup, format, decorations: Decoration.set(ranges, true), hidden: Decoration.set(hidden, true)};
}

/** 同一源标记同时驱动字形、段落与原子范围，原稿模式不安装本层。 */
export const styledDocument = StateField.define<StyledDocument>({
  create: decorate,
  update(value, transaction) {return transaction.docChanged ? decorate(transaction.state) : value;},
  provide: field => [EditorView.decorations.from(field, value => value.decorations), EditorView.atomicRanges.of(view => view.state.field(field).hidden)],
});

export function currentPresentation(state: EditorState): ManuscriptPresentation {
  const markup = state.field(styledDocument, false)?.markup;
  return markup ? presentationAt(markup, state.selection.main.from, state.selection.main.to) : {};
}
