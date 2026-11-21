import test from "node:test";
import assert from "node:assert/strict";
import {findText, type SearchOptions} from "../src/renderer/text-search.ts";
import {textProjection, projectedRange} from "@hetu/workbench-ui/text-projection";

const options: SearchOptions = {query: "", caseSensitive: false, wholeWord: false, regex: false, segmented: false};
test("忽略变音符号保留组合字符、原文范围和替换捕获", () => {
  const source = "café cafe\u0301 CAFÉ 🌿";
  const result = findText(source, {...options, query: "cafe", diacriticsInsensitive: true});
  assert.deepEqual(result.matches.map(match => source.slice(match.from, match.to)), ["café", "cafe\u0301", "CAFÉ"]);
  const captured = findText(source, {...options, query: "(?<word>cafe)", regex: true, diacriticsInsensitive: true}, "$<word>-$1-$&");
  assert.deepEqual(captured.matches.map(match => match.replacement), ["café-café-café", "cafe\u0301-cafe\u0301-cafe\u0301", "CAFÉ-CAFÉ-CAFÉ"]);
  assert.equal(findText(source, {...options, query: "cafe"}).matches.length, 1);
});
test("字面、大小写、西文整词、中文分词和Unicode分别匹配", () => {
  const source = "Foo foo food foo-bar 🌿 e\u0301cole 汉字分词";
  assert.equal(findText(source, {...options, query: "foo"}).matches.length, 4);
  assert.equal(findText(source, {...options, query: "Foo", caseSensitive: true}).matches.length, 1);
  assert.equal(findText(source, {...options, query: "foo", wholeWord: true}).matches.length, 3);
  assert.equal(findText(source, {...options, query: "["}).matches.length, 0);
  assert.equal(findText(source, {...options, query: "🌿"}).matches[0].to - findText(source, {...options, query: "🌿"}).matches[0].from, 2);
  const segmented = findText("北京大学北京", {...options, query: "北京", segmented: true});
  assert(segmented.matches.every(match => [...new Intl.Segmenter("zh-CN", {granularity: "word"}).segment("北京大学北京")].some(part => part.index === match.from && part.index + part.segment.length === match.to && part.isWordLike)));
});
test("正则替换展开固定捕获，非法查询与过大结果有界拒绝", () => {
  const result = findText("甲12 乙34", {...options, query: "(?<name>[甲乙])(\\d+)", regex: true}, "$<name>-$2-$$-$&");
  assert.deepEqual(result.matches.map(match => match.replacement), ["甲-12-$-甲12", "乙-34-$-乙34"]);
  assert.equal(findText("甲", {...options, query: "(?<name>甲)(?<optional>乙)?", regex: true}, "$<name>$<optional>$<missing>").matches[0].replacement, "甲");
  assert.throws(() => findText("文字", {...options, query: "[", regex: true}), /invalid_regex/);
  assert.throws(() => findText("文字", {...options, query: "^|$", regex: true}), /zero_width/);
  assert.throws(() => findText("文字", {...options, query: "a".repeat(1001)}), /query_limit/);
  assert(findText("甲".repeat(10005), {...options, query: "甲"}).truncated);
  assert.throws(() => findText("甲".repeat(1000), {...options, query: "甲"}, "乙".repeat(10000)), /replacement_limit/);
});
test("格式投影查询回到原稿，跨隐藏标记的范围保持可核对", () => {
  const source = "# 标题\r\n\r\n**粗体**与*斜体🌿*。\r\n尾段";
  const projection = textProjection(source, "markdown", "标题");
  assert(!projection.text.includes("标题")); assert(projection.text.includes("粗体与斜体🌿"));
  const result = findText(projection.text, {...options, query: "斜体🌿"}), match = projectedRange(projection, result.matches[0].from, result.matches[0].to)!;
  assert.equal(source.slice(match.from, match.to), "斜体🌿");
  const all = findText(projection.text, {...options, query: "粗体与斜体"}).matches[0], range = projectedRange(projection, all.from, all.to)!;
  assert.equal(source.slice(range.from, range.to), "粗体**与*斜体");
  const fountain = ".INT. 灯塔 - DAY #1#\r\n\r\n@江岚\r\n**船来了吗**🌿";
  const script = textProjection(fountain, "fountain"), found = findText(script.text, {...options, query: "江岚"}).matches[0];
  const mapped = projectedRange(script, found.from, found.to)!; assert.equal(fountain.slice(mapped.from, mapped.to), "江岚");
});

test("原稿逻辑换行匹配映射完整CRLF，不将半个换行当作编辑位置", () => {
  const source = "甲\r\n乙\r丙\n丁", projection = textProjection(source, "markdown", "", true);
  assert.equal(projection.text, "甲\n乙\n丙\n丁");
  const matches = findText(projection.text, {...options, query: "\\n", regex: true}).matches;
  assert.deepEqual(matches.map(match => {const range = projectedRange(projection, match.from, match.to)!; return source.slice(range.from, range.to);}), ["\r\n", "\r", "\n"]);
  const match = findText(projection.text, {...options, query: "甲\n乙"}).matches[0], range = projectedRange(projection, match.from, match.to)!;
  assert.equal(source.slice(range.from, range.to), "甲\r\n乙");
});
