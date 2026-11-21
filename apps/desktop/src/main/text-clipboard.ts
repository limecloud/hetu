import {clipboard} from "electron";

const budget = 1048576;
export function copyText(text: unknown, html?: unknown) {
  if (typeof text !== "string" || Buffer.byteLength(text) > budget || html !== undefined && (typeof html !== "string" || Buffer.byteLength(html) > budget)) throw new Error("复制内容无效。");
  clipboard.write({text, ...(typeof html === "string" ? {html} : {})});
}
export function pasteText(format?: unknown) {
  if (format !== undefined && format !== "rich") throw new Error("剪贴板格式无效。");
  const text = clipboard.readText(), html = format === "rich" ? clipboard.readHTML() : "";
  if (Buffer.byteLength(text) + Buffer.byteLength(html) > budget) throw new Error("剪贴板内容超过本次粘贴预算，请分段粘贴。");
  return format === "rich" ? {text, html} : text;
}
