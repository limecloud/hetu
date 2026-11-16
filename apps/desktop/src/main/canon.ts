import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { WorkRef } from "@hetu/plugin-sdk";
import { RecoveryStore } from "./recovery.ts";

type Pending = { work_ref: WorkRef; action: string; input: any; status: "pending" | "succeeded" | "blocked" };
const actions = ["hetu.blueprints.save", "hetu.blueprints.lock", "hetu.blueprints.unlock"];
function data(value: any) {
  if (value?.status !== "succeeded") throw new Error(value?.error?.message ?? "设定操作未完成。");
  return value.data;
}

/** 作者通道绑定当前作品，所有引用和变更仍由Core核验。 */
export class CanonReview {
  #file: string;
  #queue: Promise<any> = Promise.resolve();
  constructor(private work: WorkRef, directory: string, private recovery: RecoveryStore, private core: (action: string, input: any) => Promise<any>, private active: () => boolean) {
    this.#file = path.join(directory, createHash("sha256").update(JSON.stringify(work)).digest("hex") + ".json");
  }
  #check() { if (!this.active()) throw new Error("作品上下文已变化，请重新打开设定。"); }
  async #call(action: string, input: any = {}) {
    this.#check(); const result = await this.core(action, { ...input, work_ref: this.work }); this.#check(); return result;
  }
  async journal(): Promise<Pending | null> {
    this.#check(); const value = await this.recovery.read(this.#file) as Pending | null; this.#check();
    if (value && (!isDeepStrictEqual(value.work_ref, this.work) || !actions.includes(value.action) || typeof value.input?.operation_key !== "string" || !["pending", "succeeded", "blocked"].includes(value.status))) throw new Error("设定恢复记录无效，请保留检查。");
    return value;
  }
  async get(revision?: number) { return { ...data(await this.#call("hetu.blueprints.get", revision === undefined ? {} : { revision })), journal: await this.journal() }; }
  async preview(input: any) { return data(await this.#call("hetu.blueprints.preview_change", { expected: input.expected, typed_changes: input.typed_changes })); }
  async #write(record: Pending) {
    const next = this.#queue.catch(() => {}).then(async () => {
      this.#check(); const previous = await this.journal();
      if (previous?.status === "pending" && !isDeepStrictEqual(previous, record)) throw new Error("请先确认原设定操作。");
      await this.recovery.write(this.#file, record, 4 * 1024 * 1024);
      const result = await this.#call(record.action, record.input);
      record.status = result.status === "succeeded" ? "succeeded" : result.status === "blocked" && result.error?.code !== "workspace_busy" ? "blocked" : "pending";
      await this.recovery.write(this.#file, record, 4 * 1024 * 1024);
      return data(result);
    });
    this.#queue = next; return next;
  }
  save(input: any) { return this.#write({ work_ref: this.work, action: actions[0], status: "pending", input: { expected: input.expected, typed_changes: input.typed_changes, operation_key: randomUUID() } }); }
  lock(input: any) {
    if (typeof input.locked !== "boolean" || typeof input.reason !== "string" || !input.reason.trim()) throw new Error("请填写锁定或解锁原因。");
    return this.#write({ work_ref: this.work, action: input.locked ? actions[1] : actions[2], status: "pending", input: { expected: input.expected, reason: input.reason, operation_key: randomUUID() } });
  }
  async recover() {
    const record = await this.journal(); if (!record) throw new Error("没有待恢复的设定操作。");
    // 操作回读按原键，不允许作品输入改变原操作归属。
    this.#check(); const result = await this.core("hetu.operations.get", { action: record.action, key: record.input.operation_key }); this.#check();
    if (result.status === "succeeded") {
      const original = result.data.original_result;
      if (original?.status === "succeeded") { record.status = "succeeded"; await this.recovery.write(this.#file, record, 4 * 1024 * 1024); }
      return data(original);
    }
    if (result.error?.code !== "not_found") return data(result);
    return this.#write(record);
  }
  async acknowledge() { if ((await this.journal())?.status !== "pending") await this.recovery.write(this.#file, null, 4 * 1024 * 1024); }
}
