import {useEffect, useRef} from "react";
import type {WorkRef} from "@hetu/plugin-sdk";
import type {ReadingState, SavedReadingPosition} from "../reading-state.ts";
import {desktop} from "./bridge.ts";
import {viewStorage} from "./view-storage.ts";

export async function restoreReadingState(work: WorkRef, selectionKey: string, positionKey: string) {
  const saved: ReadingState = await desktop.readingState("get", {work_ref: work});
  let session: Record<string, SavedReadingPosition> = {};
  try { session = JSON.parse(viewStorage.getItem(positionKey) ?? "{}"); } catch { /* 当前视图的损坏位置不改变持久记录。 */ }
  viewStorage.setItem(positionKey, JSON.stringify({...saved.positions, ...session}));
  if (!viewStorage.getItem(selectionKey) && saved.selected_document_id) viewStorage.setItem(selectionKey, saved.selected_document_id);
}

/** 仅把已保存稿的锚点送入可信本机状态；其他窗口不会推送滚动到当前视图。 */
export function useReadingPersistence(work: WorkRef, notify: (message: string) => void) {
  const pending = useRef<SavedReadingPosition>(), timer = useRef<ReturnType<typeof setTimeout>>(), active = useRef(true), error = useRef("");
  const callback = useRef(notify); callback.current = notify;
  const scope = JSON.stringify([work.workspace_id, work.kind, work.object_id]), currentScope = useRef(scope); currentScope.current = scope;
  async function save(patch: {position?: SavedReadingPosition; selected_document_id?: string}) {
    try {await desktop.readingState("save", {work_ref: work, patch}); error.current = "";}
    catch (value) {
      const message = "阅读位置未能保存：" + (value as Error).message;
      if (active.current && currentScope.current === scope && error.current !== message) {error.current = message; callback.current(message);}
    }
  }
  function flush() {
    clearTimeout(timer.current);
    const position = pending.current; pending.current = undefined;
    if (position) void save({position});
  }
  useEffect(() => {
    active.current = true;
    window.addEventListener("pagehide", flush); window.addEventListener("blur", flush);
    return () => {active.current = false; flush(); window.removeEventListener("pagehide", flush); window.removeEventListener("blur", flush);};
  }, [work.workspace_id, work.kind, work.object_id]);
  return {
    position(value: SavedReadingPosition) {pending.current = value; clearTimeout(timer.current); timer.current = setTimeout(flush, 200);},
    document(id: string) {void save({selected_document_id: id});},
  };
}
