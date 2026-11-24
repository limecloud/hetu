/** MCP App 容器可能没有 navigator.clipboard，保留同一复制语义的受限回退。 */
export async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // 继续使用临时文本框回退；不把复制失败静默当成成功。
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "true");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("宿主未提供复制能力，请手动选择文字复制。");
}
