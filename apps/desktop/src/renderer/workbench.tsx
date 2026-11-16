import React, { createContext, useContext } from "react";
import { createPortal } from "react-dom";

export const PageActionsTarget = createContext<HTMLDivElement | null>(null);
export function PageActions({ children }: { children: React.ReactNode }) {
  const target = useContext(PageActionsTarget);
  return target ? createPortal(children, target) : null;
}

export type IconName = "sidebar" | "inspector" | "book" | "file" | "shield" | "link" | "layers" | "image" | "branch" | "export" | "check" | "settings" | "expand" | "more" | "chevron" | "back" | "list" | "sparkles" | "search" | "comment" | "grid" | "refresh" | "plus" | "film" | "close" | "plugin" | "sliders" | "type" | "globe" | "info";
const paths: Record<IconName, React.ReactNode> = {
  sliders: <><path d="M3 5h4m4 0h10M3 12h10m4 0h4M3 19h4m4 0h10"/><circle cx="9" cy="5" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="19" r="2"/></>,
  type: <><path d="M4 5h12M10 5v15M6 20h8M4 8V5m12 3V5m1 15 3-9 3 9m-5-3h4"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6.5c4 2 10 2 14 0M5 17.5c4-2 10-2 14 0"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M6 8h.01M6 11h.01"/></>,
  inspector: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16M18 8h.01M18 11h.01"/></>,
  book: <><path d="M12 5v15M12 5C8 2 3 4 2 5v15c3-2 7-2 10 0 3-2 7-2 10 0V5c-3-2-7-2-10 0Z"/></>,
  file: <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Zm0 0v5h5M8 12h8M8 16h8"/></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6ZM8 12l3 3 5-6"/></>,
  link: <><path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1" transform="translate(1 0)"/></>,
  layers: <><path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/></>,
  branch: <><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7c0 6-12 3-12 8"/></>,
  export: <><path d="M12 15V3m-4 4 4-4 4 4M5 12H3v8h18v-8h-2"/></>,
  check: <><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>,
  settings: <><path d="m9 3-1 3-3 1-1 3 2 2-2 2 1 3 3 1 1 3h6l1-3 3-1 1-3-2-2 2-2-1-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></>,
  expand: <><path d="M9 3H3v6m12 12h6v-6M3 3l7 7m11 11-7-7"/></>,
  more: <><circle cx="4" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="20" cy="12" r=".8"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>, back: <path d="m15 5-7 7 7 7"/>,
  list: <><path d="M8 5h13M8 10h13M8 15h13M8 20h13M3 5h.01M3 10h.01M3 15h.01M3 20h.01"/></>,
  sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM4 2v4M2 4h4M20 18v4m-2-2h4"/></>,
  search: <><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/></>,
  comment: <><path d="M21 14a2 2 0 0 1-2 2h-7l-5 5v-5H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2ZM7 7h10M7 11h7"/></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  refresh: <><path d="M20 7V2l-3 3a9 9 0 1 0 3 12M20 7h-5"/></>,
  plus: <path d="M12 4v16M4 12h16"/>,
  film: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4m-4 8h4m10-8h4m-4 8h4"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  plugin: <path d="M9 3h6v5h5v7h-5v6H9v-6H3V8h6Z"/>,
};
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function IconButton({ icon, label, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return <button type="button" className="icon-button" title={label} aria-label={label} {...props}><Icon name={icon}/></button>;
}
export interface DocumentTools {
  title: string;
  dirty: boolean;
  busy: boolean;
  save: () => void;
  ai: () => void;
}

export interface AgentStatus {
  state: "idle" | "running" | "waiting_for_audit" | "failed";
  message?: string;
  taskId?: string;
}

export const Workbench = createContext<{
  directoryVisible: boolean;
  setDirectoryVisible: React.Dispatch<React.SetStateAction<boolean>>;
  inspector: boolean;
  setInspector: React.Dispatch<React.SetStateAction<boolean>>;
  focus: boolean;
  setFocus: React.Dispatch<React.SetStateAction<boolean>>;
  setDocumentTools: React.Dispatch<React.SetStateAction<DocumentTools | undefined>>;
  agentStatus: AgentStatus;
  setAgentStatus: React.Dispatch<React.SetStateAction<AgentStatus>>;
}>({
  directoryVisible: true, setDirectoryVisible: () => {},
  inspector: false, setInspector: () => {},
  focus: false, setFocus: () => {},
  setDocumentTools: () => {},
  agentStatus: { state: "idle" },
  setAgentStatus: () => {}
});
export const useWorkbench = () => useContext(Workbench);
