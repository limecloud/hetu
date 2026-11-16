import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import type { WorkRef } from "@hetu/plugin-sdk";
import { RecoveryStore } from "./recovery.ts";

type Call = (action: string, input: any) => Promise<any>;
type Decision = { work_ref: WorkRef; input: any; status: "pending" | "succeeded" | "blocked" };
const action = "hetu.covers.select";
function data(value: any) {
  if (value.status !== "succeeded") throw new Error(value.error?.message ?? "封面操作未完成。");
  return value.data;
}

/** 只处理当前小说的作者选用，renderer不能提交文件路径或自报批准。 */
export class CoverReview {
  #files = new Map<string, any>();
  #previews = new Map<string, Decision>();
  #queue: Promise<any> = Promise.resolve();
  #file: string;
  constructor(private work: WorkRef, directory: string, private recovery: RecoveryStore, private core: Call, private active: () => boolean) {
    this.#file = path.join(directory, createHash("sha256").update(JSON.stringify([work.workspace_id, work.kind, work.object_id])).digest("hex") + ".json");
  }
  #check() {
    if (this.work.kind !== "novel" || !this.active()) throw new Error("请重新打开对应小说的封面。");
  }
  async #call(name: string, input: any = {}) {
    this.#check(); const result = await this.core(name, input); this.#check(); return result;
  }
  async journal(): Promise<Decision | null> {
    this.#check();
    const record = await this.recovery.read(this.#file) as Decision | null;
    this.#check();
    if (record && (!isDeepStrictEqual(record.work_ref, this.work) || !["pending", "succeeded", "blocked"].includes(record.status) || typeof record.input?.operation_key !== "string"))
      throw new Error("封面恢复记录无效，请保留后检查。");
    return record;
  }
  async get(revision?: number) {
    const value = data(await this.#call("hetu.covers.get", revision ? { revision } : {}));
    return { cover: value.cover, expected_cover: value.expected_cover, preview: value.preview, journal: await this.journal() };
  }
  async requests(cursor?: string) {
    return data(await this.#call("hetu.covers.list_requests", { limit: 20, ...(cursor ? { cursor } : {}) }));
  }
  async candidates(request_id: string) {
    return data(await this.#call("hetu.covers.list_candidates", { request_id }));
  }
  async chooseFile(file: string) {
    const value = data(await this.#call("hetu.covers.inspect_file", { file_path: file }));
    const token = randomUUID();
    if (this.#files.size >= 8) this.#files.delete(this.#files.keys().next().value!);
    this.#files.set(token, { kind: "file", file_path: file, expected_file: { sha256: value.sha256, size_bytes: value.size_bytes } });
    return { token, filename: path.basename(file), preview: value.preview, width: value.width, height: value.height };
  }
  async prepare(input: any) {
    const current = await this.get();
    if (!isDeepStrictEqual(input.expected_cover, current.expected_cover)) throw new Error("封面已变化，请刷新后比较。");
    if (current.journal?.status === "pending") throw new Error("请先确认原封面操作。");
    let source: any, presentation: any;
    if (input.source?.kind === "file") {
      source = this.#files.get(input.source.token);
      if (!source) throw new Error("本地图片选择已失效，请重新选择。");
    } else if (input.source?.kind === "history") {
      const historic = await this.get(input.source.revision);
      if (!historic.cover || historic.cover.revision >= current.cover?.revision) throw new Error("请选择更早的封面修订。");
      source = { kind: "asset", asset_ref: historic.cover.asset_ref };
      presentation = historic.cover.presentation;
    } else if (input.source?.kind === "candidate") {
      const list = await this.candidates(input.source.reference?.request_id);
      if (!list.candidates.some((item: any) => isDeepStrictEqual(item.reference, input.source.reference))) throw new Error("封面候选已变化，请重新读取。");
      source = { kind: "candidate", reference: input.source.reference };
    } else if (input.source?.kind === "creative_task") {
      const ref = input.source.reference;
      const value = data(await this.#call("hetu.creative_tasks.get", { task_ref: ref?.task_ref, submission_id: ref?.submission_id }));
      if (value.request.task_kind !== "cover" || (value.request.work_ref && !isDeepStrictEqual(value.request.work_ref, this.work))
        || !value.submission?.candidates.some((item: any) => item.kind === "image" && item.candidate_id === ref.candidate_id))
        throw new Error("此候选不属于当前小说的封面任务。");
      source = { kind: "creative_task", reference: ref };
    } else throw new Error("封面来源无效。");
    if (!presentation) {
      const novel = data(await this.#call("hetu.novels.get")).novel;
      presentation = { crop_rect: { x: 0, y: 0, width: 1, height: 1 }, title_overlay: input.overlay === true ? novel.metadata.title : "", author_overlay: input.overlay === true ? novel.metadata.author_name : "" };
    }
    const token = randomUUID();
    if (this.#previews.size >= 8) this.#previews.delete(this.#previews.keys().next().value!);
    this.#previews.set(token, { work_ref: this.work, input: { source, expected_cover: current.expected_cover, presentation, operation_key: randomUUID() }, status: "pending" });
    return { token, presentation };
  }
  async #write(record: Decision) {
    const pending = this.#queue.catch(() => {}).then(async () => {
      this.#check();
      const previous = await this.journal();
      if (previous?.status === "pending" && !isDeepStrictEqual(previous.input, record.input)) throw new Error("原封面操作尚未确认。");
      await this.recovery.write(this.#file, record, 1024 * 1024);
      const result = await this.#call(action, record.input);
      record.status = result.status === "succeeded" ? "succeeded" : result.status === "blocked" && result.error?.code !== "workspace_busy" ? "blocked" : "pending";
      await this.recovery.write(this.#file, record, 1024 * 1024);
      return data(result);
    });
    this.#queue = pending;
    return pending;
  }
  commit(token: string) {
    this.#check();
    const prepared = this.#previews.get(token);
    if (!prepared) throw new Error("封面预览已失效，请重新选择。");
    return this.#write(structuredClone(prepared));
  }
  async recover() {
    const record = await this.journal();
    if (!record) throw new Error("没有待恢复的封面操作。");
    const result = await this.#call("hetu.operations.get", { action, key: record.input.operation_key });
    if (result.status === "succeeded") {
      const original = result.data.original_result;
      if (original?.status === "succeeded") {
        record.status = "succeeded";
        await this.recovery.write(this.#file, record, 1024 * 1024);
      }
      return data(original);
    }
    if (result.error?.code !== "not_found") return data(result);
    return this.#write(record);
  }
  async acknowledge() {
    if ((await this.journal())?.status !== "pending") await this.recovery.write(this.#file, null, 1024 * 1024);
  }
}
