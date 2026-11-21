import test from "node:test";
import assert from "node:assert/strict";
import {manuscriptFormat, manuscriptVisibleText} from "../../../packages/workbench-ui/src/manuscript-format.ts";

test("格式投影只隐藏确切语法，嵌套强调、转义与代码映射原稿范围", () => {
  const source = "# 雾港\r\n\r\n普通 **粗体 *斜体🌿***，\\*原字符。\r\n> 引用 **保留**\r\n\r\n```text\r\n**代码不强调**\r\n```\r\n\r\n---\r\n";
  const format = manuscriptFormat(source, "雾港"), visible = manuscriptVisibleText(source, format);
  assert(!visible.includes("# 雾港"));
  assert(visible.includes("普通 粗体 斜体🌿，*原字符。"));
  assert(visible.includes("引用 保留"));
  assert(visible.includes("**代码不强调**"));
  assert(!visible.includes("```"));
  const emoji = format.lines.flatMap(line => line.runs).find(run => source.slice(run.from, run.to).includes("🌿"))!;
  assert(emoji.styles.includes("strong") && emoji.styles.includes("emphasis"));
  assert.equal(source.slice(emoji.from, emoji.to), "斜体🌿");
  assert(format.lines.some(line => line.kind === "rule" && !line.runs.length));
  assert(format.lines.some(line => line.kind === "quote"));
});

test("标题仅按首个一级结构与确切标题折叠，未知链接和HTML保留可读原稿", () => {
  const source = "不同标题\n===\n\n[链接](https://invalid.test) ![图](file:///secret) <script>不执行</script> &amp;\n\n# 正文中的雾港\n";
  const visible = manuscriptVisibleText(source, manuscriptFormat(source, "雾港"));
  assert(visible.includes("不同标题"));
  assert(visible.includes("[链接](https://invalid.test)"));
  assert(visible.includes("![图](file:///secret)"));
  assert(visible.includes("<script>不执行</script> &amp;"));
  assert(visible.includes("正文中的雾港"));
  assert.equal(manuscriptVisibleText("标题\r\n===\r\n\r\n正文。", manuscriptFormat("标题\r\n===\r\n\r\n正文。", "标题")).trim(), "正文。");
});

test("删除线仅隐藏已配对标记，代码内保留原文并保持字节映射", () => {
  const source = "~~旧 **内容🌿**~~ 与 `~~原样~~`。\r\n- [ ] 清单";
  const formatted = manuscriptFormat(source);
  assert.equal(manuscriptVisibleText(source, formatted), "旧 内容🌿 与 ~~原样~~。\n清单");
  assert.equal(formatted.lines[1].marker, "☐");
  const run = formatted.lines[0].runs.find(run => source.slice(run.from, run.to).includes("内容"))!;
  assert(run.styles.includes("strike") && run.styles.includes("strong"));
});

test("大量分散格式范围的投影保持全部字形及单调原文坐标", () => {
  const source = Array.from({length: 3000}, (_, i) => `段${i} **重点** 和 *变化*。`).join("\n");
  const format = manuscriptFormat(source);
  assert.equal(format.lines.length, 3000);
  let end = 0;
  for (const line of format.lines) for (const run of line.runs) { assert(run.from >= end); assert(run.to > run.from); end = run.to; }
  assert(manuscriptVisibleText(source, format).endsWith("段2999 重点 和 变化。"));
});
