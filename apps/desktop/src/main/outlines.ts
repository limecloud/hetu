import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { WorkRef } from "@hetu/plugin-sdk";
import type { RecoveryStore } from "./recovery.ts";

/** 正式大纲的基础编辑与原键恢复，专业规划继续由插件提供。 */
export class OutlineReview {
  #file: string;
  #queue: Promise<unknown> = Promise.resolve();
  private work: WorkRef;
  private recovery: RecoveryStore;
  private core: (action: string, input: any) => Promise<any>;
  private active: () => boolean;
  constructor(work: WorkRef, directory: string, recovery: RecoveryStore, core: (action: string, input: any) => Promise<any>, active: () => boolean) {
    this.work = work; this.recovery = recovery; this.core = core; this.active = active;
    this.#file = path.join(directory, createHash("sha256").update(JSON.stringify(work)).digest("hex") + ".json");
  }
  #check() { if (this.work.kind !== "novel" || !this.active()) throw new Error("小说作品已切换，请重新打开大纲。"); }
  async #call(action: string, input: any) {
    this.#check(); const value = await this.core(action, input); this.#check();
    if (value.status !== "succeeded") {
      const error = new Error(value.error?.message ?? "大纲操作结果未知，请恢复原操作。");
      Object.assign(error, { definitive: ["failed", "blocked"].includes(value.status) && value.error?.code !== "result_unknown" });
      throw error;
    }
    return value.data;
  }
  async journal() {
    this.#check(); const value: any = await this.recovery.read(this.#file); this.#check();
    if (value && (!isDeepStrictEqual(value.work_ref, this.work) || value.action !== "hetu.outlines.save")) throw new Error("大纲恢复记录归属不一致。");
    return value;
  }
  async get() {
    return { outline: await this.#call("hetu.outlines.get", {}), novel: await this.#call("hetu.novels.get", {}), journal: await this.journal(), draft: await this.draft() };
  }
  async draft(value?: any) {
    this.#check();
    if (value !== undefined) await this.recovery.write(this.#file + ".draft", value, 4 * 1024 * 1024);
    this.#check(); return this.recovery.read(this.#file + ".draft");
  }
  save(input: any) {
    const run = this.#queue.then(async () => {
      if ((await this.journal())?.status === "pending") throw new Error("前次大纲保存尚待恢复。");
      if (!input || Object.keys(input).some(key => !["expected", "items"].includes(key))) throw new Error("大纲输入无效。");
      const journal = { work_ref: this.work, action: "hetu.outlines.save", input: { expected: input.expected, items: input.items, operation_key: "outline-" + randomUUID() }, status: "pending", result: null as any };
      await this.recovery.write(this.#file, journal, 4 * 1024 * 1024);
      try { journal.result = await this.#call(journal.action, journal.input); }
      catch (error) {
        if ((error as any).definitive) { journal.status = "blocked"; await this.recovery.write(this.#file, journal, 4 * 1024 * 1024); }
        throw error;
      }
      journal.status = "succeeded";
      await this.recovery.write(this.#file, journal, 4 * 1024 * 1024); await this.draft(null); return journal.result;
    }); this.#queue = run.catch(() => {}); return run;
  }
  recover() {
    const run = this.#queue.then(async () => {
      const journal = await this.journal(); if (!journal || journal.status !== "pending") return journal;
      try { journal.result = await this.#call(journal.action, journal.input); }
      catch (error) {
        if ((error as any).definitive) { journal.status = "blocked"; await this.recovery.write(this.#file, journal, 4 * 1024 * 1024); }
        throw error;
      }
      journal.status = "succeeded";
      await this.recovery.write(this.#file, journal, 4 * 1024 * 1024); await this.draft(null); return journal;
    }); this.#queue = run.catch(() => {}); return run;
  }
}
