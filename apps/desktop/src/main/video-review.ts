import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { open, rename, rm } from "node:fs/promises";
import type { WorkRef } from "@hetu/plugin-sdk";
import type { RecoveryStore } from "./recovery.ts";

type Call = (action: string, input: any) => Promise<any>;

/** 可信基础工作面的窄通道；每次重新核对作品，不向插件暴露作者句柄。 */
export class VideoReview {
  #queue: Promise<unknown> = Promise.resolve();
  #file: string;
  private work: WorkRef;
  private recovery: RecoveryStore;
  private core: Call;
  private active: () => boolean;
  private stream: Call | undefined;
  constructor(work: WorkRef, directory: string, recovery: RecoveryStore, core: Call, active: () => boolean, stream?: Call) {
    this.work = work; this.recovery = recovery; this.core = core; this.active = active;
    this.stream = stream;
    this.#file = path.join(directory, createHash("sha256").update(JSON.stringify([work.workspace_id, work.kind, work.object_id])).digest("hex") + ".json");
  }
  #check() { if (!this.active() || this.work.kind !== "video") throw new Error("视频作品已切换，请重新打开。"); }
  async #call(action: string, input: any) {
    this.#check();
    const result = await this.core(action, { ...input, work_ref: this.work });
    this.#check();
    if (result.status !== "succeeded") {
      const error = new Error(result.error?.message ?? "视频操作未完成，请沿原操作恢复。");
      Object.assign(error, { definitive: ["failed", "blocked", "cancelled"].includes(result.status) && !["result_unknown", "cancelled"].includes(result.error?.code) });
      throw error;
    }
    return result.data;
  }
  async read(method: string, input: any) {
    const action = ({ media: "hetu.video.media.get", list: "hetu.video.media.list", feedback: "hetu.video.feedback.list", delivery: "hetu.video.delivery.preview" } as Record<string, string>)[method];
    if (!action) throw new Error("未知视频读取用例。");
    return this.#call(action, input);
  }
  async journal() {
    this.#check();
    const journal: any = await this.recovery.read(this.#file);
    if (journal && (!isDeepStrictEqual(journal.work_ref, this.work) || journal.action !== "hetu.video.feedback.save"))
      throw new Error("视频恢复记录归属不一致，请保留记录检查。");
    this.#check();
    return journal;
  }
  saveFeedback(input: any) {
    const run = this.#queue.then(async () => {
      const prior = await this.journal();
      if (prior?.status === "pending") throw new Error("前次意见尚待恢复，请先查询原操作。");
      if (Object.keys(input).some(key => !["media_ref", "comment", "range"].includes(key))) throw new Error("视频意见含有不支持的字段。");
      await this.#call("hetu.video.media.get", { media_ref: input.media_ref });
      const journal = { work_ref: this.work, action: "hetu.video.feedback.save", input: { ...input, work_ref: this.work, operation_key: "video-feedback-" + randomUUID() }, status: "pending", result: null as any };
      await this.recovery.write(this.#file, journal, 65536);
      try { journal.result = await this.#call(journal.action, journal.input); }
      catch (error) {
        if ((error as any).definitive) { journal.status = "blocked"; await this.recovery.write(this.#file, journal, 65536); }
        throw error;
      }
      journal.status = "succeeded";
      await this.recovery.write(this.#file, journal, 65536);
      return journal.result;
    });
    this.#queue = run.catch(() => {});
    return run;
  }
  recover() {
    const run = this.#queue.then(async () => {
      const journal = await this.journal();
      if (!journal || journal.status !== "pending") return journal;
      // 相同固定输入和原键交给Core查询或重放，不重新生成反馈身份。
      try { journal.result = await this.#call(journal.action, journal.input); }
      catch (error) {
        if ((error as any).definitive) { journal.status = "blocked"; await this.recovery.write(this.#file, journal, 65536); }
        throw error;
      }
      journal.status = "succeeded";
      await this.recovery.write(this.#file, journal, 65536);
      return journal;
    });
    this.#queue = run.catch(() => {});
    return run;
  }
  async draft(mediaRef: any, value?: any) {
    await this.#call("hetu.video.media.get", { media_ref: mediaRef });
    const file = this.#file + "." + createHash("sha256").update(JSON.stringify([mediaRef.media_id, mediaRef.revision, mediaRef.sha256])).digest("hex") + ".draft";
    if (value !== undefined) {
      if (value !== null && (typeof value.comment !== "string" || Object.keys(value).some(key => !["comment", "start", "end", "ranged"].includes(key)))) throw new Error("视频意见恢复稿无效。");
      await this.recovery.write(file, value, 65536);
    }
    this.#check();
    return this.recovery.read(file);
  }
  async exportFile(mediaRef: any, choose: (name: string) => Promise<string | undefined>) {
    if (!this.stream) throw new Error("视频文件通道尚未连接。");
    const stream = this.stream;
    const preview = await this.#call("hetu.video.delivery.preview", { media_refs: [mediaRef] });
    const item = preview.items[0];
    const target = await choose(path.basename(item.filename));
    if (!target) return { saved: false, cancelled: true };
    this.#check();
    const temp = path.join(path.dirname(target), ".hetu-video-" + randomUUID() + ".tmp");
    const file = await open(temp, "wx", 0o600);
    const hash = createHash("sha256");
    let offset = 0, complete = false, source: any;
    try {
      // 复用Core已经核验完整摘要的同一只读句柄，不为每个分块重新扫描整个视频。
      source = await stream("media/open", { ...item.asset_ref, work_ref: this.work });
      this.#check();
      if (!isDeepStrictEqual(source.asset_ref, { ...item.asset_ref, work_ref: this.work }) || source.size_bytes !== item.blob.size_bytes || source.media_type !== item.blob.media_type) throw new Error("视频文件与固定交付清单不一致。");
      while (offset < item.blob.size_bytes) {
        this.#check();
        const length = Math.min(524288, item.blob.size_bytes - offset);
        const chunk = await stream("media/read", { token: source.token, offset, length });
        this.#check();
        const bytes = Buffer.from(chunk.base64, "base64");
        if (chunk.offset !== offset || chunk.size_bytes !== length || bytes.length !== length) throw new Error("视频交付分块与固定清单不一致。");
        offset += bytes.length;
        hash.update(bytes);
        await file.writeFile(bytes);
      }
      if (hash.digest("hex") !== item.blob.sha256) throw new Error("视频交付完整摘要不一致。");
      const latest = await this.#call("hetu.video.delivery.preview", { media_refs: [mediaRef] });
      if (latest.manifest_sha256 !== preview.manifest_sha256) throw new Error("视频交付依据已有变化，请重新核对。");
      await file.sync(); await file.close(); this.#check(); await rename(temp, target); complete = true;
      return { saved: true, bytes: offset, manifest: preview };
    } finally {
      if (source?.token) await stream("media/close", { token: source.token }).catch(() => {});
      if (!complete) { await file.close().catch(() => {}); await rm(temp, { force: true }); }
    }
  }
}
