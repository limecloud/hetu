import React, { useEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { editorSource, editorSourceHistory, editorSourceSelection, restoreEditorSource } from "./editor-source.ts";

const externalContent = Annotation.define<boolean>();

export function AuthorEditor(props: {
  content: string;
  disabled: boolean;
  onChange: (content: string) => void;
  onSave: () => void;
  onCompositionChange: (active: boolean) => void;
  search?: string;
  indent?: boolean;
  scrollTop?: number;
  onScroll?: (top: number) => void;
  onSelectionChange?: (selection: { byte_start: number; byte_end: number; quote: string } | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    view = useRef<EditorView>();
  const callbacks = useRef(props),
    editable = useRef(new Compartment());
  callbacks.current = props;
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
          EditorView.domEventHandlers({
            compositionstart: () => {
              callbacks.current.onCompositionChange(true);
            },
            compositionend: () => {
              callbacks.current.onCompositionChange(false);
            },
          }),
          keymap.of([
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
            if (update.docChanged && !update.transactions.every(transaction => transaction.annotation(externalContent)))
              callbacks.current.onChange(update.state.field(editorSource));
            if (update.selectionSet && update.transactions.some((transaction) => transaction.isUserEvent("select"))) {
              const { from, to } = update.state.selection.main;
              callbacks.current.onSelectionChange?.(from === to ? null : editorSourceSelection(update.state, from, to));
            }
          }),
          EditorView.theme({
            "&": { fontSize: "var(--reader-font-size, 18px)", lineHeight: "calc(1.35em + var(--reader-line-spacing, 5px))", height: "100%", backgroundColor: "transparent" },
            ".cm-content": {
              fontFamily: "var(--reader-font, serif)",
              padding: "8px 0 32px",
              minHeight: "100%",
            },
            ".cm-scroller": { fontFamily: "inherit", overflow: "auto" },
            ".cm-line": { padding: "0 4px" },
            "&.cm-focused": {
              outline: "none",
            },
          }),
        ],
      }),
    });
    view.current = editor;
    const reportScroll = () => callbacks.current.onScroll?.(editor.scrollDOM.scrollTop);
    editor.scrollDOM.addEventListener("scroll", reportScroll);
    const initialTop = props.scrollTop ?? 0;
    editor.requestMeasure({ read: () => initialTop, write: (top) => { editor.scrollDOM.scrollTop = top; } });
    return () => {
      editor.scrollDOM.removeEventListener("scroll", reportScroll);
      view.current = undefined;
      editor.destroy();
    };
  }, []);
  useEffect(() => {
    const editor = view.current;
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
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(
        EditorState.readOnly.of(props.disabled),
      ),
    });
  }, [props.disabled]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !props.search) return;
    const from = editor.state.doc.toString().indexOf(props.search);
    if (from !== -1) editor.dispatch({ selection: { anchor: from, head: from + props.search.length }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
  }, [props.search]);
  return <div className="author-editor" data-indent={props.indent || undefined} ref={container} />;
}

/** 浏览器选区是 UTF-16；保存的来源范围按固定原文 UTF-8 字节计算。 */
export function selectedSource(element: HTMLElement, content: string) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return null;
  const range = selection.getRangeAt(0);
  if (
    !element.contains(range.startContainer) ||
    !element.contains(range.endContainer)
  )
    return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length,
    quote = range.toString();
  if (!quote || content.slice(start, start + quote.length) !== quote)
    return null;
  const encoder = new TextEncoder();
  return {
    byte_start: encoder.encode(content.slice(0, start)).length,
    byte_end: encoder.encode(content.slice(0, start + quote.length)).length,
    quote,
  };
}
