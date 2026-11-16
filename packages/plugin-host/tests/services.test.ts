import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pluginService } from "../../../apps/desktop/src/main/plugin-services.ts";
import { exportPluginFile } from "../../../apps/desktop/src/main/plugin-export.ts";

const work = { workspace_id: "workspace_00000000-0000-4000-8000-000000000000", kind: "novel" as const, object_id: "novel_00000000-0000-4000-8000-000000000000" };

test("宿主交接核对固定成果和迟到上下文，只返回复制状态", async () => {
  const ref = { object_id: "ext_00000000-0000-4000-8000-000000000000", revision: 2, sha256: "a".repeat(64) };
  const handoffs: unknown[] = [];
  let stale = false, invalidate = false;
  const context = {
    work, check() { if (stale) throw new Error("上下文变化"); },
    preferences: () => ({ theme: "dark", language: "zh-CN" }),
    async request() {
      if (invalidate) stale = true;
      return { status: "succeeded", data: { object: { ...ref, work_ref: work, content: { nodes: [{ id: "node-1" }] } }, sha256: ref.sha256 } };
    },
    async handoff(input: unknown) { handoffs.push(input); }, async openDocument() {},
  };
  const input = { goal: "核对人物动机", object_ref: ref, node_id: "node-1" };
  assert.deepEqual(await pluginService("handoff", input, context), { copied: true });
  assert.equal(handoffs.length, 1);
  await assert.rejects(() => pluginService("handoff", { ...input, object_ref: { ...ref, sha256: "b".repeat(64) } }, context), /不一致/);
  await assert.rejects(() => pluginService("handoff", { ...input, node_id: "foreign-node" }, context), /不属于/);
  await assert.rejects(() => pluginService("handoff", { ...input, management_ref: {} }, context), /参数无效/);
  invalidate = true;
  await assert.rejects(() => pluginService("handoff", input, context), /上下文变化/);
  assert.equal(handoffs.length, 1);
});

test("正文跳转先核对固定来源，失败时不打开正文", async () => {
  const opened: string[] = [];
  const source = { kind: "document", work_ref: work, document_id: "doc_00000000-0000-4000-8000-000000000000", revision_id: "rev_00000000-0000-4000-8000-000000000000", sha256: "c".repeat(64) };
  let allowed = true;
  const context = {
    work, check() {}, preferences: () => ({ theme: "system", language: "zh-CN" }), async handoff() {},
    async request(action: string, input: unknown) {
      assert.equal(action, "hetu.extensions.sources.inspect");
      assert.deepEqual(input, { source_ref: source });
      return allowed ? { status: "succeeded", data: {} } : { status: "failed", error: { message: "来源已失效" } };
    },
    async openDocument(id: string) { opened.push(id); },
  };
  assert.deepEqual(await pluginService("open_document", { source_ref: source }, context), { opened: true });
  allowed = false;
  await assert.rejects(() => pluginService("open_document", { source_ref: source }, context), /来源已失效/);
  await assert.rejects(() => pluginService("open_document", { source_ref: { ...source, work_ref: { ...work, object_id: "other" } } }, context), /当前作品/);
  assert.deepEqual(opened, [source.document_id]);
});

test("分段导出固定清单且原子替换，摘要错误保留现有文件", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hetu-plugin-export-"));
  const target = path.join(directory, "成果.json");
  const contents = [JSON.stringify({ title: "第一章" }), JSON.stringify({ title: "第二章" })];
  let call = 0, corrupt = false;
  const context = {
    async choose() { return target; }, check() {},
    async invoke(_action: string, input: Record<string, unknown>) {
      const index = call++ % 2;
      assert.equal(input.cursor, index ? "page-2" : undefined);
      return { status: "succeeded", data: { manifest: ["first", "second"], index, total: 2, media_type: "application/json", content: contents[index], content_sha256: corrupt && index === 1 ? "f".repeat(64) : createHash("sha256").update(contents[index]).digest("hex"), ...(index ? {} : { next_cursor: "page-2" }) } };
    },
  };
  const input = { action: "org.test.export", input: {}, suggested_name: "成果.json" };
  assert.equal((await exportPluginFile(input, context)).saved, true);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), [{ title: "第一章" }, { title: "第二章" }]);
  await writeFile(target, "已有作者文件");
  corrupt = true;
  await assert.rejects(() => exportPluginFile(input, context), /摘要不一致/);
  assert.equal(await readFile(target, "utf8"), "已有作者文件");
  assert.deepEqual(await readdir(directory), ["成果.json"]);
});
