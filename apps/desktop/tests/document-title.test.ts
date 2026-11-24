import {test} from "node:test";
import assert from "node:assert/strict";
import {documentTitleInSource} from "../src/renderer/document-title.ts";

test("正文首行标题只显示一次，剧本标题页保留专业排版", () => {
  assert.deepEqual(documentTitleInSource("第二章 归航\n\n正文。", "第二章 归航", "plain"), {heading: false, plain: true});
  assert.deepEqual(documentTitleInSource("# 第二章 归航\n\n正文。", "第二章 归航", "markdown"), {heading: true, plain: false});
  assert.deepEqual(documentTitleInSource("正文。\n\n第二章 归航", "第二章 归航", "markdown"), {heading: false, plain: false});
  assert.deepEqual(documentTitleInSource("第二章 归航\n\n正文。", "第二章 归航", "plain", true), {heading: false, plain: false});
});
