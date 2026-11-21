import type {ManuscriptFormat, FormattedLine} from "./manuscript-format.ts";
import type {StyledSpan} from "./manuscript-styles.ts";

export interface ManuscriptGroup extends StyledSpan {
  kind: "page" | "card";
  titleLine?: FormattedLine;
  title: string;
  preview: string;
  bodyFrom: number;
  bodyTo: number;
  images?: string[];
}

/** 分组是同一原文中的投影；标题、预览和进入范围不另存事实。 */
export function manuscriptGroups(source: string, format: ManuscriptFormat): ManuscriptGroup[] {
  return format.markup.spans.filter(span => span.tag === "div" && (span.attributes.block === "page" || span.attributes.block === "card")).map(span => {
    const lines = format.lines.filter(line => !line.hidden && line.from >= span.contentFrom && line.to <= span.contentTo);
    const titleLine = lines.find(line => line.runs.some(run => source.slice(run.from, run.to).trim()));
    const title = titleLine?.runs.map(run => source.slice(run.from, run.to)).join("").trim() ?? "";
    const content = source.slice(span.contentFrom, span.contentTo);
    const leading = content.match(/^\s*\n/)?.[0].length ?? 0, trailing = content.match(/\n\s*$/)?.[0].length ?? 0;
    const bodyFrom = Math.min(span.contentTo, span.contentFrom + leading), bodyTo = Math.max(bodyFrom, span.contentTo - trailing);
    const images = format.markup.spans.filter(child => child.from >= span.from && child.to <= span.to && child.attributes.cardImage).map(child => child.attributes.cardImage!);
    return {...span, kind: span.attributes.block as "page" | "card", titleLine, title, bodyFrom, bodyTo, images,
      preview: lines.filter(line => line.from > (titleLine?.from ?? span.contentFrom)).map(line => line.runs.map(run => source.slice(run.from, run.to)).join("")).filter(Boolean).join(" ").slice(0, 180)};
  });
}

export function childGroups(groups: ManuscriptGroup[], parent?: ManuscriptGroup) {
  const within = groups.filter(group => group !== parent && (!parent || group.from >= parent.contentFrom && group.to <= parent.contentTo));
  return within.filter(group => !within.some(other => other !== group && other.contentFrom <= group.from && other.contentTo >= group.to));
}

/** 同一范围可跨多个子页；只进入完整包含目标的最深分组。 */
export function groupAt(groups: ManuscriptGroup[], from: number, to = from) {
  return groups.filter(group => group.contentFrom <= from && group.contentTo >= to).at(-1);
}
