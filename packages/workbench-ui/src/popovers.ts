import {useEffect} from "react";

/** 所有工作台入口共用退出规则；命令已移走焦点时不抢回编辑器。 */
export function usePopoverMenus() {
  useEffect(() => {
    function menus() {
      return [...document.querySelectorAll<HTMLDetailsElement>(".popover-menu[open]")].filter(menu => menu.checkVisibility());
    }
    function close(menu: HTMLDetailsElement, restoreFocus: boolean) {
      const heldFocus = menu.contains(document.activeElement);
      menu.open = false;
      if (restoreFocus && heldFocus) menu.querySelector<HTMLElement>(":scope > summary")?.focus({preventScroll: true});
    }
    function keydown(event: KeyboardEvent) {
      if (!event.defaultPrevented && !event.isComposing && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const target = event.target instanceof Element ? event.target : null;
        const menu = target?.closest<HTMLDetailsElement>(".popover-menu");
        if (menu && !menu.matches(".reading-menu, .editor-format-menu") && target?.matches("summary, summary *, button, button *")) {
          const trigger = menu.querySelector(":scope > summary");
          const fromTrigger = !!trigger?.contains(target);
          if (fromTrigger) menu.open = true;
          const items = [...menu.querySelectorAll<HTMLButtonElement>(".menu-panel button:not(:disabled)")].filter(button => button.closest(".popover-menu") === menu && button.checkVisibility());
          if (items.length) {
            const current = items.findIndex(button => button.contains(target));
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : fromTrigger ? event.key === "ArrowUp" ? items.length - 1 : 0 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
            event.preventDefault(); items[next]?.focus({preventScroll: true}); return;
          }
        }
      }
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const target = event.target instanceof Element ? event.target : null;
      const modal = target?.closest("dialog[open]") ?? document.querySelector("dialog:modal");
      const opened = menus().filter(menu => !modal || modal.contains(menu));
      const current = target?.closest<HTMLDetailsElement>(".popover-menu[open]");
      const menu = current && opened.includes(current) ? current : opened.at(-1);
      if (!menu) return;
      event.preventDefault(); event.stopPropagation();
      close(menu, true);
    }
    function click(event: MouseEvent) {
      const path = event.composedPath();
      for (const menu of menus()) {
        const inside = path.includes(menu);
        if (!inside || !menu.matches(".reading-menu, .editor-format-menu") && path.some(node => node instanceof Element && node.matches(".menu-panel button"))) close(menu, inside);
      }
    }
    function focus(event: FocusEvent) {
      if (!(event.target instanceof Element)) return;
      for (const menu of menus()) {
        if (!menu.matches(".reading-menu, .editor-format-menu") && !menu.contains(event.target)) close(menu, false);
      }
    }
    // 格式命令已把焦点交回编辑器时，先关闭浮层，避免编辑器先把选区折成光标。
    function editorKeydown(event: KeyboardEvent) {
      if (event.target instanceof Element && event.target.closest(".cm-editor") && menus().length) keydown(event);
    }
    document.addEventListener("keydown", editorKeydown, true);
    document.addEventListener("keydown", keydown);
    document.addEventListener("click", click);
    document.addEventListener("focusin", focus);
    return () => {document.removeEventListener("keydown", editorKeydown, true); document.removeEventListener("keydown", keydown); document.removeEventListener("click", click); document.removeEventListener("focusin", focus);};
  }, []);
}
