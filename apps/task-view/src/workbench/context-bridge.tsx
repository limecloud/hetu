import React, {useEffect} from "react";
import {ContextMenuProvider, useContextMenu, type ContextMenuItem} from "@hetu/workbench-ui";
import {copyText} from "./clipboard.ts";
import {selectedText} from "./selection.ts";

function ContextMenuEvents({onPrepare, onError}: {onPrepare(selected: string): void; onError(error: Error): void}) {
  const show = useContextMenu();
  useEffect(() => {
    const open = (event: MouseEvent | KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      const host = target?.closest<HTMLElement>("[data-mcp-context]");
      if (!host || target?.closest("button, input, textarea, select, summary, [contenteditable=true]")) return;
      const selected = selectedText(host);
      const text = (selected || host.innerText).trim();
      const items: ContextMenuItem[] = [
        {id:"copy",label:"复制",disabled:!text,action:()=>copyText(text)},
        {id:"select-all",label:"全选",action:()=>{const range=document.createRange();range.selectNodeContents(host);const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);}},
        {id:"review",separator:true},
        {id:"ai",label:selected?"让 AI 处理选区":"让 AI 处理当前成果",action:()=>onPrepare(selected || text)},
      ];
      try {
        show(event as unknown as React.MouseEvent, host.dataset.mcpContextLabel || "固定成果", items, {onError});
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.key === "ContextMenu" || event.shiftKey && event.key === "F10")) return;
      open(event);
    };
    document.addEventListener("contextmenu", open, true);
    document.addEventListener("keydown", keydown, true);
    return () => {document.removeEventListener("contextmenu", open, true);document.removeEventListener("keydown", keydown, true);};
  }, [show, onPrepare, onError]);
  return null;
}

export function ContextMenuBridge({onPrepare, onError}: {onPrepare(selected: string): void; onError(error: Error): void}) {
  return <ContextMenuProvider><ContextMenuEvents onPrepare={onPrepare} onError={onError}/></ContextMenuProvider>;
}
