export interface ManuscriptLine { from: number; to: number; breakTo: number; prose: boolean }

/** 物理换行与原文字节保持；只为可确定的普通叙述行添加视觉段落样式。 */
export function manuscriptLines(text: string): ManuscriptLine[] {
  const lines: ManuscriptLine[] = [];
  let from = 0, fence: {symbol: string; length: number} | undefined;
  const parts = text.split(/(\r\n|\r|\n)/);
  for (let index = 0; index < parts.length; index += 2) {
    const value = parts[index], separator = parts[index + 1] ?? "", marker = value.match(/^\s*(`{3,}|~{3,})(.*)$/);
    const prose = !!value && !fence && !marker && !/^(?:\s|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/u.test(value);
    if (marker) {
      if (!fence) fence = {symbol: marker[1][0], length: marker[1].length};
      else if (marker[1][0] === fence.symbol && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    }
    lines.push({from, to: from + value.length, breakTo: from + value.length + separator.length, prose});
    from += value.length + separator.length;
  }
  return lines;
}
