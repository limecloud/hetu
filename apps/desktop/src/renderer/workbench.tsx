import React, { createContext, useContext } from "react";
import { createPortal } from "react-dom";

export const PageActionsTarget = createContext<HTMLDivElement | null>(null);
export function PageActions({ children }: { children: React.ReactNode }) {
  const target = useContext(PageActionsTarget);
  return target ? createPortal(children, target) : null;
}

export { Icon, IconButton, type IconName } from "@hetu/workbench-ui";

export interface DocumentTools {
  title: string;
  readOnly?: boolean;
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
