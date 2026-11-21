import {manuscriptFormat} from "@hetu/workbench-ui/manuscript-format";

interface DocumentSource {kind: "document"; document_id: string; revision_id: string; sha256: string}
export interface ResourceReadingPart {text: string; source?: DocumentSource}

/** 正文已有独立一级标题时，以作者的标题阅读，资料名仍保留在目录中。 */
export function resourceReadingTitle(text: string, fallback: string): string {
  const first = manuscriptFormat(text).lines.find(line => !line.hidden && line.runs.some(run => text.slice(run.from, run.to).trim()));
  return first?.kind === "heading" && first.level === 1 ? first.runs.map(run => text.slice(run.from, run.to)).join("").trim() || fallback : fallback;
}

/** 只识别独立的固定文稿引用；普通JSON、代码块及未知格式按原文阅读。 */
export function resourceReadingParts(text: string): ResourceReadingPart[] {
  const parts: ResourceReadingPart[] = [];
  let start = 0, offset = 0, fence: string | undefined;
  for (const line of text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
    } else if (!fence) {
      const match = /^\s*固定来源[：:][ \t]*(`?)(\{[^\r\n]*\})\1[ \t]*(?:\r\n|\r|\n)?$/.exec(line);
      if (match) {
        try {
          const source = JSON.parse(match[2]);
          if (source.kind === "document" && typeof source.document_id === "string" && source.document_id.length && typeof source.revision_id === "string" && source.revision_id.length && typeof source.sha256 === "string" && /^[a-f0-9]{64}$/i.test(source.sha256)
            && Object.keys(source).every(key => ["kind", "document_id", "revision_id", "sha256"].includes(key))) {
            if (offset > start) parts.push({text: text.slice(start, offset)});
            parts.push({text: line, source}); start = offset + line.length;
          }
        } catch { /* 无法核对的来源保留原文。 */ }
      }
    }
    offset += line.length;
  }
  if (start < text.length || !parts.length) parts.push({text: text.slice(start)});
  return parts;
}
