import test from "node:test";
import assert from "node:assert/strict";
import {Authoring} from "../src/main/authoring.ts";
import {RecoveryStore} from "../src/main/recovery.ts";

const work = {workspace_id: "workspace-read", kind: "novel", object_id: "novel-read"} as const;
const success = (data: unknown) => ({status: "succeeded", data});

test("已核验的目录页直接支持末章读取，不再扫描同一作品目录", async () => {
  let lists = 0, reads = 0;
  const core = async (action: string, input: any) => {
    if (action === "hetu.documents.list") {
      lists++; assert.deepEqual(input.work_ref, work);
      return success({documents: [{document_id: input.cursor ? "last" : "first"}], next_cursor: input.cursor ? null : "second"});
    }
    if (action === "hetu.documents.get") {reads++; return success({work_ref: work, document: {document_id: input.document_id}, content: "固定正文🌿"});}
    if (action === "hetu.annotations.list") return success({annotations: []});
    throw Error(action);
  };
  const author = new Authoring(work, "unused-read-only", new RecoveryStore(), core, () => true);
  await author.read("hetu.documents.list", {limit: 100});
  await author.read("hetu.documents.list", {limit: 100, cursor: "second"});
  assert.equal(lists, 2);
  assert.equal((await author.read("hetu.documents.get", {document_id: "last"})).data.content, "固定正文🌿");
  await author.read("hetu.annotations.list", {document_id: "last"});
  assert.equal(reads, 1); assert.equal(lists, 2);
});

test("错误作品、失败页及迟到目录不增加文稿归属", async () => {
  let active = true, fail = true, lists = 0, reads = 0;
  let release: () => void = () => {};
  const core = async (action: string, input: any) => {
    if (action === "hetu.documents.list") {
      lists++; assert.deepEqual(input.work_ref, work);
      if (input.cursor === "delayed") {await new Promise<void>(resolve => {release = resolve;}); return success({documents: [{document_id: "late"}]});}
      if (fail) return {status: "failed", error: {message: "原目录不可读"}, data: {documents: [{document_id: "foreign"}]}};
      return success({documents: []});
    }
    reads++; throw Error("不应读取未获核验的文稿");
  };
  const author = new Authoring(work, "unused-read-only", new RecoveryStore(), core, () => active);
  await assert.rejects(author.read("hetu.documents.list", {work_ref: {...work, object_id: "other"}}), /不能.*切换作品/);
  assert.equal(lists, 0);
  assert.equal((await author.read("hetu.documents.list", {})).status, "failed");
  fail = false;
  await assert.rejects(author.read("hetu.documents.get", {document_id: "foreign"}), /不属于当前作品/);
  const pending = author.read("hetu.documents.list", {cursor: "delayed"});
  active = false; release(); await assert.rejects(pending, /上下文已变化/); active = true;
  await assert.rejects(author.read("hetu.documents.get", {document_id: "late"}), /不属于当前作品/);
  assert.equal(reads, 0); assert.equal(lists, 4);
});
