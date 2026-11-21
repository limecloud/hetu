import type {EditorState} from "@codemirror/state";
import {ensureSyntaxTree, syntaxTree} from "@codemirror/language";
import {fountainRuns} from "@hetu/workbench-ui/fountain";
import type {TextCommand, TextFormat} from "./text-commands.ts";
import {inlineInputIntent} from "./inline-input.ts";

/** 格式状态由原文语法和确切选区推导，不另存文稿样式。 */
export function activeTextCommands(state: EditorState, format: TextFormat): TextCommand[] {
  const selection = state.selection.main, active = new Set<TextCommand>();
  if (format === "fountain") {
    const line = state.doc.lineAt(selection.from), from = selection.from - line.from, to = selection.to - line.from;
    for (const run of fountainRuns(line.text, 0, line.length)) {
      if (!run.style) continue;
      const mark = run.style === "bold-italic" ? 3 : run.style === "bold" ? 2 : 1;
      if (!(run.from <= from && run.to >= to || from === run.from - mark && to === run.to + mark)) continue;
      if (run.style === "bold" || run.style === "bold-italic") active.add("bold");
      if (run.style === "italic" || run.style === "bold-italic") active.add("italic");
      if (run.style === "underline") active.add("underline");
    }
  } else if (format === "markdown") {
    const bias = selection.empty && selection.from > state.doc.lineAt(selection.from).from ? -1 : 1;
    const first = (ensureSyntaxTree(state, selection.to, 30) ?? syntaxTree(state)).resolveInner(selection.from, bias);
    let paragraph = false;
    for (let node: typeof first | null = first; node; node = node.parent) {
      if (node.from > selection.from || node.to < selection.to) continue;
      if (/^(?:ATX|Setext)Heading[1-6]$/.test(node.name)) active.add("heading" + node.name.at(-1) as TextCommand);
      if (node.name === "Blockquote") active.add("quote");
      if (node.name === "Task") active.add("task_list");
      if (node.name === "BulletList" && !active.has("task_list")) active.add("bullet_list");
      if (node.name === "OrderedList") active.add("ordered_list");
      if (node.name === "Paragraph") paragraph = true;
      const command: TextCommand | undefined = node.name === "StrongEmphasis" ? "bold" : node.name === "Emphasis" ? "italic" : node.name === "InlineCode" ? "code" : node.name === "Strikethrough" ? "strike" : undefined;
      if (command && (selection.from === node.from && selection.to === node.to || selection.from >= (node.firstChild?.to ?? node.from) && selection.to <= (node.lastChild?.from ?? node.to))) active.add(command);
    }
    if (paragraph && !active.has("quote") && ![...active].some(command => command.startsWith("heading"))) active.add("paragraph");
  }
  const intent = selection.empty && state.field(inlineInputIntent, false);
  if (intent) {
    for (const value of ["bold", "italic", "strike", "code"] as const) active.delete(value);
    for (const value of intent.styles) active.add(value);
  }
  return [...active].sort();
}
