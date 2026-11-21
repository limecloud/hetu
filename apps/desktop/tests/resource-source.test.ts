import {test} from "node:test";
import assert from "node:assert/strict";
import {resourceReadingParts, resourceReadingTitle} from "../src/renderer/resource-source.ts";

const source = {kind: "document", document_id: "doc-one", revision_id: "revision-one", sha256: "a".repeat(64)};
test("资料名和正文标题略有不同时保留作者正文标题，正文中段标题不替换资料名", () => {
  assert.equal(resourceReadingTitle("# 改编依据 **第1部**\n\n原著。", "改编依据 第1部分"), "改编依据 第1部");
  assert.equal(resourceReadingTitle("介绍。\n\n# 正文分组", "资料名称"), "资料名称");
  assert.equal(resourceReadingTitle("\n\n# 一级标题\n\n正文。", "资料名称"), "一级标题");
  assert.equal(resourceReadingTitle("## 章节\n\n正文。", "资料名称"), "资料名称");
});
test("固定来源的阅读投影保留全部原字节与混合换行", () => {
  const text = `# 资料🌿\r\n\r\n固定来源： \`${JSON.stringify(source)}\`\r\n\r\n原文。\n后记。`;
  const parts = resourceReadingParts(text);
  assert.equal(parts.map(part => part.text).join(""), text);
  assert.equal(parts.length, 3); assert.deepEqual(parts[1].source, source);
  assert.equal(parts[0].text, "# 资料🌿\r\n\r\n");
});
test("代码、未知字段、无效摘要及普通JSON保持可见原文", () => {
  for (const text of [JSON.stringify(source), `\`\`\`json\n固定来源：${JSON.stringify(source)}\n\`\`\``, `固定来源：${JSON.stringify({...source, notes:"不可隐藏的资料"})}`, `固定来源：${JSON.stringify({...source, sha256:"无效"})}`, `固定来源：${JSON.stringify({...source, kind:"other"})}`, "固定来源：{无效JSON}"]) {
    assert.deepEqual(resourceReadingParts(text), [{text}]);
  }
});
