import React, { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import type {SidebarLayer, SidebarPanel} from "@hetu/workbench-ui";
import type {DocumentTab} from "@hetu/workbench-ui";

export const PageActionsTarget = createContext<HTMLDivElement | null>(null);
export function PageActions({ children }: { children: React.ReactNode }) {
  const target = useContext(PageActionsTarget);
  return target ? createPortal(children, target) : null;
}

export { Icon, IconButton, type IconName } from "@hetu/workbench-ui";

export interface DocumentTools {
  title: string;
  readOnly?: boolean;
  readOnlyLabel?: string;
  dirty: boolean;
  busy: boolean;
  composing?: boolean;
  save: () => void;
  ai: () => void;
}

export interface AgentStatus {
  state: "idle" | "running" | "waiting_for_audit" | "failed";
  message?: string;
  taskId?: string;
  submissionId?:string;
}

export const Workbench = createContext<{
  sidebarLayer: SidebarLayer;
  setSidebarLayer: React.Dispatch<React.SetStateAction<SidebarLayer>>;
  sidebarPanel: SidebarPanel;
  setSidebarPanel: React.Dispatch<React.SetStateAction<SidebarPanel>>;
  directoryTarget: HTMLDivElement | null;
  searchTarget: HTMLDivElement | null;
  navigationVisible: boolean;
  setNavigationVisible: React.Dispatch<React.SetStateAction<boolean>>;
  directoryVisible: boolean;
  setDirectoryVisible: React.Dispatch<React.SetStateAction<boolean>>;
  inspector: boolean;
  setInspector: React.Dispatch<React.SetStateAction<boolean>>;
  focus: boolean;
  setFocus: React.Dispatch<React.SetStateAction<boolean>>;
  setDocumentTools: React.Dispatch<React.SetStateAction<DocumentTools | undefined>>;
  setDocumentTab: (tab: DocumentTab | undefined) => void;
  pinDocumentTab: (id: string) => void;
  agentStatus: AgentStatus;
  setAgentStatus: React.Dispatch<React.SetStateAction<AgentStatus>>;
}>({
  sidebarLayer: "document", setSidebarLayer: () => {}, sidebarPanel: "directory", setSidebarPanel: () => {},
  directoryTarget: null, searchTarget: null, navigationVisible: true, setNavigationVisible: () => {},
  directoryVisible: true, setDirectoryVisible: () => {},
  inspector: false, setInspector: () => {},
  focus: false, setFocus: () => {},
  setDocumentTools: () => {},
  setDocumentTab: () => {},
  pinDocumentTab: () => {},
  agentStatus: { state: "idle" },
  setAgentStatus: () => {}
});
export const useWorkbench = () => useContext(Workbench);
