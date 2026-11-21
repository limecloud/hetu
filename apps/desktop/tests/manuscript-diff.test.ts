import test from "node:test";
import assert from "node:assert/strict";
import {compareManuscripts, changedSpan, manuscriptBlocks} from "../../../packages/workbench-ui/src/manuscript-diff.ts";

test("段落比较保留混合换行、插入删除与重复段落的确切范围", () => {
  assert.equal(manuscriptBlocks("段落第一行\r\n第二行\r\n\r\n下一段").length, 2);
  const before = "首段🌿\r\n\r\n重复。\n\n旧句。\r\r重复。\n\n末段。";
  const after = "开场。\n\n首段🌿\r\n\r\n重复。\n\n新句。\r\r重复。\n\n末段。";
  const {rows} = compareManuscripts(before, after);
  assert.equal(rows.map(row => row.before?.text ?? "").join(""), before);
  assert.equal(rows.map(row => row.after?.text ?? "").join(""), after);
  assert.equal(rows.filter(row => row.kind === "insert").length, 1);
  assert.equal(rows.filter(row => row.kind === "replace").length, 1);
  for (const row of rows) for (const [side, text] of [[row.before, before], [row.after, after]] as const) if (side) assert.equal(text.slice(side.from, side.to), side.text);
});
test("剧本按场次对齐，标题页和对白完整保留", () => {
  const source = "Title: 雾港\n\n.码头 日 外\n\n江岚\n灯亮了。\n\n.阁楼 夜 内\n\n风吹开窗。";
  const next = source.replace("灯亮了。", "灯又亮了。");
  assert.equal(manuscriptBlocks(source, "fountain").length, 3);
  const {rows} = compareManuscripts(source, next, "fountain");
  assert.equal(rows.filter(row => row.kind === "replace").length, 1);
  assert.equal(rows.map(row => row.before?.text ?? "").join(""), source);
});
test("增删高亮不会截断同前缀Emoji的代理字符", () => {
  for (const [a, b] of [["甲🌿乙", "甲🌸乙"], ["🌿", ""], ["甲🌿", "甲🌿新增"]]) {
    const left = {from: 0, to: a.length, text: a}, right = {from: 0, to: b.length, text: b};
    const span = changedSpan(left, right);
    for (const [text, range] of [[a, span.before], [b, span.after]] as const) {
      assert(!/[\uDC00-\uDFFF]/.test(text[range.from] ?? ""));
      assert(!/[\uDC00-\uDFFF]/.test(text[range.to] ?? ""));
    }
  }
});
test("大篇修改有界对齐，无法精细定位时保留两侧全文", () => {
  const a = Array.from({length: 1000}, (_, i) => "旧段" + i + "\n\n").join("");
  const b = Array.from({length: 1100}, (_, i) => "新段" + i + "\n\n").join("");
  const result = compareManuscripts(a, b);
  assert.equal(result.coarse, true);
  assert.equal(result.rows.map(row => row.before?.text ?? "").join(""), a);
  assert.equal(result.rows.map(row => row.after?.text ?? "").join(""), b);
  const anchored = compareManuscripts(a, "插入\n\n" + a);
  assert.equal(anchored.coarse, false);
  assert.equal(anchored.rows.filter(row => row.kind !== "equal").length, 1);
});
