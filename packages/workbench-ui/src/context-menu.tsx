import React, {createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {Icon, type IconName} from "./icons.tsx";

export type ContextMenuItem = {id: string; separator: true} | {
  id: string; label: string; icon?: IconName; shortcut?: string; disabled?: boolean; checked?: boolean; danger?: boolean;
  children?: ContextMenuItem[]; action?: () => void | Promise<void>;
};
interface MenuRequest {
  label: string; items: ContextMenuItem[]; x: number; y: number; opener?: HTMLElement | null;
  keyboard?: boolean; onDismiss?: () => void; onError?: (error: Error) => void;
}
interface MenuLevel {items: ContextMenuItem[]; parent?: HTMLButtonElement; keyboard?: boolean}
interface PointerGrace {until: number; direction: number; origin: {x: number; y: number}; edge: number; top: number; bottom: number}
function movingIntoSubmenu(event: React.PointerEvent, previousX: number, grace: PointerGrace) {
  if (Date.now() > grace.until || (event.clientX - previousX) * grace.direction < 0) return false;
  const distance = (event.clientX - grace.origin.x) * grace.direction, span = (grace.edge - grace.origin.x) * grace.direction;
  if (span <= 0 || distance < 0 || distance > span) return false;
  const ratio = distance / span;
  return event.clientY >= grace.origin.y + (grace.top - grace.origin.y) * ratio
    && event.clientY <= grace.origin.y + (grace.bottom - grace.origin.y) * ratio;
}
function scrollPosition(target: EventTarget) {
  const element = target === document || target === window ? document.scrollingElement : target;
  return element instanceof Element ? {left: element.scrollLeft, top: element.scrollTop} : {left: 0, top: 0};
}
interface OpenMenu extends MenuRequest {scrollPositions: Map<EventTarget, ReturnType<typeof scrollPosition>>}
const Context = createContext<(request: MenuRequest) => void>(() => {});

export function useContextMenu() {
  const show = useContext(Context);
  return useCallback((event: React.MouseEvent | React.KeyboardEvent, label: string, items: ContextMenuItem[], options: Pick<MenuRequest, "onDismiss" | "onError"> = {}) => {
    event.preventDefault(); event.stopPropagation();
    const keyboard = event.type === "keydown", target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('input, textarea, button, [role="textbox"], [tabindex]') ?? event.currentTarget as HTMLElement : event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect(), mouse = event as React.MouseEvent;
    show({label, items, x: keyboard ? rect.left + 12 : mouse.clientX, y: keyboard ? Math.min(rect.bottom, rect.top + 32) : mouse.clientY,
      opener: target, keyboard, ...options});
  }, [show]);
}

/** 菜单只保存本次命令快照；对象与修订核验由命令所属用例执行。 */
export function ContextMenuProvider({children}: {children: React.ReactNode}) {
  const [request, setRequest] = useState<OpenMenu>(), [levels, setLevels] = useState<MenuLevel[]>([]);
  const holder = useRef<HTMLDivElement>(null), current = useRef(request); current.current = request;
  const show = useCallback((value: MenuRequest) => {
    if (!value.items.some(item => !("separator" in item))) return;
    document.querySelectorAll<HTMLDetailsElement>(".popover-menu[open]").forEach(menu => {menu.open = false;});
    const scrollPositions = new Map<EventTarget, ReturnType<typeof scrollPosition>>();
    for (let element = value.opener; element; element = element.parentElement) scrollPositions.set(element, scrollPosition(element));
    scrollPositions.set(document, scrollPosition(document)); scrollPositions.set(window, scrollPosition(window));
    setRequest({...value, scrollPositions}); setLevels([{items: value.items, keyboard: value.keyboard}]);
  }, []);
  const close = useCallback((restore: boolean) => {
    const value = current.current; setRequest(undefined); setLevels([]);
    if (restore) requestAnimationFrame(() => {
      if (value?.onDismiss) value.onDismiss();
      else if (value?.opener?.isConnected) value.opener.focus({preventScroll: true});
    });
  }, []);
  useEffect(() => {
    if (!request) return;
    const outside = (event: Event) => {if (!holder.current?.contains(event.target as Node)) close(false);};
    const scroll = (event: Event) => {
      if (!event.target || event.target instanceof Node && holder.current?.contains(event.target)) return;
      const previous = request.scrollPositions.get(event.target), position = scrollPosition(event.target);
      // 焦点或定位已完成的滚动可能延后派发；只在菜单打开后确实滚动时关闭。
      if (previous && (previous.left !== position.left || previous.top !== position.top)) close(false);
    };
    const blur = () => close(false);
    document.addEventListener("pointerdown", outside, true); document.addEventListener("focusin", outside);
    window.addEventListener("scroll", scroll, true); window.addEventListener("resize", blur); window.addEventListener("blur", blur);
    return () => {document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", blur); window.removeEventListener("blur", blur);};
  }, [request, close]);
  async function execute(item: Exclude<ContextMenuItem, {separator: true}>) {
    if (item.disabled || !item.action) return;
    const value = request; close(false);
    if (value?.onDismiss) value.onDismiss(); else value?.opener?.focus({preventScroll: true});
    try {await item.action();} catch (error) {value?.onError?.(error instanceof Error ? error : new Error(String(error)));}
  }
  const portal = request?.opener?.closest("dialog[open]") ?? document.body;
  return <Context.Provider value={show}>{children}{request && createPortal(<div ref={holder} className="context-menu-root" data-context-menu="" onContextMenu={event => event.preventDefault()}>
    {levels.map((level, depth) => <Menu key={depth} request={request} level={level} depth={depth} close={close} execute={execute}
      expanded={levels[depth + 1]?.parent?.dataset.contextKey}
      open={(item, button, keyboard) => setLevels(previous => [...previous.slice(0, depth + 1), {items: item.children!, parent: button, keyboard}])}
      trim={() => setLevels(previous => previous.slice(0, depth + 1))}
      back={() => {setLevels(previous => previous.slice(0, depth)); level.parent?.focus({preventScroll: true});}}/>)}</div>, portal)}</Context.Provider>;
}

function Menu({request, level, depth, expanded, close, execute, open, trim, back}: {
  request: MenuRequest; level: MenuLevel; depth: number; close(restore: boolean): void;
  expanded?: string;
  execute(item: Exclude<ContextMenuItem, {separator: true}>): void;
  open(item: Exclude<ContextMenuItem, {separator: true}>, button: HTMLButtonElement, keyboard: boolean): void;
  trim(): void; back(): void;
}) {
  const ref = useRef<HTMLDivElement>(null), search = useRef({text: "", time: 0});
  const pointerGrace = useRef<PointerGrace>(), pointerX = useRef(0);
  useEffect(() => {pointerGrace.current = undefined;}, [expanded, level]);
  const hasIcons = level.items.some(item => !("separator" in item) && (item.icon || item.checked !== undefined));
  // 先使用请求坐标渲染可见菜单，再在布局阶段夹到视口内。
  // 初始隐藏会让辅助技术已经读到菜单项，但几何仍为空，窄窗下尤其明显。
  const [position, setPosition] = useState({left: request.x, top: request.y, ready: true});
  const buttons = () => [...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  useLayoutEffect(() => {
    const menu = ref.current!, bounds = menu.getBoundingClientRect(), parent = level.parent?.getBoundingClientRect();
    const x = parent ? parent.right + 3 : request.x, y = parent ? parent.top - 4 : request.y;
    const left = Math.max(8, Math.min(innerWidth - bounds.width - 8, parent && x + bounds.width > innerWidth - 8 ? parent.left - bounds.width - 3 : x));
    const top = Math.max(8, Math.min(innerHeight - bounds.height - 8, y));
    setPosition({left, top, ready: true});
  }, [level, request]);
  useLayoutEffect(() => {
    if (!position.ready) return;
    if (level.keyboard) buttons()[0]?.focus({preventScroll: true}); else if (!depth) ref.current?.focus({preventScroll: true});
  }, [position.ready, level]);
  function key(event: React.KeyboardEvent) {
    if (event.nativeEvent.isComposing) return;
    pointerGrace.current = undefined;
    event.stopPropagation();
    const items = buttons(), selected = items.indexOf(document.activeElement as HTMLButtonElement);
    const button = items[selected], item = level.items.find(item => item.id === button?.dataset.contextKey);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); trim();
      const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : selected < 0 ? event.key === "ArrowUp" ? items.length - 1 : 0 : (selected + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[index]?.focus({preventScroll: true});
    } else if (event.key === "ArrowRight" && item && !("separator" in item) && item.children?.length) {
      event.preventDefault(); open(item, button, true);
    } else if (event.key === "ArrowLeft" && depth) {event.preventDefault(); back();}
    else if (event.key === "Escape") {event.preventDefault(); depth ? back() : close(true);}
    else if (event.key === "Tab") {
      close(false); request.opener?.focus({preventScroll: true});
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && event.key !== " ") {
      const now = Date.now(), prefix = (now - search.current.time < 700 ? search.current.text : "") + event.key.toLocaleLowerCase();
      search.current = {text: prefix, time: now};
      const next = [...items.slice(selected + 1), ...items.slice(0, selected + 1)].find(button => button.dataset.contextLabel?.toLocaleLowerCase().startsWith(prefix));
      if (next) {event.preventDefault(); next.focus({preventScroll: true});}
    }
  }
  return <div ref={ref} className="context-menu" data-icons={hasIcons} role="menu" aria-label={depth ? level.parent?.dataset.contextLabel : request.label} tabIndex={-1}
    style={{left: position.left, top: position.top}} onKeyDown={key} onPointerDown={event => event.preventDefault()}>
    {level.items.map(item => "separator" in item ? <div role="separator" className="context-menu-separator" key={item.id}/> : <button type="button" key={item.id} role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-label={item.label} aria-checked={item.checked} aria-haspopup={item.children?.length ? "menu" : undefined} aria-expanded={item.children?.length ? item.id === expanded : undefined} disabled={item.disabled} tabIndex={-1} data-context-key={item.id} data-context-label={item.label} data-danger={item.danger || undefined}
      onPointerLeave={event => {
        if (event.pointerType !== "mouse" || item.id !== expanded) return;
        const submenu = ref.current?.nextElementSibling;
        if (!(submenu instanceof HTMLElement)) return;
        const bounds = submenu.getBoundingClientRect(), parent = event.currentTarget.getBoundingClientRect();
        const direction = bounds.left >= parent.left ? 1 : -1;
        pointerGrace.current = {until: Date.now() + 300, direction, origin: {x: event.clientX - direction * 5, y: event.clientY}, edge: direction > 0 ? bounds.left : bounds.right, top: bounds.top, bottom: bounds.bottom};
      }}
      onPointerMove={event => {
        // iframe重排或原坐标重开后真实hover可能零位移，仍须响应本次指针事件。
        if (item.disabled) return;
        const previousX = pointerX.current; pointerX.current = event.clientX;
        if (pointerGrace.current && movingIntoSubmenu(event, previousX, pointerGrace.current)) return;
        pointerGrace.current = undefined;
        event.currentTarget.focus({preventScroll: true}); item.children?.length ? item.id !== expanded && open(item, event.currentTarget, false) : trim();
      }}
      onClick={event => item.children?.length ? open(item, event.currentTarget, true) : execute(item)}>
      {hasIcons && <span className="context-menu-icon" aria-hidden="true">{item.checked ? "✓" : item.icon ? <Icon name={item.icon} size={14}/> : null}</span>}<span>{item.label}</span>
      {item.children?.length ? <span className="context-menu-arrow" aria-hidden="true">›</span> : item.shortcut ? <span className="context-menu-shortcut">{item.shortcut}</span> : null}
    </button>)}
  </div>;
}
