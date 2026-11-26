import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, writeFile, mkdir, symlink} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {readFontFamilies, scanFontDirectories} from "../src/main/font-catalog.ts";
import {nextInterfaceScale} from "../src/interface-scale.ts";

function font(name: string, base = 0) {
  return namedFont([{name, id: 16, language: 0x804}], base);
}
function namedFont(records: {name: string; id: number; language: number}[], base = 0) {
  const strings = records.map(record => Buffer.from(record.name, "utf16le").swap16());
  const start = 6 + records.length * 12, size = start + strings.reduce((total, string) => total + string.length, 0), value = Buffer.alloc(28 + size);
  value.writeUInt32BE(0x00010000, 0); value.writeUInt16BE(1, 4); value.write("name", 12);
  value.writeUInt32BE(base + 28, 20); value.writeUInt32BE(size, 24);
  value.writeUInt16BE(records.length, 30); value.writeUInt16BE(start, 32);
  let offset = 0;
  records.forEach((record, i) => {
    const at = 34 + i * 12;
    value.writeUInt16BE(3, at); value.writeUInt16BE(1, at + 2); value.writeUInt16BE(record.language, at + 4);
    value.writeUInt16BE(record.id, at + 6); value.writeUInt16BE(strings[i].length, at + 8); value.writeUInt16BE(offset, at + 10);
    strings[i].copy(value, 28 + start + offset); offset += strings[i].length;
  });
  return value;
}
const reader = (value: Buffer) => async (offset: number, length: number) => {
  assert(offset >= 0 && offset + length <= value.length); return value.subarray(offset, offset + length);
};
test("SFNT家族读取保留中英名称且拒绝控制字符，不读取字形", async () => {
  const result = await readFontFamilies(reader(font("河岸宋体 Serif")));
  assert.deepEqual(result.families, ["河岸宋体 Serif"]); assert.equal(result.cssNames["河岸宋体 Serif"], "河岸宋体 Serif");
  assert.deepEqual((await readFontFamilies(reader(font("bad;name")))).families, []);
  const value = font("名称"); value.writeUInt32BE(300000, 24);
  await assert.rejects(readFontFamilies(reader(value)), /超出预算/);
});
test("本地化家族名保留搜索，选用映射到同字面的英文CSS家族", async () => {
  const result = await readFontFamilies(reader(namedFont([
    {name: "示例细体", id: 1, language: 0x804}, {name: "Example Light", id: 1, language: 0x409},
    {name: "示例", id: 16, language: 0x804}, {name: "Example Family", id: 16, language: 0x809},
  ])));
  assert(result.families.includes("示例细体")); assert.equal(result.cssNames["示例细体"], "Example Family");
  const legacy = await readFontFamilies(reader(namedFont([{name: "报隶-繁", id: 1, language: 0x404}, {name: "Baoli TC", id: 1, language: 0x409}])));
  assert.equal(legacy.cssNames["报隶-繁"], "Baoli TC");
});
test("集合中的字体使用绝对名称表偏移，异常表与超量集合拒绝", async () => {
  const first = font("家族一", 20), second = font("Family Two", 20 + first.length), value = Buffer.alloc(20 + first.length + second.length);
  value.write("ttcf"); value.writeUInt32BE(2, 8); value.writeUInt32BE(20, 12); value.writeUInt32BE(20 + first.length, 16); first.copy(value, 20); second.copy(value, 20 + first.length);
  const result = await readFontFamilies(reader(value));
  assert.deepEqual(result.families, ["家族一", "Family Two"]); assert.equal(result.cssNames["家族一"], "家族一");
  value.writeUInt32BE(200, 8); await assert.rejects(readFontFamilies(reader(value)), /数量超出预算/);
});
test("目录递归去重名称、坏文件报告不完整，结果不暴露路径", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hetu-font-catalog-")); await mkdir(path.join(directory, "nested"));
  await Promise.all([writeFile(path.join(directory, "one.ttf"), font("测试宋体")), writeFile(path.join(directory, "nested/two.otf"), font("测试宋体")), writeFile(path.join(directory, "bad.ttf"), "broken")]);
  await symlink(path.join(directory, "one.ttf"), path.join(directory, "alias.ttf"));
  const value = await scanFontDirectories([directory, directory]);
  assert.deepEqual(value.families, ["测试宋体"]); assert.equal(value.skipped, 1); assert.equal(value.complete, false); assert.equal(value.scanned, 3);
  assert.equal(value.cssNames?.["测试宋体"], "测试宋体");
  assert(!JSON.stringify(value).includes(directory));
});
test("界面缩放档位保持边界，恢复由独立100%命令表达", () => {
  assert.equal(nextInterfaceScale(100, 1), 110); assert.equal(nextInterfaceScale(125, -1), 110);
  assert.equal(nextInterfaceScale(200, 1), 200); assert.equal(nextInterfaceScale(80, -1), 80);
});
