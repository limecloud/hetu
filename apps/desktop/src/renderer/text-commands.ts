import {EditorSelection, Transaction, type ChangeSpec, type EditorState} from "@codemirror/state";
import {isolateHistory, redo, undo} from "@codemirror/commands";
import {EditorView} from "@codemirror/view";
import {manuscriptFormat} from "@hetu/workbench-ui/manuscript-format";
import {parseFountain} from "@hetu/workbench-ui/fountain";
import {toggleInputStyle} from "./inline-input.ts";

export type TextFormat = "markdown" | "fountain" | "plain";
export type TextCommand = "bold" | "italic" | "strike" | "underline" | "code" | "bullet_list" | "ordered_list" | "task_list" | "heading1" | "heading2" | "heading3" | "heading4" | "heading5" | "heading6" | "quote" | "paragraph" | "separator" | "undo" | "redo" | "previous_scene" | "next_scene";
export type ScreenplayElement = "scene" | "action" | "character" | "dialogue" | "parenthetical" | "transition";

export function textCommandPrefix(command: TextCommand, index = 0) {
  return /^heading[1-6]$/.test(command) ? "#".repeat(Number(command.at(-1))) + " " : command === "quote" ? "> " : command === "task_list" ? "- [ ] " : command === "bullet_list" ? "- " : command === "ordered_list" ? `${index + 1}. ` : command === "separator" ? "---\n" : "";
}

function submit(view: EditorView, changes: ChangeSpec[], anchor: number, head: number) {
  const changeSet = view.state.changes(changes);
  if (changeSet.empty) return false;
  view.dispatch({changes: changeSet, selection: EditorSelection.single(changeSet.mapPos(anchor, anchor <= head ? 1 : -1), changeSet.mapPos(head, head >= anchor ? -1 : 1)),
    annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")], scrollIntoView: true});
  view.focus(); return true;
}
function selectedLines(state: EditorState) {
  const {from, to} = state.selection.main, first = state.doc.lineAt(from), end = state.doc.lineAt(to);
  const last = to > from && to === end.from ? Math.max(first.number, end.number - 1) : end.number;
  return Array.from({length: last - first.number + 1}, (_, index) => state.doc.line(first.number + index));
}
function inline(view: EditorView, mark: string, aliases = true) {
  const {state} = view, selection = state.selection.main, changes: ChangeSpec[] = [];
  if (selection.empty) {
    const from = selection.from, before = state.sliceDoc(Math.max(0, from - mark.length), from), after = state.sliceDoc(from, from + mark.length);
    if (before === mark && after === mark) return submit(view, [{from: from - mark.length, to: from}, {from, to: from + mark.length}], from, from);
    view.dispatch({changes: {from, insert: mark + mark}, selection: {anchor: from + mark.length}, annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")]});
    view.focus(); return true;
  }
  for (const line of selectedLines(state)) {
    let from = Math.max(line.from, selection.from), to = Math.min(line.to, selection.to);
    const value = state.sliceDoc(from, to), leading = value.length - value.trimStart().length, trailing = value.length - value.trimEnd().length;
    from += leading; to -= trailing; if (to <= from) continue;
    const style = mark === "**" ? "strong" : mark === "`" ? "code" : mark === "~~" ? "strike" : "emphasis";
    const formatted = manuscriptFormat(line.text);
    const containing = formatted.styles.filter(span => span.style === style && span.from <= from - line.from && span.to >= to - line.from)
      .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
    if (containing) {
      const a = line.from + containing.from, b = line.from + containing.to;
      const actual = state.sliceDoc(a, a + mark.length);
      if (actual === mark || aliases && (mark === "**" && actual === "__" || mark === "*" && actual === "_")) {
        const onlyMarks = (start: number, end: number) => {
          let cursor = start - line.from;
          for (const hidden of formatted.hidden) if (hidden.from <= cursor && hidden.to > cursor) cursor = hidden.to;
          return cursor >= end - line.from;
        };
        changes.push(from <= a + actual.length || onlyMarks(a + actual.length, from) ? {from: a, to: a + actual.length} : {from, insert: actual});
        changes.push(to >= b - actual.length || onlyMarks(to, b - actual.length) ? {from: b - actual.length, to: b} : {from: to, insert: actual}); continue;
      }
    }
    changes.push({from, insert: mark}, {from: to, insert: mark});
  }
  return submit(view, changes, selection.anchor, selection.head);
}

export function runTextCommand(view: EditorView, command: TextCommand, format: TextFormat): boolean {
  if (view.composing || view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
  if (command === "undo" || command === "redo") { const changed = command === "undo" ? undo(view) : redo(view); view.focus(); return changed; }
  if (command === "previous_scene" || command === "next_scene") {
    if (format !== "fountain") return false;
    const scenes = parseFountain(view.state.doc.toString()).lines.filter(line => line.kind === "scene"), position = view.state.selection.main.head;
    const current = scenes.findLastIndex(line => line.from <= position), next = command === "next_scene" ? current + 1 : current - 1;
    const scene = scenes[next]; if (!scene) return false;
    view.dispatch({selection: {anchor: scene.textFrom}, effects: EditorView.scrollIntoView(scene.from, {y: "start"}), annotations: Transaction.userEvent.of("select")}); view.focus(); return true;
  }
  if (format === "plain") return false;
  if (format === "markdown" && ["bold", "italic", "strike", "code"].includes(command) && toggleInputStyle(view, command as "bold" | "italic" | "strike" | "code")) return true;
  if (command === "bold" || command === "italic") return inline(view, command === "bold" ? "**" : "*", format === "markdown");
  if (command === "underline") return format === "fountain" && inline(view, "_", false);
  if (command === "code") return format === "markdown" && inline(view, "`");
  if (command === "strike") return format === "markdown" && inline(view, "~~");
  if (format !== "markdown") return false;
  const lines = selectedLines(view.state), selection = view.state.selection.main;
  if (["bullet_list", "ordered_list", "task_list"].includes(command)) {
    const markers = lines.map(line => /^(\s*)([-+*][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/.exec(line.text));
    const matches = (marker: RegExpExecArray | null) => !!marker && (command === "task_list" ? /\[[ xX]\]/.test(marker[2]) : command === "ordered_list" ? /^\d/.test(marker[2]) : !/^\d/.test(marker[2]) && !/\[[ xX]\]/.test(marker[2]));
    const remove = markers.every(matches);
    return submit(view, lines.map((line, index) => {
      const marker = markers[index], indent = marker?.[1] ?? /^\s*/.exec(line.text)![0];
      return {from: line.from + indent.length, to: line.from + (marker?.[0].length ?? indent.length), insert: remove ? "" : textCommandPrefix(command, index)};
    }), selection.anchor, selection.head);
  }
  if (command === "separator") {
    const at = lines.at(-1)!.to, insert = at === view.state.doc.length ? "\n\n---\n\n" : "\n\n---\n";
    view.dispatch({changes: {from: at, insert}, selection: {anchor: at + insert.length}, annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")]}); view.focus(); return true;
  }
  const changes: ChangeSpec[] = [];
  for (const line of lines) {
    if (!line.text.trim() && !selection.empty) continue;
    const prefix = /^ {0,3}(?:#{1,6}[ \t]+|(?:> ?)+|[-+*][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/.exec(line.text)?.[0] ?? "";
    const insert = command === "quote" && /^ {0,3}>/.test(line.text) ? "" : textCommandPrefix(command);
    const remove = command === "quote" ? /^ {0,3}> ?/.exec(line.text)?.[0] ?? "" : prefix;
    if (remove !== insert) changes.push({from: line.from, to: line.from + remove.length, insert});
  }
  return submit(view, changes, selection.anchor, selection.head);
}

export function setScreenplayElement(view: EditorView, target: ScreenplayElement) {
  if (view.composing || view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
  const source = view.state.doc.toString(), physical = view.state.doc.lineAt(view.state.selection.main.head), script = parseFountain(source);
  const index = script.lines.findIndex(line => line.from === physical.from), line = script.lines[index];
  if (!line) throw new Error("请在剧本正文中选择元素；标题页请从原稿修改。");
  if (line.kind === target) return false;
  const previous = script.lines[index - 1], inDialogue = previous && ["character", "dialogue", "parenthetical", "lyric"].includes(previous.kind);
  if (["dialogue", "parenthetical"].includes(target) && !inDialogue) throw new Error("对白与括注需要放在人物提示之后。");
  const start = physical.from + physical.text.length - physical.text.trimStart().length;
  if (!["blank", "scene", "action", "character", "dialogue", "parenthetical", "transition", "lyric"].includes(line.kind)) throw new Error("此元素请从原稿修改。");
  const contentEnd = physical.from + physical.text.trimEnd().length, trailing = source.slice(contentEnd, physical.to);
  let from = line.textFrom, to = contentEnd;
  if (line.kind === "parenthetical" && source[from] === "(" && source[to - 1] === ")") { from++; to--; }
  const prefix = target === "scene" ? "." : target === "action" ? "!" : target === "character" ? "@" : target === "transition" ? "> " : target === "parenthetical" ? "(" : "";
  const suffix = target === "parenthetical" ? ")" : "";
  const changes: ChangeSpec[] = [{from: start, to: from, insert: prefix}, {from: to, to: physical.to, insert: suffix + trailing}];
  const changeSet = view.state.changes(changes), next = changeSet.apply(view.state.doc).toString();
  const actual = parseFountain(next).lines.find(row => row.from === physical.from);
  if (actual?.kind !== target && !(target === "dialogue" && actual?.kind === "blank")) throw new Error("当前文字含有其他剧本标记，请先在原稿中核对后转换。");
  view.dispatch({changes: changeSet, selection: {anchor: Math.min(changeSet.newLength, start + prefix.length)}, annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")]}); view.focus(); return !changeSet.empty;
}

export function insertPlainText(view: EditorView, text: string) {
  if (view.composing || view.state.readOnly) return false;
  view.dispatch({...view.state.replaceSelection(text), annotations: [Transaction.userEvent.of("input.paste"), isolateHistory.of("full")], scrollIntoView: true}); view.focus(); return true;
}
