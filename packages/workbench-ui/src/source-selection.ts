export interface MappedSelection { byte_start: number; byte_end: number; quote: string }

/** 可见选区两端映射到确切源片段，隐藏标记只保留在原文引用内。 */
export function mappedSourceSelection(element: HTMLElement, source: string): MappedSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const spans = [...element.querySelectorAll<HTMLElement>("[data-source-from]")].filter(span => !span.classList.contains("manuscript-break") && !!span.firstChild && span.textContent === source.slice(Number(span.dataset.sourceFrom), Number(span.dataset.sourceTo)));
  function offset(node: Node, position: number, end: boolean): number | null {
    const direct = (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest<HTMLElement>("[data-source-from]");
    if (direct && spans.includes(direct)) {
      const prefix = document.createRange(); prefix.selectNodeContents(direct); prefix.setEnd(node, position);
      return Number(direct.dataset.sourceFrom) + prefix.toString().length;
    }
    for (const span of end ? spans.slice().reverse() : spans) {
      const contents = document.createRange(); contents.selectNodeContents(span);
      const comparison = contents.comparePoint(node, position);
      if (end ? comparison >= 0 : comparison <= 0) return Number(end ? span.dataset.sourceTo : span.dataset.sourceFrom);
    }
    return null;
  }
  let from = offset(range.startContainer, range.startOffset, false), to = offset(range.endContainer, range.endOffset, true);
  if (!spans.length && element.textContent === source) {
    const prefix = document.createRange(); prefix.selectNodeContents(element); prefix.setEnd(range.startContainer, range.startOffset);
    from = prefix.toString().length; to = from + range.toString().length;
  }
  if (from === null || to === null || to <= from || /[\uDC00-\uDFFF]/.test(source[from]) || /[\uDC00-\uDFFF]/.test(source[to] ?? "")) return null;
  const encoder = new TextEncoder();
  return {byte_start: encoder.encode(source.slice(0, from)).length, byte_end: encoder.encode(source.slice(0, to)).length, quote: source.slice(from, to)};
}
