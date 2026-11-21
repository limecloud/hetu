import {test} from "node:test";
import assert from "node:assert/strict";
import {sourceOffsets} from "../src/renderer/annotation-anchors.ts";

test("批注按固定UTF8范围定位，拒绝半个Emoji、错误原文及新稿旧坐标", () => {
  const source = "甲🌿\r\n江岚\n甲🌿", quote = {byte_start: 9, byte_end: 15, quote: "江岚"};
  assert.deepEqual(sourceOffsets(source, quote), {from: 5, to: 7});
  assert.equal(sourceOffsets("新增" + source, quote), null);
  assert.equal(sourceOffsets(source, {...quote, quote: "陈序"}), null);
  assert.equal(sourceOffsets(source, {byte_start: 4, byte_end: 7, quote: "🌿"}), null);
  assert.deepEqual(sourceOffsets(source, {byte_start: 19, byte_end: 23, quote: "🌿"}), {from: 9, to: 11});
});
