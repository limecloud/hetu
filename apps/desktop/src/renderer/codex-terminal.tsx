import React, { useEffect, useRef, useState } from "react";
import {createPortal} from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { useContextMenu, agentPreferences,IconButton } from "@hetu/workbench-ui";
import type { SessionSnapshot } from "../agent-session-contract.ts";
import { desktop } from "./bridge.ts";
import { repairTerminalScale } from "./terminal-renderer.ts";
import { terminalTheme } from "./terminal-theme.ts";
import { useEffectiveAppearance } from "./preferences.tsx";
import {TerminalStream} from "./terminal-stream.ts";
import {terminalKeyInput} from "./terminal-keys.ts";
import "@xterm/xterm/css/xterm.css";

export function CodexTerminal({ snapshot, preferences, notify,actions,toolbarTarget }: { snapshot: SessionSnapshot; preferences: any; notify: (message: string) => void;actions?:React.ReactNode;toolbarTarget?:HTMLElement|null }) {
  const appearance = useEffectiveAppearance();
  const contextMenu = useContextMenu();
  const paste = async () => { const active=terminal.current;const output=stream.current;const text = await desktop.paste(); if (new TextEncoder().encode(text).length > 60_000) throw new Error("粘贴内容超过60KB，请使用固定资料引用。");if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))throw Error("剪贴板包含终端控制字符，内容未粘贴。"); if(!active||active!==terminal.current||output!==stream.current||!output?.acceptsInput)throw Error("终端已切换或尚未核对，内容未粘贴。");active.paste(text); active.focus(); };
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const current = useRef(snapshot); current.current = snapshot;
  const preference = agentPreferences(preferences);
  const settings = useRef(preference); settings.current = preference;
  const search = useRef<SearchAddon>();
  const stream=useRef<TerminalStream>();
  const [streamError,setStreamError]=useState("");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const queryInput=useRef<HTMLInputElement>(null);
  const [searchFound,setSearchFound]=useState<boolean>();
  const [rendering, setRendering] = useState("");
  const openSearch=()=>{setSearchOpen(true);requestAnimationFrame(()=>{queryInput.current?.focus();queryInput.current?.select();});};
  const closeSearch=()=>{setSearchOpen(false);terminal.current?.focus();};
  const findMatch=(text:string,previous=false,incremental=false)=>{
    const found=previous?search.current?.findPrevious(text):search.current?.findNext(text,{incremental});
    setSearchFound(text?found:undefined);
  };
  const focusOnHover=(event:React.PointerEvent)=>{
    if(event.pointerType!=="mouse"||!preference.terminal_focus_on_hover||snapshot.surface!=="tui"||!snapshot.terminal_connected||!stream.current?.acceptsInput||searchOpen||!document.hasFocus())return;
    if(document.querySelector('dialog[open], [role="alertdialog"], [role="dialog"][aria-modal="true"], [data-context-menu], .popover-menu[open], .codex-results-panel'))return;
    const active=document.activeElement;
    if(active instanceof HTMLElement&&!host.current?.contains(active)&&active.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))return;
    terminal.current?.focus();
  };
  useEffect(() => {
    if (!host.current) return;
    host.current.dataset.terminalInputReady="false";
    host.current.dataset.terminalGeneration=String(snapshot.generation);
    const activate=(event:MouseEvent,url:string)=>{event.preventDefault();void desktop.agentSession("open_link",{url}).catch(error=>notify(error.message));};
    const instance = new Terminal({ allowProposedApi: true,disableStdin:true, convertEol: false, scrollback: settings.current.terminal_scrollback, screenReaderMode: true,minimumContrastRatio:4.5,macOptionIsMeta:false,macOptionClickForcesSelection:true,linkHandler:{activate} });
    terminal.current = instance;
    const bufferChange = instance.buffer.onBufferChange(buffer => { instance.options.scrollSensitivity = buffer.type === "alternate" ? settings.current.terminal_tui_scroll_sensitivity : settings.current.terminal_scroll_sensitivity; });
    const fit = new FitAddon(), find = new SearchAddon();
    search.current = find;
    instance.loadAddon(fit); instance.loadAddon(find);
    instance.loadAddon(new Unicode11Addon()); instance.unicode.activeVersion = "11";
    instance.loadAddon(new WebLinksAddon(activate));
    instance.attachCustomKeyEventHandler(event => {
      if(event.isComposing)return true;
      const mac=/Mac/i.test(navigator.platform),data=terminalKeyInput(event,mac);
      if(data!==undefined){event.preventDefault();instance.input(data,true);return false;}
      if(event.type==="keydown"&&mac&&event.metaKey&&!event.ctrlKey&&!event.altKey&&!event.shiftKey&&["ArrowUp","ArrowDown"].includes(event.key)){event.preventDefault();if(event.key==="ArrowUp")instance.scrollToTop();else instance.scrollToBottom();return false;}
      if (event.type === "keydown" && (mac?event.metaKey&&!event.ctrlKey&&!event.altKey: event.ctrlKey&&event.shiftKey&&!event.metaKey&&!event.altKey) && event.key.toLowerCase() === "f") { event.preventDefault();openSearch(); return false; }
      if (event.type === "keydown" && (event.metaKey || event.ctrlKey && event.shiftKey) && event.key.toLowerCase() === "c" && instance.hasSelection()) { event.preventDefault();void navigator.clipboard.writeText(instance.getSelection()).catch(error => notify(error.message)); return false; }
      if(event.type==="keydown"&&(event.metaKey||event.ctrlKey&&event.shiftKey)&&event.key.toLowerCase()==="v"){event.preventDefault();void paste().catch(error=>notify(error.message));return false;}
      return true;
    });
    instance.open(host.current);
    let paints=0;
    const rendered=instance.onRender(()=>{if(host.current)host.current.dataset.terminalPaint=String(++paints);});
    instance.focus();
    instance.parser.registerOscHandler(52, () => true);
    const scope=snapshot.work_ref?{work_ref:snapshot.work_ref}:{scope:"library"};
    const output=new TerminalStream({read:()=>desktop.agentSession("get",{...scope,session_id:snapshot.session_id}),reset:replay=>new Promise(resolve=>{instance.reset();instance.write(replay,resolve);}),write:data=>instance.write(data),error:error=>setStreamError(error.message),inputStatus:ready=>{
      if(terminal.current!==instance)return;
      instance.options.disableStdin=!ready||!current.current.terminal_connected||current.current.state==="switching";
      if(host.current){host.current.dataset.terminalInputReady=String(!instance.options.disableStdin);host.current.setAttribute("aria-busy",String(!ready));}
    }});stream.current=output;
    const input = instance.onData(data => {
      const active = current.current;
      if (!output.acceptsInput || !active.terminal_connected || active.generation!==snapshot.generation || active.state==="switching") return;
      void desktop.agentSession("terminal_input", { ...(active.work_ref ? {} : { scope: "library" }), session_id: active.session_id, generation: active.generation, data }).catch(error => notify(error.message));
    });
    const selection = instance.onSelectionChange(() => {
      if (settings.current.terminal_copy_on_select && instance.hasSelection()) void navigator.clipboard.writeText(instance.getSelection()).catch(error => notify(error.message));
    });
    const unsubscribe = desktop.onAgentSession(event => {
      if (event.type === "terminal") output.receive(event);
    });
    setStreamError("");void output.sync().catch(error=>setStreamError(error.message));
    const resize = () => {
      if (!host.current?.clientHeight || !host.current.clientWidth) return;
      repairTerminalScale(instance); fit.fit();
      if (host.current) host.current.dataset.terminalMetrics = JSON.stringify({fontSize:instance.options.fontSize, cols:instance.cols, rows:instance.rows, dpr:devicePixelRatio});
      const active = current.current;
      if (active.terminal_connected) void desktop.agentSession("terminal_resize", { ...(active.work_ref ? {} : { scope: "library" }), session_id: active.session_id, generation: active.generation, cols: instance.cols, rows: instance.rows }).catch(error => notify(error.message));
    };
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    window.addEventListener("resize", resize);
    const scaleObserver = new MutationObserver(() => repairTerminalScale(instance));
    scaleObserver.observe(host.current, { subtree:true, attributes:true, attributeFilter:["width","height"] });
    const timer = requestAnimationFrame(resize);
    return () => { output.dispose();cancelAnimationFrame(timer); observer.disconnect(); scaleObserver.disconnect(); bufferChange.dispose();rendered.dispose(); window.removeEventListener("resize", resize); unsubscribe(); input.dispose(); selection.dispose(); instance.dispose(); terminal.current = undefined;stream.current=undefined; };
  }, [snapshot.session_id, snapshot.generation, snapshot.terminal_connected]);
  useEffect(()=>{
    const instance=terminal.current;if(!instance)return;
    instance.options.disableStdin=!stream.current?.acceptsInput||!snapshot.terminal_connected||snapshot.state==="switching";
    if(host.current)host.current.dataset.terminalInputReady=String(!instance.options.disableStdin);
  },[snapshot.state,snapshot.generation,snapshot.terminal_connected]);
  useEffect(() => {
    const instance = terminal.current; if (!instance) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dark = preference.terminal_theme === "dark" || preference.terminal_theme === "system" && appearance === "dark";
    const theme=terminalTheme(dark?"dark":"light");
    host.current?.style.setProperty("--codex-terminal-background",theme.background!);
    host.current?.style.setProperty("--codex-terminal-foreground",theme.foreground!);
    host.current?.closest<HTMLElement>(".codex-terminal-shell")?.style.setProperty("--codex-terminal-background",theme.background!);
    instance.options = {
      fontFamily: preference.terminal_font_family || 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
      fontSize: preference.terminal_font_size, fontWeight: preference.terminal_font_weight as any, fontWeightBold: preference.terminal_bold_weight as any,
      lineHeight: preference.terminal_line_height, cursorStyle: preference.terminal_cursor as "block" | "bar" | "underline",cursorInactiveStyle:preference.terminal_cursor==="block"?"outline":preference.terminal_cursor as "bar"|"underline",
      cursorBlink: !reduced && preference.terminal_cursor_blink, scrollback: preference.terminal_scrollback,
      scrollSensitivity: instance.buffer.active.type === "alternate" ? preference.terminal_tui_scroll_sensitivity : preference.terminal_scroll_sensitivity, fastScrollSensitivity: preference.terminal_fast_scroll_sensitivity,
      scrollOnUserInput: preference.terminal_scroll_on_input,
      theme,
    };
    let webgl: WebglAddon | undefined;
    if (preference.terminal_gpu !== "off") {
      try { webgl = new WebglAddon(); instance.loadAddon(webgl); webgl.onContextLoss(() => { webgl?.dispose(); webgl = undefined; setRendering("图形加速不可用，已使用基础渲染，终端会话保持连接。"); }); }
      catch { setRendering("图形加速不可用，已使用基础渲染。"); }
    }
    let ligatures: LigaturesAddon | undefined;
    if (preference.terminal_ligatures === "on" || preference.terminal_ligatures === "auto" && /Fira|Cascadia|JetBrains/i.test(preference.terminal_font_family)) {
      try { ligatures = new LigaturesAddon(); instance.loadAddon(ligatures); } catch { setRendering("当前字体无法启用连字，已保留基本字符显示。"); }
    }
    window.dispatchEvent(new Event("resize"));
    return () => { webgl?.dispose(); ligatures?.dispose(); };
  }, [JSON.stringify(preference), snapshot.generation, snapshot.terminal_connected, appearance]);
  const tools=<><IconButton icon="search" label="查找" aria-expanded={searchOpen} onClick={() => searchOpen?closeSearch():openSearch()}/>{actions}</>;
  return <div className="codex-terminal-shell" data-theme={preference.terminal_theme}>
    {toolbarTarget===undefined?<div className="codex-terminal-toolbar">{tools}</div>:toolbarTarget?createPortal(tools,toolbarTarget):null}
    {searchOpen && <div className="codex-terminal-search" role="search" aria-label="终端查找" onKeyDown={event=>{
      if(event.nativeEvent.isComposing)return;
      if(event.key==="Enter"){event.preventDefault();event.stopPropagation();findMatch(query,event.shiftKey);}
      if(event.key==="Escape"){event.preventDefault();event.stopPropagation();closeSearch();}
    }}><input ref={queryInput} aria-label="查找终端内容" value={query} onChange={event=>{setQuery(event.target.value);if(!(event.nativeEvent as InputEvent).isComposing)findMatch(event.target.value,false,true);}} onCompositionEnd={event=>findMatch(event.currentTarget.value,false,true)}/>{query&&searchFound===false&&<span role="status">未找到</span>}<button disabled={!query} onClick={()=>findMatch(query,true)}>上一个</button><button disabled={!query} onClick={()=>findMatch(query)}>下一个</button><button onClick={closeSearch}>关闭查找</button></div>}
    {rendering && <p className="codex-terminal-rendering" role="status">{rendering}</p>}
    {streamError&&<p className="codex-terminal-rendering" role="alert">{streamError}<button onClick={()=>{setStreamError("");void stream.current?.sync().catch(error=>setStreamError(error.message));}}>重新读取终端</button></p>}
    {!snapshot.terminal_connected&&snapshot.state!=="idle"&&<p className="codex-terminal-offline">{snapshot.state==="starting"?"正在连接终端…":snapshot.terminal_replay?"终端已断开，输出仅供回看。":"终端尚未连接。"}</p>}
    <div className="codex-terminal" ref={host} aria-label="会话终端" onPointerEnter={focusOnHover} onPasteCapture={event=>{event.preventDefault();event.stopPropagation();void paste().catch(error=>notify(error.message));}} onContextMenu={event => contextMenu(event, "终端操作", [
      { id: "copy", label: "复制", disabled: !terminal.current?.hasSelection(), action: async () => { await navigator.clipboard.writeText(terminal.current?.getSelection() ?? ""); } },
      { id: "paste", label: "粘贴", disabled: !snapshot.terminal_connected, action: paste },
      { id: "select-all", label: "全选", action: () => terminal.current?.selectAll() },
      { id: "find", label: "查找", action: openSearch },
      { id: "latest", label: "回到最新", action: () => terminal.current?.scrollToBottom() },
    ], { onError: error => notify(error.message), onDismiss: () => terminal.current?.focus() })}/>
  </div>;
}
