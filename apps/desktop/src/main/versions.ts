import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { WorkRef } from "@hetu/plugin-sdk";
import { RecoveryStore } from "./recovery.ts";

type Call = (action: string, input: any) => Promise<any>;
type Decision = { work_ref: WorkRef; input: any; status: "pending" | "succeeded" | "blocked"; error?: string };
function data(result: any) {
  if (result.status !== "succeeded") throw Object.assign(new Error(result.error?.message ?? "文稿版本操作未完成。"), { code: result.error?.code });
  return result.data;
}

/** 固定快照批准是独立作者用例；不开放通用作者调用或Git执行。 */
export class VersionReview {
  #previews = new Map<string, { decision: Decision; view: any; diffs: any[] }>();
  #queue: Promise<any> = Promise.resolve();
  constructor(private work: WorkRef, private directory: string, private recovery: RecoveryStore, private core: Call, private active: () => boolean) {}
  #check() { if (!this.active()) throw new Error("作品已切换，请重新打开文稿版本。"); }
  #file() {
    return path.join(this.directory, createHash("sha256").update(JSON.stringify([this.work.workspace_id, this.work.kind, this.work.object_id])).digest("hex") + ".json");
  }
  async #call(action: string, input: any) {
    this.#check();
    const result = await this.core(action, { ...input, work_ref: this.work });
    this.#check();
    return data(result);
  }
  async journal(): Promise<Decision | null> {
    this.#check();
    const record = await this.recovery.read(this.#file()) as Decision | null;
    this.#check();
    if (record && (!isDeepStrictEqual(record.work_ref, this.work) || !isDeepStrictEqual(record.input?.work_ref, this.work) || !/^gitsnapshot_[0-9a-f-]{36}$/.test(record.input?.snapshot_id) || !/^[0-9a-f]{64}$/.test(record.input?.snapshot_sha256) || typeof record.input?.operation_key !== "string" || !["pending", "succeeded", "blocked"].includes(record.status))) throw new Error("版本批准恢复记录无效，请保留文件检查。");
    return record;
  }
  async read(method: string, input: any) {
    const actions: Record<string, string> = { status: "status", snapshots: "list_snapshots", snapshot: "get_snapshot", diff: "diff", snapshot_diff: "snapshot_diff", history: "log", version: "read_version" };
    if (!actions[method]) throw new Error("未知文稿版本用例。");
    return this.#call("hetu.git." + actions[method], { ...(method === "version" && input.path ? { max_bytes: 262144 } : {}), ...input });
  }
  async prepare(id: string, sha: string) {
    if ((await this.journal())?.status === "pending") throw new Error("请先核对原版本批准的结果。");
    const view = await this.read("snapshot", { snapshot_id: id });
    if (view.snapshot_sha256 !== sha || !view.is_current || view.approval_state === "executed") throw new Error("快照已变化或已执行，请刷新后审阅。");
    const diffs: any[] = [];
    let bytes = 0;
    for (const item of view.snapshot.selection) {
      let diff: any, beforeOffset = 0, afterOffset = 0;
      do {
        const page = await this.read("snapshot_diff", { snapshot_id: id, path: item.path, max_bytes: 262144, before_offset_bytes: beforeOffset, after_offset_bytes: afterOffset });
        if (page.binary || page.truncated || page.snapshot_sha256 !== sha) throw new Error("快照差异无法完整核对，请刷新后重新准备。");
        bytes += Buffer.byteLength(page.before ?? "") + Buffer.byteLength(page.after ?? "");
        if (bytes > 8 * 1024 * 1024) throw new Error("快照超过完整差异审阅预算，请让 Agent 缩小所选文稿。");
        if (!diff) diff = { ...page };
        else { diff.before = diff.before === null ? null : diff.before + (page.before ?? ""); diff.after = diff.after === null ? null : diff.after + (page.after ?? ""); }
        const nextBefore = page.before_next_offset_bytes, nextAfter = page.after_next_offset_bytes;
        if (nextBefore == null && nextAfter == null) break;
        if ((nextBefore != null && nextBefore <= beforeOffset) || (nextAfter != null && nextAfter <= afterOffset)) throw new Error("快照分页未前进，请保留固定版本检查。");
        beforeOffset = nextBefore ?? page.before_end_offset_bytes;
        afterOffset = nextAfter ?? page.after_end_offset_bytes;
      } while (true);
      diffs.push(diff);
    }
    const token = randomUUID(), decision: Decision = { work_ref: this.work, input: { work_ref: this.work, snapshot_id: id, snapshot_sha256: sha, operation_key: randomUUID() }, status: "pending" };
    if (this.#previews.size >= 10) this.#previews.delete(this.#previews.keys().next().value!);
    this.#previews.set(token, { decision, view, diffs });
    return { token, view, diffs };
  }
  prepared(token: string) {
    this.#check();
    const preview = this.#previews.get(token);
    if (!preview) throw new Error("版本批准预览已失效，请重新审阅。");
    return preview;
  }
  async #submit(record: Decision) {
    await this.recovery.write(this.#file(), record, 64 * 1024);
    this.#check();
    try {
      const result = await this.#call("hetu.git.approve_snapshot", record.input);
      await this.recovery.write(this.#file(), { ...record, status: "succeeded" }, 64 * 1024);
      return result;
    } catch (error) {
      const code = (error as any).code;
      if (code && !["result_unknown", "hetu.io_failure", "hetu.workspace_busy"].includes(code)) await this.recovery.write(this.#file(), { ...record, status: "blocked", error: (error as Error).message }, 64 * 1024);
      throw error;
    }
  }
  commit(token: string) {
    const preview = this.prepared(token);
    const operation = this.#queue.catch(() => {}).then(async () => {
      this.#check();
      if ((await this.journal())?.status === "pending") throw new Error("请先恢复原版本批准。");
      const current = await this.read("snapshot", { snapshot_id: preview.decision.input.snapshot_id });
      if (!current.is_current || current.snapshot_sha256 !== preview.decision.input.snapshot_sha256 || current.approval_state === "executed") throw new Error("版本依据已变化，请重新审阅。");
      this.#previews.delete(token);
      return this.#submit(preview.decision);
    });
    this.#queue = operation;
    return operation;
  }
  recover() {
    const operation = this.#queue.catch(() => {}).then(async () => {
      const record = await this.journal();
      if (!record) throw new Error("没有待恢复的版本批准。");
      if (record.status === "blocked") throw new Error(record.error ?? "版本依据冲突，请保留原记录。");
      return this.#submit(record);
    });
    this.#queue = operation;
    return operation;
  }
  async acknowledge(key: string) {
    const record = await this.journal();
    if (record?.status === "pending" || record?.input.operation_key !== key) throw new Error("批准结果尚未确认或恢复引用不符。");
    await this.recovery.write(this.#file(), null, 64 * 1024);
  }
}
