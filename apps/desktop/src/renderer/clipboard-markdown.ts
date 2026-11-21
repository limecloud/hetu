/** 只转换惰性模板中的已知语义；脚本和远程媒体不进入编辑器。 */
export function clipboardMarkdown(value: {text: string; html: string}) {
  if (!value.html) return value.text;
  const template = document.createElement("template"); template.innerHTML = value.html;
  let nodes = 0;
  const escape = (text: string) => text.replace(/([\\`*_[\]<>])/g, "\\$1");
  function content(node: Node, depth = 0): string {return [...node.childNodes].map(child => convert(child, depth + 1)).reduce((before, after) => before + (before.endsWith("\n\n") && after.startsWith("\n\n") ? after.slice(2) : after), "");}
  function convert(node: Node, depth: number): string {
    if (++nodes > 10000 || depth > 80) throw new Error("clipboard-complexity");
    if (node.nodeType === Node.TEXT_NODE) return escape((node.textContent ?? "").replace(/[ \t\r\n\f]+/g, " "));
    if (!(node instanceof HTMLElement)) return "";
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "iframe", "object", "embed", "img", "video", "audio", "svg", "link", "meta", "head", "title", "form", "input", "button"].includes(tag)) return "";
    const text = content(node, depth);
    if (["strong", "b"].includes(tag)) return `**${text}**`;
    if (["em", "i"].includes(tag)) return `*${text}*`;
    if (["del", "s", "strike"].includes(tag)) return `~~${text}~~`;
    if (tag === "br") return "\n";
    if (tag === "hr") return "\n\n---\n\n";
    if (tag === "pre") {const raw = node.textContent ?? "", fence = "`".repeat(Math.max(3, ...[...raw.matchAll(/`+/g)].map(match => match[0].length + 1))); return `\n\n${fence}\n${raw.replace(/\n$/, "")}\n${fence}\n\n`;}
    if (tag === "code") {if (node.parentElement?.tagName === "PRE") return text; const raw = node.textContent ?? "", fence = "`".repeat(Math.max(1, ...[...raw.matchAll(/`+/g)].map(match => match[0].length + 1))), pad = /^`|`$|^ .* $/.test(raw) ? " " : ""; return fence + pad + raw + pad + fence;}
    if (/^h[1-6]$/.test(tag)) return "\n\n" + "#".repeat(Number(tag[1])) + " " + text.trim() + "\n\n";
    if (tag === "blockquote") return "\n\n" + text.trim().split("\n").map(line => "> " + line).join("\n") + "\n\n";
    if (tag === "ul" || tag === "ol") return "\n\n" + [...node.children].filter(child => child.tagName === "LI").map((child, index) => {
      const prefix = tag === "ol" ? `${index + 1}. ` : "- "; return content(child, depth + 1).trim().split("\n").map((line, lineIndex) => lineIndex ? " ".repeat(prefix.length) + line : prefix + line).join("\n");
    }).join("\n") + "\n\n";
    if (tag === "a") {
      const url = node.getAttribute("href") ?? "";
      if (/^(https?:\/\/|mailto:)/i.test(url) && !/[\s<>]/.test(url)) return `[${text}](${url.replace(/[()\\]/g, match => "\\" + match)})`;
      return text;
    }
    if (["p", "div", "section", "article", "table", "tr"].includes(tag)) return "\n\n" + text.trim() + "\n\n";
    if (tag === "td" || tag === "th") return text + "\t";
    return text;
  }
  try {return content(template.content).trim() || value.text;} catch {return value.text;}
}
