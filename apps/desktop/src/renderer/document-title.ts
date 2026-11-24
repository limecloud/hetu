/** 判断正文首行是否已经承担文稿标题，避免页头与正文重复显示。 */
export function documentTitleInSource(content: string, title: string, format: "markdown" | "plain" | string, screenplay = false) {
  if (screenplay || !title.trim()) return {heading: false, plain: false};
  const first = content.split(/\r\n?|\n/, 1)[0]?.trim() ?? "";
  const expected = title.trim();
  return {heading: format === "markdown" && first === "# " + expected, plain: first === expected};
}
