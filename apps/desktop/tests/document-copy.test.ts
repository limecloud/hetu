import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {Authoring} from "../src/main/authoring.ts";
import {RecoveryStore} from "../src/main/recovery.ts";

test("文稿副本先固定来源和目录，提交丢回执后沿原操作恢复，不重复创建", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hetu-copy-")), recovery = new RecoveryStore();
  const work = {workspace_id: "workspace-test", kind: "novel", object_id: "novel-test"} as const;
  let active = true, writes = 0; const operations = new Map<string, any>();
  const core = async (action: string, input: any) => {
    if (action === "hetu.documents.list") return {status: "succeeded", data: {documents: [{document_id: "doc-source"}]}};
    if (action === "hetu.documents.get") return {status: "succeeded", data: {document: {document_id: "doc-source", title: "雨夜"}, revision: {revision_id: "rev-source", sha256: "fixed-sha", source_format: "markdown", size_bytes: 12}, content: "原文🌿\r\n"}};
    if (action === "hetu.novels.get") return {status: "succeeded", data: {revision: 3, sha256: "directory-sha"}};
    if (action === "hetu.documents.duplicate") {
      writes++;
      assert.deepEqual(input.work_ref, work); assert.deepEqual(input.expected, {revision: 3, sha256: "directory-sha"});
      assert.deepEqual(input.source_ref, {document_id: "doc-source", revision_id: "rev-source", sha256: "fixed-sha"});
      const result = {status: "succeeded", data: {document: {document_id: "doc-copy", title: input.title}}};
      operations.set(input.operation_key, result); throw new Error("transport closed after commit");
    }
    if (action === "hetu.operations.get") return {status: "succeeded", data: {original_result: operations.get(input.key)}};
    throw new Error(action);
  };
  let author = new Authoring(work, directory, recovery, core, () => active);
  await assert.rejects(author.duplicate("doc-other", "rev-source"), /不属于当前作品/);
  await assert.rejects(author.duplicate("doc-source", "rev-old"), /已有新修订/);
  const preview = await author.duplicate("doc-source", "rev-source");
  assert.equal(writes, 0); assert.equal(preview.size_bytes, 12); assert.equal("source" in preview, false);
  await assert.rejects(author.commit(preview.token), /transport closed/);
  assert.equal((await author.journal("doc-source")).status, "pending");
  const another = await author.duplicate("doc-source", "rev-source");
  await assert.rejects(author.commit(another.token), /先恢复/);
  author = new Authoring(work, directory, recovery, core, () => active);
  assert.equal((await author.recover("doc-source")).data.document.document_id, "doc-copy");
  assert.equal(writes, 1);
  const record = await author.journal("doc-source"); await author.acknowledge("doc-source", record.input.operation_key);
  assert.equal(await author.journal("doc-source"), null);
  active = false; await assert.rejects(author.duplicate("doc-source", "rev-source"), /上下文已变化/);
});
