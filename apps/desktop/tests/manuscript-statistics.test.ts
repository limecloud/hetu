import test from "node:test";
import assert from "node:assert/strict";
import {calculateStatistics} from "../src/renderer/manuscript-statistics.ts";

test("长文计数按字素、汉字与西文词语分别统计，不拆开Emoji及组合字母", async () => {
  const source = "河图🌿👩‍👩‍👧‍👦 e\u0301cole don't l’été.\r\n";
  const stats = await calculateStatistics(source);
  assert.equal(stats?.count, 2);
  assert.equal(stats?.words, 3);
  assert.equal(stats?.characters, [...new Intl.Segmenter(undefined, {granularity: "grapheme"}).segment(source)].length);
  assert.deepEqual(await calculateStatistics(""), {count: 0, words: 0, characters: 0});
});

test("大稿件统计让出事件循环，旧请求可取消", async () => {
  let active = true, yielded = false;
  const timer = setTimeout(() => { yielded = true; active = false; }, 0);
  assert.equal(await calculateStatistics("长篇文本🌿 ".repeat(30000), () => active), undefined);
  assert.equal(yielded, true);
  clearTimeout(timer);
});
