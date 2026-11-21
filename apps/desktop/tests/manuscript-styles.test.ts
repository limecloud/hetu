import test from "node:test";
import assert from "node:assert/strict";
import fixtures from "../../../contracts/fixtures/manuscript-styles.json" with {type: "json"};
import {manuscriptFormat, manuscriptVisibleText} from "../../../packages/workbench-ui/src/manuscript-format.ts";
import {presentationAt, presentationTag, presentationStyle, validCardValue, manuscriptStyles} from "../../../packages/workbench-ui/src/manuscript-styles.ts";

test("样式合同共享夹具保留未知源、字面代码与确切Unicode坐标", () => {
  for (const fixture of fixtures) {
    const parsed = manuscriptFormat(fixture.source), {markers, spans} = parsed.markup;
    let projected = "", cursor = 0;
    for (const marker of markers) {projected += fixture.source.slice(cursor, marker.from); cursor = marker.to;}
    projected += fixture.source.slice(cursor);
    assert.equal(projected, fixture.without_style, fixture.name);
    assert.deepEqual(spans.map(span => span.attributes), fixture.attributes, fixture.name);
    for (const span of spans) {
      assert.equal(fixture.source.slice(span.from, span.opening.to), fixture.source.slice(span.opening.from, span.contentFrom));
      const prefixBytes = Buffer.byteLength(fixture.source.slice(0, span.contentFrom));
      assert.equal(Buffer.from(fixture.source).subarray(prefixBytes, prefixBytes + Buffer.byteLength(fixture.source.slice(span.contentFrom, span.contentTo))).toString(), fixture.source.slice(span.contentFrom, span.contentTo));
    }
  }
});

test("内嵌背景有界且两端只接纳明确文件头，任意路径和CSS不能成为背景", () => {
  assert.equal(validCardValue("cardImage", "file:///private/image.png"), false);
  assert.equal(validCardValue("cardImage", "url(https://public.test/image.png)"), false);
  assert.equal(validCardValue("cardImage", "data:image/png;base64," + Buffer.alloc(manuscriptStyles.card.max_image_bytes + 1).toString("base64")), false);
  assert.equal(validCardValue("cardGradient", "#aabbcc,#112233"), true);
  assert.equal(validCardValue("cardGradient", "red,blue"), false);
});

test("嵌套颜色与字体继承、已识别标记隐藏而代码和未知HTML保持原义", () => {
  const source = fixtures.find(value => value.name === "nested")!.source, parsed = manuscriptFormat(source);
  assert.equal(manuscriptVisibleText(source), "甲乙丙");
  assert.deepEqual(presentationAt(parsed.markup, source.indexOf("乙")), {font: "serif", color: "#12ab34"});
  assert.deepEqual(presentationAt(parsed.markup, source.indexOf("丙")), {font: "serif"});
  assert.equal(presentationTag("span", {color: "#12AB34", font: "serif"}), '<span data-hetu-color="#12ab34" data-hetu-font="serif">');
  assert.equal(presentationTag("span", {color: "url(remote)"}), "");
  assert.equal(presentationStyle({color: "red"}).color, "light-dark(#ce2c31, #ff9592)");
});
