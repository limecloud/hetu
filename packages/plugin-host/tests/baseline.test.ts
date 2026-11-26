import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { baseline, verifyBaselineSurfaces } from "../../plugin-sdk/src/baseline.ts";
import { VideoReview } from "../../../apps/desktop/src/main/video-review.ts";
import { OutlineReview } from "../../../apps/desktop/src/main/outlines.ts";
import { RecoveryStore } from "../../../apps/desktop/src/main/recovery.ts";

const work = { workspace_id: "workspace_11111111-1111-4111-8111-111111111111", kind: "video" as const, object_id: "video_11111111-1111-4111-8111-111111111111" };
const media = { media_id: "vmedia_11111111-1111-4111-8111-111111111111", revision: 1, sha256: "a".repeat(64) };
const success = (data: any) => ({ status: "succeeded", data });

test("基础贡献缺失或作品类型错误必须拒绝，清单无需用户插件", () => {
  assert.equal(baseline.requires_optional_plugins, false);
  const rows = new Map<string, { id: string; kinds: string[] }>();
  for (const module of baseline.modules) for (const surface of module.surfaces) {
    const row = rows.get(surface.id) ?? { id: surface.id, kinds: [] }; row.kinds.push(module.work_kind); rows.set(surface.id, row);
  }
  assert.doesNotThrow(() => verifyBaselineSurfaces([...rows.values()]));
  rows.delete("video.review"); assert.throws(() => verifyBaselineSurfaces([...rows.values()]), /video.review/);
  rows.set("video.review", { id: "video.review", kinds: ["novel"] }); assert.throws(() => verifyBaselineSurfaces([...rows.values()]), /video.review/);
});

test("视频意见丢回执保留原输入和原键，重开恢复只有一个副作用", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-feedback-"));
  const saved = new Map<string, any>(); let lose = true, mutations = 0;
  const core = async (action: string, input: any) => {
    if (action === "hetu.video.media.get") return success({ media: {} });
    assert.equal(action, "hetu.video.feedback.save");
    if (!saved.has(input.operation_key)) { saved.set(input.operation_key, { feedback: input }); mutations++; }
    if (lose) { lose = false; throw new Error("回执丢失"); }
    return success(saved.get(input.operation_key));
  };
  const store = new RecoveryStore();
  const first = new VideoReview(work, dir, store, core, () => true);
  await assert.rejects(() => first.saveFeedback({ media_ref: media, comment: "保留结尾" }), /回执丢失/);
  const before = await first.journal(); assert.equal(before.status, "pending");
  await assert.rejects(() => first.saveFeedback({ media_ref: media, comment: "新操作" }), /尚待恢复/);
  const reopened = new VideoReview(work, dir, store, core, () => true);
  const after = await reopened.recover();
  assert.equal(after.input.operation_key, before.input.operation_key); assert.equal(after.status, "succeeded"); assert.equal(mutations, 1);
});

test("确定的区间校验失败可修正，作品切换后不能继续保存", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-feedback-bounds-"));
  let active = true, valid = false;
  const instance = new VideoReview(work, dir, new RecoveryStore(), async action => action.endsWith(".get") ? success({}) : valid ? success({ feedback: {} }) : ({ status: "blocked", error: { code: "invalid_range", message: "区间越界" } }), () => active);
  await assert.rejects(() => instance.saveFeedback({ media_ref: media, comment: "意见", range: { start_tick: 1, end_tick: 2 } }), /区间越界/);
  assert.equal((await instance.journal()).status, "blocked");
  valid = true; await instance.saveFeedback({ media_ref: media, comment: "修正意见" });
  active = false; await assert.rejects(() => instance.read("media", { media_ref: media }), /作品已切换/);
});

test("视频导出核对完整摘要，坏块保留作者目标文件并清理本次临时文件", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-export-")), target = path.join(dir, "视频.mp4");
  await writeFile(target, "作者原文件");
  const bytes = Buffer.alloc(1048587, 37), sha = createHash("sha256").update(bytes).digest("hex"), asset = { asset_id: "asset_fixed", revision: 1, sha256: "b".repeat(64) };
  let corrupt = true, opens = 0, closes = 0, reads = 0;
  const instance = new VideoReview(work, dir, new RecoveryStore(), async action => {
    assert.equal(action, "hetu.video.delivery.preview");
    return success({ manifest_sha256: "fixed", items: [{ media_ref: media, filename: "视频.mp4", asset_ref: asset, blob: { size_bytes: bytes.length, sha256: sha, media_type: "video/mp4" } }] });
  }, () => true, async (method, input) => {
    if (method === "media/open") { opens++; assert.deepEqual(input, { ...asset, work_ref: work }); return { token: "fixed-reader", asset_ref: { ...asset, work_ref: work }, size_bytes: bytes.length, media_type: "video/mp4" }; }
    assert.equal(input.token, "fixed-reader");
    if (method === "media/close") { closes++; return null; }
    assert.equal(method, "media/read"); reads++;
    const chunk = bytes.subarray(input.offset, input.offset + input.length);
    return { offset: input.offset, size_bytes: chunk.length, base64: (corrupt ? Buffer.alloc(chunk.length) : chunk).toString("base64") };
  });
  await assert.rejects(() => instance.exportFile(media, async () => target), /完整摘要不一致/);
  assert.equal(await readFile(target, "utf8"), "作者原文件"); assert.deepEqual(await readdir(dir), ["视频.mp4"]);
  corrupt = false; assert.equal((await instance.exportFile(media, async () => target)).saved, true); assert.deepEqual(await readFile(target), bytes);
  assert.equal(opens, 2); assert.equal(closes, 2); assert.equal(reads, 6);
});

test("正式大纲CAS冲突保留编辑稿，校验失败不堵塞修正后的保存", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-outline-")); let conflict = true;
  const instance = new OutlineReview({ ...work, kind: "novel" }, dir, new RecoveryStore(), async action => action === "hetu.outlines.save" ? conflict ? { status: "blocked", error: { code: "revision_conflict", message: "大纲已有更新" } } : success({ revision: 2 }) : success({}), () => true);
  const draft = { expected: { revision: 0, sha256: null }, items: [{ text: "保留作者输入" }] };
  await instance.draft(draft); await assert.rejects(() => instance.save(draft), /已有更新/);
  assert.deepEqual(await instance.draft(), draft); assert.equal((await instance.journal()).status, "blocked");
  conflict = false; await instance.save({ ...draft, expected: { revision: 1, sha256: "c".repeat(64) } }); assert.equal(await instance.draft(), null);
});

test("未知回执恢复为明确拒绝后，可保留草稿并修正原输入", async () => {
  for (const kind of ["video", "novel"] as const) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-recovery-rejection-"));
    let outcome = "unknown";
    const core = async (action: string) => {
      if (!action.endsWith(".save")) return success({});
      if (outcome === "unknown") throw new Error("连接中断");
      return outcome === "blocked" ? { status: "blocked", error: { code: "revision_conflict", message: "固定依据已有变化" } } : success({});
    };
    const store = new RecoveryStore();
    const instance = kind === "video" ? new VideoReview(work, dir, store, core, () => true) : new OutlineReview({ ...work, kind }, dir, store, core, () => true);
    const input = kind === "video" ? { media_ref: media, comment: "保留意见" } : { expected: { revision: 0, sha256: null }, items: [] };
    const save = () => instance instanceof VideoReview ? instance.saveFeedback(input) : instance.save(input);
    await assert.rejects(save, /连接中断/);
    const before = await instance.journal(); assert.equal(before.status, "pending");
    outcome = "blocked";
    await assert.rejects(() => instance.recover(), /依据已有变化/);
    const after = await instance.journal();
    assert.equal(after.status, "blocked"); assert.equal(after.input.operation_key, before.input.operation_key);
    outcome = "succeeded"; await save(); assert.equal((await instance.journal()).status, "succeeded");
  }
});
