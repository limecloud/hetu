import {EditorState, EditorSelection, StateEffect, StateField, type Range} from "@codemirror/state";
import {Decoration, EditorView, WidgetType, keymap, type DecorationSet} from "@codemirror/view";
import {manuscriptGroups, childGroups, groupAt, type ManuscriptGroup} from "@hetu/workbench-ui/manuscript-groups";
import {styledDocument} from "./styled-markdown.ts";
import {editingText} from "./editing-labels.ts";
import {styleCardPreview, cardConfigurationEvent} from "@hetu/workbench-ui/card-preview";

const focusGroup = StateEffect.define<{from: number | null; entering?: {from: number; top: number}}>();
interface GroupView {groups: ManuscriptGroup[]; focus: number | null; returnTops: Map<number, number>; decorations: DecorationSet; atomic: DecorationSet}
function stage(view: EditorView) {return view.dom.closest<HTMLElement>(".manuscript-stage") ?? view.scrollDOM;}

function navigate(view: EditorView, from: number | null, entering = false) {
  if (view.composing) return;
  const value = view.state.field(groupView), current = value.groups.find(group => group.from === value.focus), target = value.groups.find(group => group.from === from);
  const anchor = target?.bodyFrom ?? current?.from ?? view.state.selection.main.head;
  view.dispatch({effects: focusGroup.of({from, ...(entering && target ? {entering: {from: target.from, top: stage(view).scrollTop}} : {})}), selection: {anchor}});
  view.requestMeasure({read: () => entering ? 0 : value.returnTops.get(current?.from ?? -1) ?? 0, write: top => {stage(view).scrollTop = top;}});
  view.focus();
}

class GroupPreview extends WidgetType {
  readonly group: ManuscriptGroup;
  constructor(group: ManuscriptGroup) {super(); this.group = group;}
  eq(other: GroupPreview) {return this.group.from === other.group.from && this.group.to === other.group.to && this.group.kind === other.group.kind && this.group.title === other.group.title && this.group.preview === other.group.preview && JSON.stringify(this.group.attributes) === JSON.stringify(other.group.attributes) && JSON.stringify(this.group.images) === JSON.stringify(other.group.images);}
  toDOM(view: EditorView) {
    const button = document.createElement("button"), icon = document.createElement("span"), description = document.createElement("span"), title = document.createElement("strong"), preview = document.createElement("span");
    button.type = "button"; button.className = "manuscript-group-link manuscript-group-" + this.group.kind;
    button.dataset.groupFrom = String(this.group.from);
    icon.className = "manuscript-group-icon"; icon.textContent = "▤"; icon.setAttribute("aria-hidden", "true");
    title.textContent = this.group.title || editingText("editing.untitled_page", document.documentElement.lang);
    preview.className = "manuscript-group-preview"; preview.textContent = this.group.preview || editingText("editing.empty_page", document.documentElement.lang);
    description.className = "manuscript-group-description"; description.append(title, preview); button.append(icon, description);
    button.addEventListener("mousedown", event => event.preventDefault()); button.addEventListener("click", () => navigate(view, this.group.from, true));
    if (this.group.kind === "card") {
      styleCardPreview(button, this.group);
      const wrapper = document.createElement("div"), configure = document.createElement("button"); wrapper.className = "cm-card-preview";
      configure.type = "button"; configure.className = "card-configure-trigger"; configure.textContent = "⚙";
      configure.setAttribute("aria-label", editingText("editing.card_configure", document.documentElement.lang));
      configure.addEventListener("mousedown", event => event.preventDefault());
      configure.addEventListener("click", () => configure.dispatchEvent(new CustomEvent(cardConfigurationEvent, {bubbles: true, detail: {from: this.group.from}})));
      wrapper.append(button, configure); return wrapper;
    }
    return button;
  }
  ignoreEvent() {return true;}
}
class GroupBack extends WidgetType {
  readonly parent: number | null;
  constructor(parent: number | null) {super(); this.parent = parent;}
  eq(other: GroupBack) {return this.parent === other.parent;}
  toDOM(view: EditorView) {
    const wrapper = document.createElement("div"), button = document.createElement("button"); wrapper.className = "cm-group-navigation";
    button.type = "button"; button.className = "manuscript-group-back";
    button.textContent = "← " + editingText("editing.back_to_parent", document.documentElement.lang);
    button.setAttribute("aria-label", editingText("editing.back_to_parent", document.documentElement.lang));
    button.addEventListener("mousedown", event => event.preventDefault()); button.addEventListener("click", () => navigate(view, this.parent));
    wrapper.append(button); return wrapper;
  }
  ignoreEvent() {return true;}
}
function projection(state: EditorState, value: Omit<GroupView, "decorations" | "atomic">): GroupView {
  const ranges: Range<Decoration>[] = [], atomic: Range<Decoration>[] = [], active = value.groups.find(group => group.from === value.focus);
  if (active) {
    if (active.bodyFrom) ranges.push(Decoration.replace({block: true, inclusive: false}).range(0, active.bodyFrom));
    if (active.bodyTo < state.doc.length) ranges.push(Decoration.replace({block: true, inclusive: false}).range(active.bodyTo, state.doc.length));
    const parent = groupAt(value.groups, active.from, active.to);
    ranges.push(Decoration.widget({widget: new GroupBack(parent?.from ?? null), block: true, side: -1}).range(active.bodyFrom));
    if (active.titleLine) ranges.push(Decoration.line({attributes: {class: "cm-manuscript-group-title"}}).range(active.titleLine.from));
  }
  for (const group of childGroups(value.groups, active)) {
    const range = Decoration.replace({widget: new GroupPreview(group), block: true, inclusive: false}).range(group.from, group.to);
    ranges.push(range); atomic.push(range);
  }
  return {...value, decorations: Decoration.set(ranges, true), atomic: Decoration.set(atomic, true)};
}
function groups(state: EditorState) {
  const format = state.field(styledDocument).format;
  return format ? manuscriptGroups(state.doc.toString(), format) : [];
}

/** 单个编辑器保留完整正文及历史，只投影当前分组；导航不进入正文撤销。 */
export const groupView = StateField.define<GroupView>({
  create: state => projection(state, {groups: groups(state), focus: null, returnTops: new Map()}),
  update(value, transaction) {
    const effect = transaction.effects.find(effect => effect.is(focusGroup));
    if (!transaction.docChanged && !transaction.selection && !effect) return value;
    const nextGroups = transaction.docChanged ? groups(transaction.state) : value.groups;
    let focus = value.focus === null ? null : transaction.changes.mapPos(value.focus, 1);
    const returnTops = transaction.docChanged ? new Map([...value.returnTops].map(([from, top]) => [transaction.changes.mapPos(from, 1), top])) : new Map(value.returnTops);
    if (effect) {focus = effect.value.from; if (effect.value.entering) returnTops.set(effect.value.entering.from, effect.value.entering.top);}
    if (!nextGroups.some(group => group.from === focus)) focus = null;
    if (!transaction.docChanged && value.focus === focus && !effect) return value;
    return projection(transaction.state, {groups: nextGroups, focus, returnTops});
  },
  provide: field => [EditorView.decorations.from(field, value => value.decorations), EditorView.atomicRanges.of(view => view.state.field(field).atomic)],
});

export function revealGroup(view: EditorView, from: number, to = from) {
  const value = view.state.field(groupView, false);
  if (!value) return;
  const target = groupAt(value.groups, from, to)?.from ?? null;
  if (target !== value.focus) view.dispatch({effects: focusGroup.of({from: target})});
}

export const groupedMarkdown = [groupView, EditorState.transactionFilter.of(transaction => {
  if (!transaction.selection || transaction.docChanged || transaction.effects.some(effect => effect.is(focusGroup))) return transaction;
  const value = transaction.startState.field(groupView), active = value.groups.find(group => group.from === value.focus);
  if (!active) return transaction;
  const clamp = (position: number) => Math.max(active.bodyFrom, Math.min(active.bodyTo, position));
  const selection = EditorSelection.create(transaction.newSelection.ranges.map(range => EditorSelection.range(clamp(range.anchor), clamp(range.head))), transaction.newSelection.mainIndex);
  return selection.eq(transaction.newSelection) ? transaction : [transaction, {selection}];
}), keymap.of([
  {key: "Mod-a", run(view) {
    const value = view.state.field(groupView), active = value.groups.find(group => group.from === value.focus);
    if (!active) return false;
    view.dispatch({selection: {anchor: active.bodyFrom, head: active.bodyTo}}); return true;
  }},
  ...(["Backspace", "Delete"] as const).map(key => ({key, run(view: EditorView) {
    const value = view.state.field(groupView), active = value.groups.find(group => group.from === value.focus), selection = view.state.selection.main;
    return !!active && selection.empty && selection.head === (key === "Backspace" ? active.bodyFrom : active.bodyTo);
  }})),
])];
