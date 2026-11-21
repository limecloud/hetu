import catalog from "../../../contracts/manuscript-styles.json" with {type: "json"};
import type {Tree} from "@lezer/common";

export const manuscriptStyles = catalog;
export type ManuscriptFont = keyof typeof catalog.fonts;
export interface InlinePresentation {color?: string; font?: ManuscriptFont}
export type CardLayout = "compact" | "landscape" | "square" | "wide" | "large";
export type CardPreview = "page" | "icon" | "pages" | "note" | "images" | "none";
export interface CardPresentation {cardLayout?: CardLayout; cardPreview?: CardPreview; cardColor?: string; cardGradient?: string; cardImage?: string}
export interface BlockPresentation extends CardPresentation {alignment?: "left" | "center" | "right" | "justify"; block?: "focus" | "panel" | "page" | "card"}
export type ManuscriptPresentation = InlinePresentation & BlockPresentation;
export interface SourceSpan {from: number; to: number}
export interface StyledSpan extends SourceSpan {
  tag: "span" | "div";
  contentFrom: number; contentTo: number;
  opening: SourceSpan; closing: SourceSpan;
  attributes: ManuscriptPresentation;
}
export interface StyleMarkup {spans: StyledSpan[]; markers: SourceSpan[]}
const empty = (): StyleMarkup => ({spans: [], markers: []});
const owns = (value: object, key: string) => Object.hasOwn(value, key);
export function validColor(value: string) {return owns(catalog.colors, value) || /^#[\da-fA-F]{6}$/.test(value);}
export function validFont(value: string): value is ManuscriptFont {return owns(catalog.fonts, value);}
export const cardKeys = ["cardLayout", "cardPreview", "cardColor", "cardGradient", "cardImage"] as const;
export function validCardValue(key: typeof cardKeys[number], value: string) {
  if (key === "cardLayout") return (catalog.card.layouts as string[]).includes(value);
  if (key === "cardPreview") return (catalog.card.previews as string[]).includes(value);
  if (key === "cardColor") return validColor(value);
  if (key === "cardGradient") return /^#[\da-fA-F]{6},#[\da-fA-F]{6}$/.test(value);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 || match[2].length > Math.ceil(catalog.card.max_image_bytes / 3) * 4) return false;
  try {
    const bytes = atob(match[2]);
    if (bytes.length > catalog.card.max_image_bytes || btoa(bytes) !== match[2]) return false;
    return match[1] === "image/png" ? bytes.startsWith("\x89PNG\r\n\x1a\n") : match[1] === "image/jpeg" ? bytes.startsWith("\xff\xd8\xff") : bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
  } catch {return false;}
}
export function validCard(value: ManuscriptPresentation) {
  return !cardKeys.some(key => value[key] !== undefined) || value.block === "card"
    && cardKeys.every(key => value[key] === undefined || validCardValue(key, value[key]!))
    && [value.cardColor, value.cardGradient, value.cardImage].filter(Boolean).length <= 1;
}

export function presentationStyle(value: ManuscriptPresentation): Record<string, string> {
  const result: Record<string, string> = {};
  if (value.font && validFont(value.font)) result.fontFamily = catalog.fonts[value.font].css;
  if (value.color && validColor(value.color)) {
    const color = catalog.colors[value.color as keyof typeof catalog.colors];
    result.color = color ? `light-dark(${color.light}, ${color.dark})` : value.color;
  }
  if (value.alignment && catalog.alignments.includes(value.alignment)) result.textAlign = value.alignment;
  return result;
}

/** 只生成合同声明的属性；不接纳任意CSS、节点或远程引用。 */
export function presentationTag(tag: "span" | "div", value: ManuscriptPresentation) {
  const attrs: string[] = [];
  if (tag === "span") {
    if (value.color && validColor(value.color)) attrs.push(`${catalog.attributes.color}="${value.color.toLowerCase()}"`);
    if (value.font && validFont(value.font)) attrs.push(`${catalog.attributes.font}="${value.font}"`);
  } else {
    if (value.alignment && catalog.alignments.includes(value.alignment)) attrs.push(`${catalog.attributes.alignment}="${value.alignment}"`);
    if (value.block && catalog.blocks.includes(value.block)) attrs.push(`${catalog.attributes.block}="${value.block}"`);
    if (value.block === "card" && validCard(value)) for (const key of cardKeys) if (value[key]) attrs.push(`${catalog.attributes[key]}="${value[key]}"`);
  }
  return attrs.length ? `<${tag} ${attrs.join(" ")}>` : "";
}

function attributes(tag: string, raw: string): ManuscriptPresentation | null {
  const result: ManuscriptPresentation = {}, seen = new Set<string>();
  let rest = raw;
  while (rest.length) {
    if (!rest.trim()) break;
    const match = /^\s+([\w-]+)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/.exec(rest);
    if (!match || seen.has(match[1])) return null;
    const [, key] = match, value = match[2] ?? match[3]; seen.add(key);
    if (tag === "span" && key === catalog.attributes.color && validColor(value)) result.color = value.toLowerCase();
    else if (tag === "span" && key === catalog.attributes.font && validFont(value)) result.font = value;
    else if (tag === "div" && key === catalog.attributes.alignment && catalog.alignments.includes(value)) result.alignment = value as BlockPresentation["alignment"];
    else if (tag === "div" && key === catalog.attributes.block && catalog.blocks.includes(value)) result.block = value as BlockPresentation["block"];
    else if (tag === "div" && cardKeys.some(name => catalog.attributes[name] === key && validCardValue(name, value))) {
      const name = cardKeys.find(name => catalog.attributes[name] === key)!;
      Object.assign(result, {[name]: value});
    }
    else return null;
    rest = rest.slice(match[0].length);
  }
  return Object.keys(result).length && validCard(result) ? result : null;
}

/** 语法树限定候选；严格配对后才隐藏标记，未知或失配内容保持原文。 */
export function markdownStyleMarkup(source: string, tree: Tree): StyleMarkup {
  if (!source.includes("data-hetu-")) return empty();
  const tokens: (SourceSpan & {tag: "span" | "div"; close: boolean; attributes: ManuscriptPresentation | null})[] = [];
  tree.iterate({enter(node) {
    if (["Link", "Image", "LinkReference", "InlineCode", "FencedCode", "CodeBlock"].includes(node.name)) return false;
    if (node.name !== "HTMLTag" && node.name !== "HTMLBlock") return;
    const raw = source.slice(node.from, node.to), text = raw.trim();
    const match = /^<(\/?)(span|div)(\s[^<>\r\n]*|)>$/.exec(text);
    if (match && (!match[1] || !match[3].trim())) {
      const from = node.from + raw.indexOf(text), to = from + text.length, tag = match[2] as "span" | "div";
      const lineStart = Math.max(source.lastIndexOf("\n", from - 1), source.lastIndexOf("\r", from - 1)) + 1;
      const nextBreak = source.slice(to).search(/[\r\n]/), lineEnd = nextBreak < 0 ? source.length : to + nextBreak;
      const standalone = tag !== "div" || !source.slice(lineStart, from).trim() && !source.slice(to, lineEnd).trim();
      if (standalone) tokens.push({from, to, tag, close: !!match[1], attributes: match[1] ? null : attributes(tag, match[3])});
    }
    return false;
  }});
  const stack: typeof tokens = [], spans: StyledSpan[] = [];
  for (const token of tokens) {
    if (!token.close) {
      if (stack.length >= catalog.max_depth) return empty();
      stack.push(token);
    } else {
      const opening = stack.pop();
      if (!opening || opening.tag !== token.tag) return empty();
      if (opening.attributes) spans.push({from: opening.from, to: token.to, tag: token.tag,
        contentFrom: opening.to, contentTo: token.from, opening: {from: opening.from, to: opening.to}, closing: {from: token.from, to: token.to}, attributes: opening.attributes});
    }
  }
  if (stack.length) return empty();
  spans.sort((a, b) => a.from - b.from || b.to - a.to);
  return {spans, markers: spans.flatMap(span => [span.opening, span.closing]).sort((a, b) => a.from - b.from)};
}

export function presentationAt(markup: StyleMarkup, from: number, to = from): ManuscriptPresentation {
  return Object.assign({}, ...markup.spans.filter(span => span.contentFrom <= from && span.contentTo >= to).map(span => span.attributes));
}
