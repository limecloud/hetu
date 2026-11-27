import React, {useState} from "react";
import {agentPreferences, Icon} from "@hetu/workbench-ui";
import {desktop} from "./bridge.ts";

export function AgentChatSettings({preferences, notify}: {preferences: any; notify(message: string): void}) {
  const [busy, setBusy] = useState(false);
  const settings = agentPreferences(preferences);
  const choose = async (width: "comfortable" | "wide" | "full", menu: HTMLDetailsElement) => {
    setBusy(true);
    try {const current = await desktop.settings("get"); await desktop.settings("update", {expected_revision: current.revision, patch: {agent_session: {...current.preferences.agent_session, chat_width: width}}}); menu.open = false; menu.querySelector<HTMLElement>("summary")?.focus();}
    catch(error) {notify((error as Error).message);} finally {setBusy(false);}
  };
  return <details className="popover-menu agent-chat-settings"><summary aria-label="聊天设置" title="聊天设置"><Icon name="settings" size={14}/></summary><div className="menu-panel"><span>宽度</span><div role="group" aria-label="聊天宽度">{[["comfortable", "舒适"], ["wide", "宽"], ["full", "全宽"]].map(([value, title]) => <button key={value} type="button" aria-pressed={settings.chat_width === value} disabled={busy} onClick={event => void choose(value as "comfortable" | "wide" | "full", event.currentTarget.closest("details")!)}>{title}</button>)}</div></div></details>;
}
