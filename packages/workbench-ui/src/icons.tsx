import React from "react";

export type IconName = "terminal" | "folder" | "sidebar" | "inspector" | "book" | "file" | "shield" | "link" | "layers" | "image" | "branch" | "export" | "check" | "settings" | "expand" | "more" | "chevron" | "back" | "list" | "sparkles" | "search" | "comment" | "grid" | "refresh" | "plus" | "film" | "close" | "plugin" | "sliders" | "type" | "globe" | "info" | "brush" | "attachment" | "document-search" | "maximize" | "restore" | "fullscreen" | "fullscreen-exit";
const paths: Record<IconName, React.ReactNode> = {
  terminal:<><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 8 3 3-3 3m6 1h4"/></>,
  folder:<path d="M3 7V5h7l2 2h9v13H3Z"/>,
  maximize:<rect x="3" y="3" width="18" height="18" rx="1"/>,
  restore:<><path d="M8 3h13v13M8 3v4m13 9h-4"/><rect x="3" y="8" width="13" height="13" rx="1"/></>,
  fullscreen:<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>,
  "fullscreen-exit":<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>,
  attachment: <path d="m9 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9m-6 10a1.5 1.5 0 0 0 2 2l8-8"/>,
  "document-search": <><path d="M14 3H5v18h7M14 3v5h5V8l-5-5M8 8h3m-3 4h5"/><circle cx="16" cy="16" r="4"/><path d="m19 19 3 3"/></>,
  brush: <><path d="m14 6 4 4M8 12l10-9a2.1 2.1 0 0 1 3 3L12 16"/><path d="M8 12a4 4 0 0 1 4 4c0 3-2 5-7 5 1-2-3-2-3-4 3 0 2-5 6-5Z"/></>,
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
  plugin: <path d="M9 3H5a2 2 0 0 0-2 2v4h2a2 2 0 1 1 0 4H3v6a2 2 0 0 0 2 2h6v-2a2 2 0 1 1 4 0v2h4a2 2 0 0 0 2-2v-6h-2a2 2 0 1 1 0-4h2V5a2 2 0 0 0-2-2h-6v2a2 2 0 1 1-4 0Z"/>,
};
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function IconButton({ icon, label, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return <button type="button" className="icon-button" title={label} aria-label={label} {...props}><Icon name={icon}/></button>;
}
