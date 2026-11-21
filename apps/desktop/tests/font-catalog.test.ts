import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, writeFile, mkdir, symlink} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {readFontFamilies, scanFontDirectories} from "../src/main/font-catalog.ts";
import {nextInterfaceScale} from "../src/interface-scale.ts";

function font(name: string, base = 0) {
  const string = Buffer.from(name, "utf16le").swap16(), value = Buffer.alloc(46 + string.length);
  value.writeUInt32BE(0x00010000, 0); value.writeUInt16BE(1, 4); value.write("name", 12);
  value.writeUInt32BE(base + 28, 20); value.writeUInt32BE(18 + string.length, 24);
  value.writeUInt16BE(1, 30); value.writeUInt16BE(18, 32);
  value.writeUInt16BE(3, 34); value.writeUInt16BE(1, 36); value.writeUInt16BE(0x804, 38); value.writeUInt16BE(16, 40); value.writeUInt16BE(string.length, 42); string.copy(value, 46);
  return value;
}
const reader = (value: Buffer) => async (offset: number, length: number) => {
  assert(offset >= 0 && offset + length <= value.length); return value.subarray(offset, offset + length);
};
test("SFNT家族读取保留中英名称且拒绝控制字符，不读取字形", async () => {
  assert.deepEqual(await readFontFamilies(reader(font("河岸宋体 Serif"))), ["河岸宋体 Serif"]);
  assert.deepEqual(await readFontFamilies(reader(font("bad;name"))), []);
  const value = font("名称"); value.writeUInt32BE(300000, 24);
  await assert.rejects(readFontFamilies(reader(value)), /超出预算/);
});
test("集合中的字体使用绝对名称表偏移，异常表与超量集合拒绝", async () => {
  const first = font("家族一", 20), second = font("Family Two", 20 + first.length), value = Buffer.alloc(20 + first.length + second.length);
  value.write("ttcf"); value.writeUInt32BE(2, 8); value.writeUInt32BE(20, 12); value.writeUInt32BE(20 + first.length, 16); first.copy(value, 20); second.copy(value, 20 + first.length);
  assert.deepEqual(await readFontFamilies(reader(value)), ["家族一", "Family Two"]);
  value.writeUInt32BE(200, 8); await assert.rejects(readFontFamilies(reader(value)), /数量超出预算/);
});
test("目录递归去重名称、坏文件报告不完整，结果不暴露路径", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hetu-font-catalog-")); await mkdir(path.join(directory, "nested"));
  await Promise.all([writeFile(path.join(directory, "one.ttf"), font("测试宋体")), writeFile(path.join(directory, "nested/two.otf"), font("测试宋体")), writeFile(path.join(directory, "bad.ttf"), "broken")]);
  await symlink(path.join(directory, "one.ttf"), path.join(directory, "alias.ttf"));
  const value = await scanFontDirectories([directory, directory]);
  assert.deepEqual(value.families, ["测试宋体"]); assert.equal(value.skipped, 1); assert.equal(value.complete, false); assert.equal(value.scanned, 3);
  assert(!JSON.stringify(value).includes(directory));
});
test("界面缩放档位保持边界，恢复由独立100%命令表达", () => {
  assert.equal(nextInterfaceScale(100, 1), 110); assert.equal(nextInterfaceScale(125, -1), 110);
  assert.equal(nextInterfaceScale(200, 1), 200); assert.equal(nextInterfaceScale(80, -1), 80);
});
