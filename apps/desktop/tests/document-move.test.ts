import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {Authoring} from "../src/main/authoring.ts";
import {RecoveryStore} from "../src/main/recovery.ts";

test("跨文稿移动固定双端及范围，丢回执后重开恢复同一操作", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hetu-move-")), recovery = new RecoveryStore();
  const work = {workspace_id: "workspace-test", kind: "novel", object_id: "novel-test"} as const;
  const reference = (id: string, revision = "before") => ({document_id: id, revision_id: id + revision, sha256: id + revision + "sha"});
  const documents = new Map(["source", "target"].map(id => [id, {document: {document_id: id, title: id}, revision: {...reference(id), source_format: "markdown"}, content: id === "source" ? "原文🌿" : "目标"}]));
  const operations = new Map<string, any>(); let writes = 0;
  const move_ref = {move_id: "move-fixed", sha256: "move-sha"};
  const record = {source_after: reference("source", "after"), target_after: reference("target", "after")};
  const core = async (action: string, input: any): Promise<any> => {
    if (action === "hetu.documents.list") return {status: "succeeded", data: {documents: [...documents.values()].map(value => value.document)}};
    if (action === "hetu.documents.get") return {status: "succeeded", data: documents.get(input.document_id)};
    if (action === "hetu.documents.get_move") {assert.deepEqual(input.work_ref, work); assert.deepEqual(input.move_ref, move_ref); return {status: "succeeded", data: {move: record}};}
    if (action === "hetu.documents.move_range") {
      assert.deepEqual(input.work_ref, work); assert.deepEqual(input.source_ref, reference("source")); assert.deepEqual(input.target_ref, reference("target"));
      assert.equal(input.byte_start, 0); assert.equal(input.byte_end, Buffer.byteLength("原文🌿")); assert.equal(input.quote, "原文🌿");
      writes++;
      for (const id of ["source", "target"]) documents.get(id)!.revision = {...reference(id, "after"), source_format: "markdown"};
      const result = {status: "succeeded", data: {source: documents.get("source"), target: documents.get("target"), move_ref}};
      operations.set(input.operation_key, result); throw new Error("response lost after move");
    }
    if (action === "hetu.documents.restore_move") {
      writes++; const result = {status: "succeeded", data: {restored_move_ref: move_ref}};
      operations.set(input.operation_key, result); throw new Error("response lost after restore");
    }
    if (action === "hetu.operations.get") return {status: "succeeded", data: {original_result: operations.get(input.key)}};
    throw new Error(action);
  };
  let author = new Authoring(work, directory, recovery, core, () => true);
  const range = {byte_start: 0, byte_end: Buffer.byteLength("原文🌿"), quote: "原文🌿"};
  await assert.rejects(author.moveRange("source", "sourcebefore", range, reference("foreign")), /不属于当前作品/);
  await assert.rejects(author.moveRange("source", "stale", range, reference("target")), /正文已变化/);
  await assert.rejects(author.moveRange("source", "sourcebefore", {...range, quote: "另文"}, reference("target")), /选区.*不符/);
  const prepared = await author.moveRange("source", "sourcebefore", {...range, work_ref: {kind: "other"}, source_ref: {document_id: "foreign"}} as any, reference("target"));
  assert.equal(writes, 0); assert.equal("content" in prepared, false);
  await assert.rejects(author.commit(prepared.token), /response lost/);
  author = new Authoring(work, directory, recovery, core, () => true);
  assert.deepEqual((await author.recover("source")).data.move_ref, move_ref); assert.equal(writes, 1);
  let journal = await author.journal("source"); await author.acknowledge("source", journal.input.operation_key);
  await assert.rejects(author.restoreMove("target", move_ref), /不属于当前来源/);
  const restore = await author.restoreMove("source", move_ref);
  await assert.rejects(author.commit(restore.token), /response lost/);
  author = new Authoring(work, directory, recovery, core, () => true);
  assert.deepEqual((await author.recover("source")).data.restored_move_ref, move_ref); assert.equal(writes, 2);
  journal = await author.journal("source"); await author.acknowledge("source", journal.input.operation_key);
  documents.get("target")!.revision = {...reference("target", "later"), source_format: "markdown"};
  await assert.rejects(author.restoreMove("source", move_ref), /已有新修订/);
});

test("目标选择后出现未保存恢复稿时，提交前拒绝双端移动", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hetu-move-buffer-"));
  const work = {workspace_id: "workspace-test", kind: "novel", object_id: "novel-test"} as const;
  const buffers = new Map<string, any>(); let writes = 0;
  const core = async (action: string, input: any) => {
    if (action === "hetu.documents.list") return {status: "succeeded", data: {documents: [{document_id: "source"}, {document_id: "target"}]}};
    if (action === "hetu.documents.get") return {status: "succeeded", data: {document: {document_id: input.document_id, title: input.document_id}, revision: {revision_id: "before", sha256: "fixed"}, content: "原文"}};
    writes++; throw new Error(action);
  };
  const author = new Authoring(work, directory, new RecoveryStore(), core, () => true, async id => buffers.get(id));
  const prepare = () => author.moveRange("source", "before", {byte_start: 0, byte_end: Buffer.byteLength("原文"), quote: "原文"}, {document_id: "target", revision_id: "before", sha256: "fixed"});
  const preview = await prepare();
  buffers.set("target", {content: "尚未保存的目标修改"});
  await assert.rejects(author.commit(preview.token), /未保存恢复稿/); assert.equal(writes, 0);
  buffers.set("target", {content: "原文", pending: {operation_key: "unknown"}});
  await assert.rejects(prepare(), /未保存恢复稿/); assert.equal(writes, 0);
});
