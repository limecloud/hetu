import {parseFountain} from "./fountain.ts";
import {manuscriptLines} from "./manuscript-lines.ts";
export interface DiffBlock { from: number; to: number; text: string }
export interface ManuscriptDifference { before?: DiffBlock; after?: DiffBlock; kind: "equal" | "replace" | "insert" | "delete" }

/** 保留完整原文字节顺序；小说按段，剧本按场，不以展示文字回写原稿。 */
export function manuscriptBlocks(text: string, format = "plain"): DiffBlock[] {
  if (!text) return [];
  const boundaries = format === "fountain"
    ? parseFountain(text).lines.filter(line => line.kind === "scene").map(line => line.from)
    : manuscriptLines(text).filter(line => line.from > 0 && !text.slice(line.from, line.to).trim()).map(line => line.breakTo);
  const points = [...new Set([0, ...boundaries, text.length])].sort((a, b) => a - b);
  return points.slice(0, -1).map((from, i) => ({from, to: points[i + 1], text: text.slice(from, points[i + 1])}));
}

/** 有界序列对齐；大改动先用唯一原段定位，剩余整段明确交给作者核对。 */
export function compareManuscripts(before: string, after: string, format = "plain") {
  const left = manuscriptBlocks(before, format), right = manuscriptBlocks(after, format);
  const pairs: [number, number][] = [];
  let coarse = false;
  function align(a: number, endA: number, b: number, endB: number) {
    while (a < endA && b < endB && left[a].text === right[b].text) pairs.push([a++, b++]);
    let suffix = 0;
    while (a < endA - suffix && b < endB - suffix && left[endA - suffix - 1].text === right[endB - suffix - 1].text) suffix++;
    const stopA = endA - suffix, stopB = endB - suffix;
    if ((stopA - a) * (stopB - b) <= 40000) {
      const width = stopB - b + 1, scores = new Uint32Array((stopA - a + 1) * width);
      for (let i = stopA - 1; i >= a; i--) for (let j = stopB - 1; j >= b; j--) {
        const pos = (i - a) * width + j - b;
        scores[pos] = left[i].text === right[j].text ? 1 + scores[pos + width + 1] : Math.max(scores[pos + width], scores[pos + 1]);
      }
      let i = a, j = b;
      while (i < stopA && j < stopB) {
        if (left[i].text === right[j].text) pairs.push([i++, j++]);
        else if (scores[(i - a + 1) * width + j - b] >= scores[(i - a) * width + j - b + 1]) i++; else j++;
      }
    } else {
      const unique = (blocks: DiffBlock[], start: number, end: number) => {
        const map = new Map<string, number>();
        for (let i = start; i < end; i++) map.set(blocks[i].text, map.has(blocks[i].text) ? -1 : i);
        return map;
      };
      const first = unique(left, a, stopA), second = unique(right, b, stopB);
      const anchors: [number, number][] = [];
      for (let i = a; i < stopA; i++) {
        const j = second.get(left[i].text);
        if (first.get(left[i].text) === i && j !== undefined && j >= 0) anchors.push([i, j]);
      }
      const tails: number[] = [], previous: number[] = [];
      for (let i = 0; i < anchors.length; i++) {
        let low = 0, high = tails.length;
        while (low < high) {const mid = (low + high) >> 1; if (anchors[tails[mid]][1] < anchors[i][1]) low = mid + 1; else high = mid;}
        previous[i] = low ? tails[low - 1] : -1; tails[low] = i;
      }
      const ordered: [number, number][] = [];
      for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) ordered.push(anchors[i]);
      ordered.reverse();
      if (!ordered.length) coarse = true;
      else {
        let i = a, j = b;
        for (const [x, y] of ordered) {align(i, x, j, y); pairs.push([x, y]); i = x + 1; j = y + 1;}
        align(i, stopA, j, stopB);
      }
    }
    for (let i = suffix; i > 0; i--) pairs.push([endA - i, endB - i]);
  }
  align(0, left.length, 0, right.length);
  const rows: ManuscriptDifference[] = [];
  let a = 0, b = 0;
  for (const [x, y] of [...pairs, [left.length, right.length]]) {
    while (a < x || b < y) {
      const l = a < x ? left[a++] : undefined, r = b < y ? right[b++] : undefined;
      rows.push({before: l, after: r, kind: l && r ? "replace" : l ? "delete" : "insert"});
    }
    if (x < left.length && y < right.length) {rows.push({before: left[x], after: right[y], kind: "equal"}); a = x + 1; b = y + 1;}
  }
  return {rows, coarse};
}

export function changedSpan(before: DiffBlock, after: DiffBlock) {
  let start = 0, end = 0;
  while (start < Math.min(before.text.length, after.text.length) && before.text[start] === after.text[start]) start++;
  if (/[\uDC00-\uDFFF]/.test(before.text[start] ?? "")) start--;
  while (end < Math.min(before.text.length, after.text.length) - start && before.text[before.text.length - end - 1] === after.text[after.text.length - end - 1]) end++;
  if (/[\uDC00-\uDFFF]/.test(before.text[before.text.length - end] ?? "")) end--;
  return {before: {from: before.from + start, to: before.to - end}, after: {from: after.from + start, to: after.to - end}};
}
