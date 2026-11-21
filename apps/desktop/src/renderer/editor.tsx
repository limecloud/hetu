import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, undoDepth, redoDepth, isolateHistory } from "@codemirror/commands";
import { editorSource, editorSourceHistory, editorSourceSelection, editorClipboardText, restoreEditorSource } from "./editor-source.ts";
import { screenplayEditing,screenplayStart,screenplayContext } from "./screenplay-editor.ts";
import {manuscriptLayoutEvent, sourceOffsets, type AnnotationSurface, type SourceQuote} from "./annotation-anchors.ts";
import {manuscriptLines, mappedSourceSelection} from "@hetu/workbench-ui";
import {writingBehavior, type WritingBehavior} from "./editor-behavior.ts";
import {markdownEditing, markdownPresentation} from "./editor-format.ts";
import {runTextCommand, setScreenplayElement, insertPlainText, type TextCommand, type TextFormat, type ScreenplayElement} from "./text-commands.ts";
import {activeTextCommands} from "./text-command-context.ts";
import {inputStyleIntent, inlineComposition, finishInlineComposition, inlineInputIntent, setInlinePresentation, presentationContext} from "./inline-input.ts";
import type {InlinePresentation, BlockPresentation, ManuscriptPresentation} from "@hetu/workbench-ui/manuscript-styles";
import {setBlockPresentation, captureCardPresentation} from "./block-format.ts";
import type {CardEdit} from "@hetu/workbench-ui/card-configuration";
import {captureEditorContext, type EditorContextTarget} from "./editor-context-target.ts";
import {continueMarkdownList, deleteMarkdownMarkup} from "./markdown-input.ts";
import {revealGroup, groupView} from "./grouped-markdown.ts";
import {clipboardMarkdown} from "./clipboard-markdown.ts";

export interface EditorContext { canUndo: boolean; canRedo: boolean; element?: string; previousScene?: boolean; nextScene?: boolean; activeCommands?: TextCommand[]; presentation?: ManuscriptPresentation; mixedPresentation?: (keyof ManuscriptPresentation)[] }
export interface AuthorEditorHandle extends AnnotationSurface {
  focus: () => void;
  command: (command: TextCommand) => boolean;
  presentation: (patch: InlinePresentation) => boolean;
  blockPresentation: (patch: BlockPresentation) => boolean;
  captureCard: (position?: number, origin?: EventTarget | null) => CardEdit | undefined;
  element: (element: ScreenplayElement) => boolean;
  insert: (text: string) => boolean;
  captureInsertion: () => ((text: string) => boolean) | undefined;
  replace: (source: string, changes: {from: number; to: number; insert: string}[]) => boolean;
  contextMenu: (point?: {x: number; y: number; target?: EventTarget | null}) => EditorContextTarget | undefined;
}

const externalContent = Annotation.define<boolean>();
const proseDecoration = StateField.define<DecorationSet>({
  create: state => Decoration.set(manuscriptLines(state.doc.toString()).filter(line => line.prose).map(line => Decoration.line({attributes: {"data-prose": "true"}}).range(line.from))),
  update: (decorations, transaction) => transaction.docChanged
    ? Decoration.set(manuscriptLines(transaction.newDoc.toString()).filter(line => line.prose).map(line => Decoration.line({attributes: {"data-prose": "true"}}).range(line.from))) : decorations,
  provide: field => EditorView.decorations.from(field),
});

export const AuthorEditor = forwardRef<AuthorEditorHandle, {
  content: string;
  disabled: boolean;
  onChange: (content: string) => void;
  onSave: () => void;
  onCompositionChange: (active: boolean) => void;
  searchMatches?: SourceQuote[];
  activeSearchMatch?: number;
  indent?: boolean;
  screenplay?: boolean;
  format?: TextFormat;
  raw?: boolean;
  screenplayTitle?:string;
  jumpTo?: {offset:number;request:number};
  scrollTop?: number;
  onScroll?: (top: number) => void;
  externalScroll?: boolean;
  annotations?: SourceQuote[];
  behavior?: WritingBehavior;
  onContext?: (context: EditorContext) => void;
  onSelectionChange?: (selection: { byte_start: number; byte_end: number; quote: string } | null) => void;
}>((props, ref) => {
  const container = useRef<HTMLDivElement>(null),
    view = useRef<EditorView>();
  const callbacks = useRef(props),
    editable = useRef(new Compartment()),formatting=useRef(new Compartment()),annotations=useRef(new Compartment()),behavior=useRef(new Compartment()),searching=useRef(new Compartment()),presentation=useRef(new Compartment());
  const localEditGeneration = useRef(0), renderEditGeneration = localEditGeneration.current;
  callbacks.current = props;
  function currentContext(editor: EditorView): EditorContext {
    return {canUndo: undoDepth(editor.state) > 0, canRedo: redoDepth(editor.state) > 0,
      activeCommands: activeTextCommands(editor.state, callbacks.current.format ?? "plain"),
      ...(callbacks.current.format === "markdown" ? presentationContext(editor.state) : {}), ...screenplayContext(editor.state)};
  }
  function context(editor: EditorView) {callbacks.current.onContext?.(currentContext(editor));}
  function editorOffsets(quote: SourceQuote) {
    const source = view.current?.state.field(editorSource);
    if (source === undefined) return null;
    const offsets = sourceOffsets(source, quote);
    return offsets && {from: source.slice(0, offsets.from).replace(/\r\n?/g, "\n").length, to: source.slice(0, offsets.to).replace(/\r\n?/g, "\n").length};
  }
  useImperativeHandle(ref, () => ({
    focus() {view.current?.focus();},
    contextMenu(point) {
      const editor = view.current; if (!editor || editor.composing) return;
      const group = point?.target instanceof Element ? point.target.closest<HTMLElement>("[data-group-from]") : null;
      const groupFrom = group ? Number(group.dataset.groupFrom) : undefined;
      const item = groupFrom === undefined ? undefined : editor.state.field(groupView, false)?.groups.find(item => item.from === groupFrom);
      if (item) editor.dispatch({selection: {anchor: item.from, head: item.to}});
      else if (point) {
        const pos = editor.posAtCoords(point, false), selected = editor.state.selection.main;
        if (pos !== null && (selected.empty || pos < selected.from || pos > selected.to)) editor.dispatch({selection: {anchor: pos}});
      }
      return captureEditorContext(editor, callbacks.current.format ?? "plain", !!callbacks.current.raw, currentContext(editor));
    },
    command(command) { return !!view.current && runTextCommand(view.current, command, callbacks.current.format ?? "plain"); },
    presentation(patch) { return !!view.current && callbacks.current.format === "markdown" && setInlinePresentation(view.current, patch); },
    blockPresentation(patch) { return !!view.current && callbacks.current.format === "markdown" && setBlockPresentation(view.current, patch); },
    captureCard(position, origin) {
      const editor = view.current;
      if (!editor || callbacks.current.format !== "markdown" || callbacks.current.raw || origin && (!(origin instanceof Node) || !editor.dom.contains(origin))) return;
      return captureCardPresentation(editor, position);
    },
    element(element) { return !!view.current && callbacks.current.format === "fountain" && setScreenplayElement(view.current, element); },
    insert(text) { return !!view.current && insertPlainText(view.current, text); },
    captureInsertion() {
      const editor = view.current;
      if (!editor || editor.composing || editor.state.readOnly) return;
      const document = editor.state.doc, selection = editor.state.selection;
      return text => view.current === editor && editor.state.doc === document && editor.state.selection.eq(selection) && insertPlainText(editor, text);
    },
    replace(source, changes) {
      const editor = view.current;
      if (!editor || editor.composing || editor.state.readOnly || editor.state.field(editorSource) !== source) return false;
      const mapped = changes.map(change => ({from: source.slice(0, change.from).replace(/\r\n?/g, "\n").length, to: source.slice(0, change.to).replace(/\r\n?/g, "\n").length, insert: change.insert}));
      editor.dispatch({changes: mapped, annotations: [Transaction.userEvent.of("input.replace"), isolateHistory.of("full")], scrollIntoView: true}); return true;
    },
    anchorAt(y) {
      const editor = view.current;
      if (!editor) return;
      let pos = editor.posAtCoords({x: editor.contentDOM.getBoundingClientRect().left + 8, y}, false);
      const grouped = editor.state.field(groupView, false), active = grouped?.groups.find(group => group.from === grouped.focus);
      if (active && (pos === null || pos < active.bodyFrom || pos > active.bodyTo)) pos = active.titleLine?.runs[0]?.from ?? active.bodyFrom;
      if (pos === null || pos > editor.state.doc.length) return;
      // 换行没有稳定的字形坐标，阅读锚点固定到命中行的实际文字。
      const line = editor.state.doc.lineAt(pos);
      if (!line.length) return;
      pos = Math.min(pos, line.to - 1);
      const from = pos > 0 && /[\uDC00-\uDFFF]/.test(editor.state.doc.sliceString(pos, pos + 1)) ? pos - 1 : pos;
      return editorSourceSelection(editor.state, from, from + String.fromCodePoint(editor.state.doc.toString().codePointAt(from)!).length);
    },
    locate(quote) {
      const offsets = editorOffsets(quote), editor = view.current;
      if (offsets && editor) { revealGroup(editor, offsets.from, offsets.to); const panel = editor.dom.closest(".manuscript-stage")?.querySelector<HTMLElement>(".manuscript-search"); editor.dispatch({effects: EditorView.scrollIntoView(offsets.from, {y: "nearest", yMargin: (panel?.offsetHeight ?? 0) + 16})}); }
    },
    rect(quote) {
      const offsets = editorOffsets(quote), editor = view.current;
      if (!offsets || !editor) return null;
      const start = editor.coordsAtPos(offsets.from), end = editor.coordsAtPos(offsets.to);
      if (!start) return null;
      return new DOMRect(start.left, start.top, Math.max(1, (end?.right ?? start.right) - start.left), Math.max(start.bottom, end?.bottom ?? 0) - start.top);
    },
    reveal(quote) {
      const offsets = editorOffsets(quote), editor = view.current;
      if (offsets && editor) { revealGroup(editor, offsets.from, offsets.to); editor.dispatch({selection: {anchor: offsets.from, head: offsets.to}, effects: EditorView.scrollIntoView(offsets.from, {y: "center"})}); editor.focus(); }
    },
    contains(quote, x, y) { return document.elementFromPoint(x, y)?.closest("[data-note-range]")?.getAttribute("data-note-range") === `${quote.byte_start}:${quote.byte_end}`; },
  }), []);
  useEffect(() => {
    const editor = new EditorView({
      parent: container.current!,
      state: EditorState.create({
        doc: props.content,
        extensions: [
          editorSource.init(() => props.content),
          editorSourceHistory,
          history(),
          EditorView.lineWrapping,
          formatting.current.of(props.screenplay?screenplayEditing(props.screenplayTitle??""):props.indent?proseDecoration:[]),
          props.format === "markdown" ? markdownEditing : [],
          presentation.current.of(props.format === "markdown" && !props.raw ? markdownPresentation : []),
          annotations.current.of([]),
          searching.current.of([]),
          behavior.current.of(writingBehavior(props.behavior ?? {})),
          EditorView.scrollMargins.of(editor => props.externalScroll ? {top: (editor.dom.closest(".manuscript-stage")?.querySelector<HTMLElement>(".manuscript-search")?.offsetHeight ?? 0) + 16, bottom: 20} : {}),
          EditorView.domEventHandlers({
            paste: (event, editor) => {
              const html = event.clipboardData?.getData("text/html");
              if (!html || callbacks.current.format !== "markdown" || callbacks.current.raw || editor.composing || editor.state.readOnly) return false;
              event.preventDefault();
              return insertPlainText(editor, clipboardMarkdown({text: event.clipboardData?.getData("text/plain") ?? "", html}));
            },
            copy: (event, editor) => {
              const {from, to} = editor.state.selection.main;
              if (from === to || !event.clipboardData) return false;
              event.clipboardData.setData("text/plain", editorClipboardText(editor.state, from, to, callbacks.current.format === "markdown" && !callbacks.current.raw)); event.preventDefault(); return true;
            },
            cut: (event, editor) => {
              const {from, to} = editor.state.selection.main;
              if (from === to || !event.clipboardData || editor.composing) return false;
              event.clipboardData.setData("text/plain", editorClipboardText(editor.state, from, to, callbacks.current.format === "markdown" && !callbacks.current.raw)); event.preventDefault();
              if (!editor.state.readOnly) editor.dispatch({...editor.state.replaceSelection(""), annotations: [Transaction.userEvent.of("delete.cut"), isolateHistory.of("full")]});
              return true;
            },
            compositionstart: (_event, editor) => {
              if (editor.state.field(inlineInputIntent, false)) editor.dispatch({effects: inlineComposition.of("start")});
              callbacks.current.onCompositionChange(true);
            },
            compositionend: (_event, editor) => {
              requestAnimationFrame(() => {if (view.current === editor) finishInlineComposition(editor);});
              callbacks.current.onCompositionChange(false);
            },
          }),
          keymap.of([
            {key: "Enter", run: editor => callbacks.current.format === "markdown" && !editor.composing && continueMarkdownList(editor)},
            {key: "Backspace", run: editor => callbacks.current.format === "markdown" && !editor.composing && deleteMarkdownMarkup(editor)},
            {key: "Mod-b", run: editor => runTextCommand(editor, "bold", callbacks.current.format ?? "plain")},
            {key: "Mod-i", run: editor => runTextCommand(editor, "italic", callbacks.current.format ?? "plain")},
            {key: "Mod-u", run: editor => runTextCommand(editor, "underline", callbacks.current.format ?? "plain")},
            {key: "Mod-Alt-1", run: editor => runTextCommand(editor, "heading1", callbacks.current.format ?? "plain")},
            {key: "Mod-Alt-2", run: editor => runTextCommand(editor, "heading2", callbacks.current.format ?? "plain")},
            ...([3, 4, 5, 6] as const).map(level => ({key: "Mod-Alt-" + level, run: (editor: EditorView) => runTextCommand(editor, "heading" + level as TextCommand, callbacks.current.format ?? "plain")})),
            {key:"Mod-a",run:v=>{
              if(!callbacks.current.screenplay)return false;
              const start=screenplayStart(v.state.doc.toString(),callbacks.current.screenplayTitle??"");
              v.dispatch({selection:{anchor:start,head:v.state.doc.length}});return true;
            }},
            {
              key: "Mod-s",
              run: (v) => {
                if (!v.composing && !callbacks.current.disabled)
                  callbacks.current.onSave();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          editable.current.of(EditorState.readOnly.of(props.disabled)),
          EditorView.contentAttributes.of({
            "aria-label": "文稿编辑",
            role: "textbox",
            "aria-multiline": "true",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet || update.transactions.some(transaction => transaction.reconfigured || transaction.effects.some(effect => effect.is(inputStyleIntent)))) context(update.view);
            if (update.geometryChanged || update.viewportChanged) container.current?.dispatchEvent(new Event(manuscriptLayoutEvent, {bubbles: true}));
            if (update.docChanged && !update.transactions.every(transaction => transaction.annotation(externalContent))) {
              localEditGeneration.current++;
              callbacks.current.onChange(update.state.field(editorSource));
            }
            if ((update.selectionSet || update.docChanged) && !update.view.composing) {
              const { from, to } = update.state.selection.main;
              callbacks.current.onSelectionChange?.(from === to ? null : editorSourceSelection(update.state, from, to));
            }
          }),
          EditorView.theme({
            "&": { fontSize: "var(--reader-font-size, 20px)", lineHeight: "var(--reader-line-height, 1.75)", height: props.externalScroll ? "auto" : "100%", backgroundColor: "transparent" },
            ".cm-content": {
              fontFamily: "inherit",
              padding: "8px 0 32px",
              minHeight: "100%",
            },
            ".cm-scroller": { fontFamily: "var(--reader-font, serif)", lineHeight: "var(--reader-line-height, 1.75)", overflow: props.externalScroll ? "visible" : "auto" },
            ".cm-line": { padding: "0 4px" },
            "&.cm-focused": {
              outline: "none",
            },
          }),
        ],
      }),
    });
    view.current = editor;
    context(editor);
    const reportScroll = () => callbacks.current.onScroll?.(editor.scrollDOM.scrollTop);
    editor.scrollDOM.addEventListener("scroll", reportScroll);
    const initialTop = props.scrollTop ?? 0;
    if (!props.externalScroll) editor.requestMeasure({ read: () => initialTop, write: (top) => { editor.scrollDOM.scrollTop = top; } });
    return () => {
      editor.scrollDOM.removeEventListener("scroll", reportScroll);
      view.current = undefined;
      editor.destroy();
    };
  }, []);
  useLayoutEffect(() => {
    const editor = view.current;
    // 旧渲染的内容回传不能覆盖其后发生的本地输入或清空光标格式。
    if (renderEditGeneration !== localEditGeneration.current) return;
    if (editor && editor.state.field(editorSource) !== props.content)
      editor.dispatch({
        changes: {
          from: 0,
          to: editor.state.doc.length,
          insert: props.content,
        },
        effects: restoreEditorSource.of(props.content),
        annotations: [externalContent.of(true), Transaction.addToHistory.of(false)],
      });
  }, [props.content]);
  useEffect(() => { view.current?.dispatch({effects: behavior.current.reconfigure(writingBehavior(props.behavior ?? {}))}); }, [props.behavior?.focusParagraph, props.behavior?.typewriter, props.behavior?.smartPairs]);
  useEffect(() => {view.current?.dispatch({effects: presentation.current.reconfigure(props.format === "markdown" && !props.raw ? markdownPresentation : [])});}, [props.format, props.raw]);
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(
        EditorState.readOnly.of(props.disabled),
      ),
    });
  }, [props.disabled]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const marks = (props.annotations ?? []).flatMap(quote => {
      const offsets = editorOffsets(quote);
      return offsets ? [Decoration.mark({class: "annotated-source", attributes: {"data-note-range": `${quote.byte_start}:${quote.byte_end}`}}).range(offsets.from, offsets.to)] : [];
    });
    const highlights = StateField.define<DecorationSet>({
      create: () => Decoration.set(marks, true),
      // 一旦开始编辑就清除固定修订的标记，不把旧位置映射到未保存稿。
      update: (value, transaction) => transaction.docChanged ? Decoration.none : value,
      provide: field => EditorView.decorations.from(field),
    });
    editor.dispatch({effects: annotations.current.reconfigure(highlights)});
  }, [props.annotations, props.content]);
  useEffect(()=>{
    const editor=view.current;if(!editor)return;
    const start=props.screenplay?screenplayStart(editor.state.doc.toString(),props.screenplayTitle??""):0;
    editor.dispatch({effects:formatting.current.reconfigure(props.screenplay?screenplayEditing(props.screenplayTitle??""):props.indent?proseDecoration:[]),
      ...(props.screenplay&&editor.state.selection.main.from<start?{selection:{anchor:start}}:{})});
  },[props.screenplay,props.screenplayTitle,props.indent]);
  useEffect(()=>{
    const editor=view.current;
    if(!editor||!props.jumpTo)return;
    const offset=Math.min(props.content.slice(0,props.jumpTo.offset).replace(/\r\n?|\n/g,"\n").length,editor.state.doc.length);
    editor.dispatch({selection:{anchor:offset},effects:EditorView.scrollIntoView(offset,{y:"start"})});
    editor.focus();
  },[props.jumpTo]);
  useEffect(() => {
    const marks = (props.searchMatches ?? []).flatMap((quote, index) => { const range = editorOffsets(quote); return range ? [Decoration.mark({class: index === props.activeSearchMatch ? "search-current" : "search-match"}).range(range.from, range.to)] : []; });
    const field = StateField.define<DecorationSet>({create: () => Decoration.set(marks, true), update: (value, transaction) => transaction.docChanged ? Decoration.none : value, provide: field => EditorView.decorations.from(field)});
    view.current?.dispatch({effects: searching.current.reconfigure(field)});
  }, [props.searchMatches, props.activeSearchMatch]);
  return <div className={"author-editor"+(props.screenplay?" screenplay-editor":"")} data-indent={props.indent || undefined} data-focus-paragraph={props.behavior?.focusParagraph || undefined} data-typewriter={props.behavior?.typewriter || undefined} ref={container} />;
});

/** 浏览器选区是 UTF-16；保存的来源范围按固定原文 UTF-8 字节计算。 */
export const selectedSource = mappedSourceSelection;
