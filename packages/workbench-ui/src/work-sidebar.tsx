import React, {useEffect, useRef} from "react";
import {Icon, type IconName} from "./icons.tsx";

export type SidebarLayer = "project" | "document";
export type SidebarPanel = "directory" | "tasks" | "attachments" | "search";
const panels: {id: SidebarPanel; label: string; icon: IconName}[] = [
  {id: "directory", label: "目录", icon: "list"},
  {id: "tasks", label: "任务", icon: "check"},
  {id: "attachments", label: "附件", icon: "attachment"},
  {id: "search", label: "查找", icon: "document-search"},
];

/** 两层导航只改变侧栏，正文、编辑器与各面板保持挂载。 */
export function WorkSidebar({layer, panel, onLayer, onPanel, title, subtitle, updatedAt, cover, onProfile, project, children}: {
  layer: SidebarLayer; panel: SidebarPanel;
  onLayer: (layer: SidebarLayer) => void; onPanel: (panel: SidebarPanel) => void;
  title: string; subtitle: React.ReactNode; updatedAt?: string; cover: React.ReactNode; onProfile: () => void;
  project: React.ReactNode; children: React.ReactNode;
}) {
  const documentPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    documentPanel.current?.querySelectorAll<HTMLDetailsElement>(".popover-menu[open]").forEach(menu => {menu.open = false;});
  }, [layer, panel]);
  const age = updatedAt ? (Date.now() - Date.parse(updatedAt)) / 1000 : NaN;
  const relative = !Number.isFinite(age) ? subtitle : age < 60 ? "刚刚" : age < 3600 ? Math.floor(age / 60) + "分钟前" : age < 86400 ? Math.floor(age / 3600) + "小时前" : age < 86400 * 7 ? Math.floor(age / 86400) + "天前" : new Date(updatedAt!).toLocaleDateString();
  return <>
    <div className="sidebar-project" hidden={layer !== "project"}>{project}</div>
    <div ref={documentPanel} className="sidebar-document" hidden={layer !== "document"}>
      <button className="sidebar-work-heading" aria-label="作品资料" onClick={onProfile} title={title}>
        {cover}<span><strong>{title}</strong><small title={updatedAt ? new Date(updatedAt).toLocaleString() : undefined}>{relative}</small></span>
      </button>
      <div className="sidebar-segments" role="tablist" aria-label="作品侧栏">
        {panels.map((item, index) => <button type="button" key={item.id} id={"sidebar-tab-" + item.id} role="tab" title={item.label} aria-label={item.label}
          aria-selected={panel === item.id} aria-controls={"sidebar-panel-" + item.id} tabIndex={panel === item.id ? 0 : -1}
          onClick={() => onPanel(item.id)} onKeyDown={event => {
            const next = event.key === "ArrowRight" ? (index + 1) % panels.length : event.key === "ArrowLeft" ? (index + panels.length - 1) % panels.length : event.key === "Home" ? 0 : event.key === "End" ? panels.length - 1 : undefined;
            if (next === undefined) return;
            event.preventDefault(); onPanel(panels[next]!.id);
            (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
          }}><Icon name={item.icon} size={17}/></button>)}
      </div>
      <div className="sidebar-panels">{children}</div>
    </div>
    <div className="sidebar-levels" role="group" aria-label="侧栏层级">
      {(["project", "document"] as const).map(id => <button type="button" key={id} title={id === "project" ? "项目导航" : "当前作品"}
        aria-label={id === "project" ? "显示项目导航" : "显示当前作品"} aria-pressed={layer === id} onClick={() => onLayer(id)}><span/></button>)}
    </div>
  </>;
}
