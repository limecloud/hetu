import React, {useRef, useState} from "react";
import {contextText, useContextMenu, type ContextKey, type ContextMenuItem} from "@hetu/workbench-ui";
import {desktop} from "./bridge.ts";

export function contextKey(event: React.KeyboardEvent) {
  return !event.nativeEvent.isComposing && (event.key === "ContextMenu" || event.shiftKey && event.key === "F10");
}
export function contextShortcut(key: string, shift = false) {
  return /Mac/i.test(navigator.platform) ? (shift ? "⇧⌘" : "⌘") + key : (shift ? "Ctrl+Shift+" : "Ctrl+") + key;
}
export function useObjectContextMenu(notify: (message: string) => void) {
  const show = useContextMenu();
  return (label: string, items: ContextMenuItem[] | (() => ContextMenuItem[])) => {
    const open = (event: React.MouseEvent | React.KeyboardEvent) => show(event, label, typeof items === "function" ? items() : items, {onError: error => notify(error.message)});
    return {onContextMenu: open, onKeyDown: (event: React.KeyboardEvent) => {if (contextKey(event)) open(event);}};
  };
}

/** 原生输入保留浏览器撤销栈；编辑器及业务对象由各自的菜单先处理。 */
export function TextContextMenus({children, language}: {children: React.ReactNode; language?: string}) {
  const show = useContextMenu(), composing = useRef(false), [error, setError] = useState("");
  const t = (key: string) => contextText("context." + key as ContextKey, language);
  function open(event: React.MouseEvent | React.KeyboardEvent) {
    const element = event.target as HTMLElement;
    if (event.defaultPrevented || composing.current || element.closest("[data-context-menu], .cm-editor, [contenteditable=true]")) return;
    const input = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement && /^(text|search|email|url|tel|password|number)$/.test(element.type) ? element : undefined;
    const selection = getSelection(), snapshot = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
    const container = element.closest("article, .resource-reading-body, .reader, .screenplay-reader, pre, .manuscript, main") as HTMLElement | null;
    if (!input && !container && !selection?.toString()) return;
    const start = input?.selectionStart, end = input?.selectionEnd, value = input?.value;
    const secret = input instanceof HTMLInputElement && input.type === "password";
    const selected = secret ? "" : input ? value!.slice(start ?? 0, end ?? 0) : selection?.toString() ?? "";
    const editable = !!input && !input.readOnly && !input.disabled && start !== null;
    const restore = () => {
      if (input?.isConnected) {input.focus({preventScroll: true}); if (start != null && end != null) input.setSelectionRange(start, end);}
      else if (snapshot?.startContainer.isConnected && snapshot.endContainer.isConnected) {selection?.removeAllRanges(); selection?.addRange(snapshot);}
    };
    const requireCurrent = (mutating = true) => {
      if (!input?.isConnected || input.value !== value || input.selectionStart !== start || input.selectionEnd !== end || input.disabled || mutating && input.readOnly || composing.current)
        throw new Error(t("clipboard_changed"));
      input.focus({preventScroll: true});
    };
    const edit = (command: string, text?: string) => {requireCurrent(); document.execCommand(command, false, text);};
    const items: ContextMenuItem[] = input ? [
      {id: "undo", label: t("undo"), shortcut: contextShortcut("Z"), disabled: !editable, action: () => edit("undo")},
      {id: "redo", label: t("redo"), shortcut: contextShortcut("Z", true), disabled: !editable, action: () => edit("redo")},
      {id: "history", separator: true},
      {id: "cut", label: t("cut"), shortcut: contextShortcut("X"), disabled: !editable || !selected, action: async () => {await desktop.copy(selected); edit("delete");}},
      {id: "copy", label: t("copy"), shortcut: contextShortcut("C"), disabled: !selected || input.disabled, action: () => desktop.copy(selected)},
      {id: "paste", label: t("paste"), shortcut: contextShortcut("V"), disabled: !editable, action: async () => {const text = await desktop.paste(); edit("insertText", text);}},
      {id: "delete", label: t("delete"), disabled: !editable || start === end, action: () => edit("delete")},
      {id: "clipboard", separator: true},
      {id: "select-all", label: t("select_all"), shortcut: contextShortcut("A"), disabled: input.disabled || start === null, action: () => {requireCurrent(false); input.select();}},
    ] : [
      {id: "copy", label: t("copy"), shortcut: contextShortcut("C"), disabled: !selected, action: () => desktop.copy(selected)},
      {id: "select-all", label: t("select_all"), shortcut: contextShortcut("A"), disabled: !container, action: () => {if (!container?.isConnected) return; const range = document.createRange(); range.selectNodeContents(container); selection?.removeAllRanges(); selection?.addRange(range);}},
    ];
    show(event, t(input ? "input" : "read_only"), items, {onDismiss: restore, onError: error => setError(error.message)});
  }
  return <div className="context-surface" onContextMenu={open} onKeyDown={event => {if (contextKey(event)) open(event);}}
    onCompositionStartCapture={() => {composing.current = true;}} onCompositionEndCapture={() => {composing.current = false;}}>
    {children}{error && <div className="context-error" role="alert">{error}<button onClick={() => setError("")}>关闭</button></div>}
  </div>;
}
