import {markdown, commonmarkLanguage} from "@codemirror/lang-markdown";
import {HighlightStyle, syntaxHighlighting, syntaxTree} from "@codemirror/language";
import {Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate} from "@codemirror/view";
import {Transaction, type Range} from "@codemirror/state";
import {isolateHistory} from "@codemirror/commands";
import {autocompletion, type CompletionContext, type Completion} from "@codemirror/autocomplete";
import {textCommandPrefix, type TextCommand} from "./text-commands.ts";
import {editingText, type EditingKey} from "./editing-labels.ts";
import {tags} from "@lezer/highlight";
import {manuscriptMarkdownExtensions} from "@hetu/workbench-ui/manuscript-format";
import {inlineInput} from "./inline-input.ts";
import {styledDocument} from "./styled-markdown.ts";
import {groupedMarkdown} from "./grouped-markdown.ts";

/** 与阅读视图共用CommonMark；编辑时保留原始标记，不自动转换粘贴或补写内容。 */
export const markdownEditing = [markdown({base: commonmarkLanguage, extensions: manuscriptMarkdownExtensions, addKeymap: false, completeHTMLTags: false, pasteURLAsLink: false}), syntaxHighlighting(HighlightStyle.define([
  {tag: tags.strong, fontWeight: "700"}, {tag: tags.emphasis, fontStyle: "italic"},
  {tag: tags.strikethrough, textDecoration: "line-through"},
  {tag: tags.heading, fontWeight: "600"}, {tag: tags.monospace, fontFamily: "ui-monospace, monospace"},
  {tag: tags.processingInstruction, color: "var(--muted)"},
]))];

class ListMarker extends WidgetType {
  readonly marker: string;
  readonly position?: number;
  readonly checked: boolean;
  constructor(marker: string, position?: number, checked = false) {super(); this.marker = marker; this.position = position; this.checked = checked;}
  eq(other: ListMarker) {return this.marker === other.marker && this.position === other.position && this.checked === other.checked;}
  toDOM(view: EditorView) {
    const node = document.createElement("span"); node.className = "cm-manuscript-list-marker";
    if (this.position === undefined) {node.textContent = this.marker; node.setAttribute("aria-hidden", "true");}
    else {
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = this.checked;
      checkbox.setAttribute("aria-label", editingText("editing.task_list", document.documentElement.lang));
      checkbox.disabled = view.state.readOnly;
      checkbox.addEventListener("mousedown", event => event.preventDefault());
      checkbox.addEventListener("change", () => {
        if (view.composing || view.state.readOnly) return;
        view.dispatch({changes: {from: this.position! + 1, to: this.position! + 2, insert: checkbox.checked ? "x" : " "}, annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")]});
        view.focus();
      });
      node.append(checkbox);
    }
    return node;
  }
  ignoreEvent() {return false;}
}

/** 呈现层仅装饰可见文本；原稿入口保留源标记和同一撤销历史。 */
const markdownDisplay = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  hidden: DecorationSet = Decoration.none;
  constructor(view: EditorView) {this.decorations = this.build(view);}
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) this.decorations = this.build(update.view);
  }
  build(view: EditorView) {
    const ranges: Range<Decoration>[] = [], hidden: Range<Decoration>[] = [], lines = new Set<string>();
    const decorateLine = (position: number, name: string, attributes: Record<string, string> = {}) => {
      const key = position + name;
      if (!lines.has(key)) {lines.add(key); ranges.push(Decoration.line({attributes: {class: name, ...attributes}}).range(position));}
    };
    const hide = (from: number, to: number, widget?: WidgetType) => {
      if (to <= from) return;
      const range = Decoration.replace({widget}).range(from, to); ranges.push(range); hidden.push(range);
    };
    for (const visible of view.visibleRanges) syntaxTree(view.state).iterate({from: visible.from, to: visible.to, enter: node => {
      if (["HTMLBlock", "HTMLTag", "Link", "Image", "LinkReference"].includes(node.name)) return false;
      if (/^(?:ATX|Setext)Heading[1-6]$/.test(node.name)) {
        const line = view.state.doc.lineAt(node.from);
        decorateLine(line.from, "cm-manuscript-heading", {"data-heading-level": node.name.at(-1)!});
      }
      if (node.name === "FencedCode" || node.name === "CodeBlock") {
        const first = view.state.doc.lineAt(Math.max(node.from, visible.from)), last = view.state.doc.lineAt(Math.min(node.to, visible.to));
        for (let number = first.number; number <= last.number; number++) decorateLine(view.state.doc.line(number).from, "cm-manuscript-code");
      }
      if (node.name === "HorizontalRule") {decorateLine(view.state.doc.lineAt(node.from).from, "cm-manuscript-rule"); hide(node.from, node.to); return false;}
      if (!["HeaderMark", "EmphasisMark", "StrikethroughMark", "QuoteMark", "CodeMark", "ListMark", "TaskMarker"].includes(node.name)) return;
      const line = view.state.doc.lineAt(node.from);
      let to = node.to;
      if (node.node.parent?.name === "FencedCode" || node.node.parent?.name.startsWith("Setext")) {
        hide(line.from, line.to); decorateLine(line.from, "cm-manuscript-marker-line"); return;
      }
      if (["HeaderMark", "QuoteMark", "ListMark", "TaskMarker"].includes(node.name)) while (to < line.to && /[ \t]/.test(view.state.sliceDoc(to, to + 1))) to++;
      if (node.name === "QuoteMark") decorateLine(line.from, "cm-manuscript-quote");
      const marker = node.name === "TaskMarker" ? new ListMarker("", node.from, /[xX]/.test(view.state.sliceDoc(node.from, node.to)))
        : node.name === "ListMark" && !node.node.parent?.getChild("Task") ? new ListMarker(/^\d/.test(line.text.trimStart()) ? view.state.sliceDoc(node.from, node.to) : "•") : undefined;
      hide(node.from, to, marker);
    }});
    this.hidden = Decoration.set(hidden, true);
    return Decoration.set(ranges, true);
  }
}, {decorations: instance => instance.decorations});

function blockCompletions(context: CompletionContext) {
  const line = context.state.doc.lineAt(context.pos), before = context.state.sliceDoc(line.from, context.pos);
  if (!/^\s*\/[\p{L}\p{N} _-]{0,40}$/u.test(before) || context.state.sliceDoc(context.pos, line.to).trim()) return null;
  const slash = line.from + before.indexOf("/"), language = document.documentElement.lang;
  const commands: TextCommand[] = ["heading1", "heading2", "heading3", "paragraph", "quote", "bullet_list", "ordered_list", "task_list", "separator"];
  return {from: slash + 1, options: commands.map((command, index): Completion => ({
    label: editingText("editing." + command as EditingKey, language), type: "text", boost: commands.length - index,
    apply(view, _completion, _from, to) {
      if (view.composing || view.state.readOnly || !view.state.sliceDoc(line.from, to).startsWith(before.slice(0, before.indexOf("/")) + "/")) return;
      const insert = textCommandPrefix(command);
      view.dispatch({changes: {from: slash, to, insert}, selection: {anchor: slash + insert.length}, annotations: [Transaction.userEvent.of("input.complete"), isolateHistory.of("full")]});
      view.focus();
    },
  }))};
}

export const markdownPresentation = [inlineInput, styledDocument, groupedMarkdown, markdownDisplay, EditorView.atomicRanges.of(view => view.plugin(markdownDisplay)?.hidden ?? Decoration.none), autocompletion({override: [blockCompletions], activateOnTyping: true, defaultKeymap: true})];
