import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {ReadingStateStore} from "../src/main/reading-state.ts";
import {RecoveryStore} from "../src/main/recovery.ts";

const work = {workspace_id: "workspace_one", kind: "novel" as const, object_id: "novel_one"};
const position = (revision: string) => ({identity: JSON.stringify(["document_one", revision]), top: 320, inset: 28, quote: {byte_start: 3, byte_end: 7, quote: "🌿"}});
test("两个独立工作台合并位置与章节选择，重开可读且作品隔离", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hetu-reading-state-"));
  const a = new ReadingStateStore(directory, new RecoveryStore()), b = new ReadingStateStore(directory, new RecoveryStore());
  await Promise.all([a.save(work, {position: position("revision_one")}), b.save(work, {selected_document_id: "document_one"}), b.save(work, {position: position("revision_two")})]);
  const saved = await new ReadingStateStore(directory, new RecoveryStore()).get(work);
  assert.equal(saved.selected_document_id, "document_one"); assert.equal(Object.keys(saved.positions).length, 2);
  assert.deepEqual(saved.positions[position("revision_one").identity], position("revision_one"));
  await a.save(work, {position: {...position("line_break"), quote: {byte_start: 3, byte_end: 5, quote: "\r\n"}}});
  assert.equal(Object.keys((await a.get({...work, kind: "drama"})).positions).length, 0);
});
test("无效字节和损坏记录拒绝保存，原记录字节不被覆盖", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hetu-reading-state-corrupt-")), store = new ReadingStateStore(directory, new RecoveryStore());
  await assert.rejects(store.save(work, {position: {...position("one"), quote: {byte_start: 0, byte_end: 3, quote: "🌿"}}}), /格式无效/);
  await store.save(work, {selected_document_id: "document_one"});
  const file = path.join(directory, (await readdir(directory)).find(name => name.endsWith(".json"))!);
  await writeFile(file, "{ broken");
  await assert.rejects(store.save(work, {selected_document_id: "document_two"}), /无法读取/);
  assert.equal(await readFile(file, "utf8"), "{ broken");
});
