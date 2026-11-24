/** 右键命令只使用当前成果内部的选区，保留其他字段的选区也不会串入。 */
export function selectedText(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.toString().trim() || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return "";
  return selection.toString();
}
