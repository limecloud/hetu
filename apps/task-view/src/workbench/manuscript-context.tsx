import React from "react";
import {ContextMenuProvider, ManuscriptText, useContextMenu, type ContextMenuItem} from "@hetu/workbench-ui";
import {copyText} from "./clipboard.ts";
import {selectedText} from "./selection.ts";

function ManuscriptContextInner({text, title, novel, label, onPrepare, onError}: {
  text: string;
  title: string;
  novel: boolean;
  label: string;
  onPrepare(selected: string): void;
  onError(error: Error): void;
}) {
  const show = useContextMenu();
  const open = (event: React.MouseEvent | React.KeyboardEvent) => {
    const root = event.currentTarget as HTMLElement;
    const selected = selectedText(root);
    const items: ContextMenuItem[] = [
      {id: "copy", label: "复制", disabled: !selected, action: async () => { await copyText(selected); }},
      {id: "select-all", label: "全选", action: () => { const range = document.createRange(); range.selectNodeContents(root); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }},
      {id: "review", separator: true},
      {id: "ai", label: selected ? "让 AI 处理选区" : "让 AI 处理本稿", action: () => onPrepare(selected)},
    ];
    show(event, label, items, {onError});
  };
  return <div className="mcp-manuscript-context" tabIndex={0} aria-label={label} onContextMenu={open} onKeyDown={event => {
    if (!event.nativeEvent.isComposing && (event.key === "ContextMenu" || event.shiftKey && event.key === "F10")) open(event);
  }}><ManuscriptText text={text} title={title} novel={novel} format={novel ? "markdown" : "plain"} aria-label={label}/></div>;
}

export function ManuscriptContextSurface(props: {
  text: string;
  title: string;
  novel: boolean;
  label: string;
  onPrepare(selected: string): void;
  onError(error: Error): void;
}) {
  return <ContextMenuProvider><ManuscriptContextInner {...props}/></ContextMenuProvider>;
}
