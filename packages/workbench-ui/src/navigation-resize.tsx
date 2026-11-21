import React, {useEffect, useRef, useState} from "react";

export const navigationWidth = {initial: 280, min: 180, max: 390, collapse: 120};
export const clampNavigationWidth = (width: number) => Math.min(navigationWidth.max, Math.max(navigationWidth.min, Number.isFinite(width) ? width : navigationWidth.initial));

/** 宽度由当前视图保存；分隔边只负责指针、取消与键盘操作。 */
export function NavigationResize({width, onWidth, onCollapse}: {width: number; onWidth(width: number): void; onCollapse(): void}) {
  const drag = useRef<{pointer: number; startX: number; startWidth: number; targetWidth: number} | null>(null);
  const callbacks = useRef({onWidth, onCollapse}); callbacks.current = {onWidth, onCollapse};
  const [dragging, setDragging] = useState(false);
  function cancel() {
    const current = drag.current; if (!current) return;
    drag.current = null; setDragging(false); callbacks.current.onWidth(current.startWidth);
  }
  useEffect(() => {
    window.addEventListener("blur", cancel);
    return () => {window.removeEventListener("blur", cancel); if (drag.current) callbacks.current.onWidth(drag.current.startWidth);};
  }, []);
  return <div className="navigation-resize" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical"
    tabIndex={0} aria-valuemin={navigationWidth.min} aria-valuemax={navigationWidth.max} aria-valuenow={width}
    data-dragging={dragging || undefined} title="拖动调整侧栏宽度，向左收起"
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault(); event.currentTarget.focus({preventScroll: true});
      drag.current = {pointer: event.pointerId, startX: event.clientX, startWidth: width, targetWidth: width};
      event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
    }}
    onPointerMove={event => {
      const current = drag.current; if (!current || current.pointer !== event.pointerId) return;
      current.targetWidth = current.startWidth + event.clientX - current.startX;
      onWidth(clampNavigationWidth(current.targetWidth));
    }}
    onPointerUp={event => {
      const current = drag.current; if (!current || current.pointer !== event.pointerId) return;
      drag.current = null; setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId);
      if (current.targetWidth < navigationWidth.collapse) {onWidth(current.startWidth); onCollapse();}
    }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
    onKeyDown={event => {
      if (event.key === "Escape" && drag.current) {event.preventDefault(); event.stopPropagation(); cancel(); return;}
      if (drag.current) return;
      if (event.key === "Enter") {event.preventDefault(); onCollapse(); return;}
      const step = event.shiftKey ? 20 : 10;
      const next = event.key === "ArrowLeft" ? width - step : event.key === "ArrowRight" ? width + step : event.key === "Home" ? navigationWidth.min : event.key === "End" ? navigationWidth.max : undefined;
      if (next !== undefined) {event.preventDefault(); onWidth(clampNavigationWidth(next));}
    }}/ >;
}
