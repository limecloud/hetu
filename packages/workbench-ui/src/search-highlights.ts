/** 同页多个只读文稿独立查询，关闭一侧不会清除另一侧的命中。 */
const readers = new Map<object, {ranges: Range[]; current: Range[]}>();
export function setReaderHighlights(owner: object, ranges?: Range[], current: Range[] = []) {
  if (ranges) readers.set(owner, {ranges, current}); else readers.delete(owner);
  if (typeof CSS === "undefined" || !CSS.highlights) return;
  const values = [...readers.values()];
  for (const [name, items] of [["hetu-search", values.flatMap(value => value.ranges)], ["hetu-search-current", values.flatMap(value => value.current)]] as const) {
    if (items.length) CSS.highlights.set(name, new Highlight(...items)); else CSS.highlights.delete(name);
  }
}
