import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { WorkRef } from "@hetu/plugin-sdk";
import { RecoveryStore } from "./recovery.ts";

type Pending = { work_ref: WorkRef; action: "hetu.novels.update" | "hetu.novels.save_structure"; input: any; status: "pending" | "succeeded" | "blocked" };
function data(result: any) {
  if (result?.status !== "succeeded") throw new Error(result?.error?.message ?? "作品保存未完成。");
  return result.data;
}
export class NovelDetails {
  #file: string;
  #queue: Promise<any> = Promise.resolve();
  constructor(private work: WorkRef, directory: string, private recovery: RecoveryStore, private core: (action: string, input: any) => Promise<any>, private active: () => boolean) {
    this.#file = path.join(directory, createHash("sha256").update(JSON.stringify([work.workspace_id, work.object_id])).digest("hex") + ".json");
  }
  #check() { if (this.work.kind !== "novel" || !this.active()) throw new Error("小说上下文已变化，请重新打开。"); }
  async #call(action: string, input: any = {}) { this.#check(); const result = await this.core(action, input); this.#check(); return result; }
  async journal(): Promise<Pending | null> {
    this.#check(); const record = await this.recovery.read(this.#file) as Pending | null; this.#check();
    if (record && (!isDeepStrictEqual(record.work_ref, this.work) || !["hetu.novels.update", "hetu.novels.save_structure"].includes(record.action) || typeof record.input?.operation_key !== "string" || !["pending", "succeeded", "blocked"].includes(record.status))) throw new Error("小说恢复记录无效，请保留检查。");
    return record;
  }
  async get() { return { ...data(await this.#call("hetu.novels.get")), journal: await this.journal() }; }
  async #write(record: Pending) {
    const pending = this.#queue.catch(() => {}).then(async () => {
      this.#check();
      const previous = await this.journal();
      if (previous?.status === "pending" && !isDeepStrictEqual(previous, record)) throw new Error("请先确认原小说保存操作。");
      await this.recovery.write(this.#file, record, 1024 * 1024);
      const result = await this.#call(record.action, record.input);
      record.status = result.status === "succeeded" ? "succeeded" : result.status === "blocked" && result.error?.code !== "workspace_busy" ? "blocked" : "pending";
      await this.recovery.write(this.#file, record, 1024 * 1024);
      return data(result);
    });
    this.#queue = pending; return pending;
  }
  save(input: any) {
    if (!["metadata", "structure"].includes(input.kind)) throw new Error("小说编辑类型无效。");
    return this.#write({ work_ref: this.work, action: input.kind === "metadata" ? "hetu.novels.update" : "hetu.novels.save_structure", status: "pending", input: {
      expected: input.expected, operation_key: randomUUID(), ...(input.kind === "metadata" ? { metadata: input.metadata } : { volumes: input.volumes, chapters: input.chapters }),
    } });
  }
  async recover() {
    const record = await this.journal(); if (!record) throw new Error("没有需要恢复的小说操作。");
    const result = await this.#call("hetu.operations.get", { action: record.action, key: record.input.operation_key });
    if (result.status === "succeeded") {
      const original = result.data.original_result;
      if (original?.status === "succeeded") { record.status = "succeeded"; await this.recovery.write(this.#file, record, 1024 * 1024); }
      return data(original);
    }
    if (result.error?.code !== "not_found") return data(result);
    return this.#write(record);
  }
  async acknowledge() { if ((await this.journal())?.status !== "pending") await this.recovery.write(this.#file, null, 1024 * 1024); }
}
