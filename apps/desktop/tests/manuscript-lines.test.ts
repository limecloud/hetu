import test from "node:test";
import assert from "node:assert/strict";
import {manuscriptLines} from "../../../packages/workbench-ui/src/manuscript-lines.ts";

test("段落投影保留混合换行、空行和Unicode，已有缩进与特殊段落不重复缩进", () => {
  const text = "首段🌿\r\n\r\n　　已有缩进\r第二段\n> 引文\n# 标题\n````text\n代码\n```\n仍是代码\n````\n恢复叙述。";
  const lines = manuscriptLines(text);
  assert.equal(lines.map(line => text.slice(line.from, line.breakTo)).join(""), text);
  assert.deepEqual(lines.filter(line => line.prose).map(line => text.slice(line.from, line.to)), ["首段🌿", "第二段", "恢复叙述。"]);
  assert.equal(manuscriptLines("单行").length, 1);
  assert.equal(manuscriptLines("单行\r\n").length, 2);
  assert.equal(manuscriptLines("").length, 1);
});
