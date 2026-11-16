import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { WorkRef } from "@hetu/plugin-sdk";
import { RecoveryStore } from "./recovery.ts";

type Call = (action: string, input: any) => Promise<any>;
type Decision = {
  work_ref: WorkRef;
  resource_id: string;
  title: string;
  action: string;
  input: any;
  status: "pending" | "succeeded" | "blocked";
};
const actions = new Set([
  "hetu.resources.adopt",
  "hetu.resources.archive",
  "hetu.resources.update",
]);
function data(result: any) {
  if (result.status !== "succeeded")
    throw new Error(result.error?.message ?? "资料操作未完成。");
  return result.data;
}

/** 资料的作者决定只消费固定作品和修订；第三方容器不能调用。 */
export class ResourceReview {
  #previews = new Map<
    string,
    { decision: Decision; before: any; after: any }
  >();
  #queue: Promise<any> = Promise.resolve();
  constructor(
    private work: WorkRef,
    private directory: string,
    private recovery: RecoveryStore,
    private core: Call,
    private active: () => boolean,
  ) {
    this.directory = path.join(
      directory,
      createHash("sha256")
        .update(JSON.stringify([work.workspace_id, work.kind, work.object_id]))
        .digest("hex"),
    );
  }
  #check() {
    if (!this.active()) throw new Error("作品已变化，请重新打开资料。");
  }
  async #call(action: string, input: any) {
    this.#check();
    const result = await this.core(action, input);
    this.#check();
    return result;
  }
  async list(input: any) {
    const { category, state, tag, cursor } = input;
    const result = await this.#call("hetu.resources.list", {
      work_ref: this.work,
      limit: 50,
      ...(category ? { category } : {}),
      ...(state ? { state } : {}),
      ...(tag ? { tag } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (result.status === "succeeded")
      result.data.recoveries = await this.#recoveries();
    return result;
  }
  async #recoveries() {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (files.length > 10000)
      throw new Error("资料恢复目录超过单次读取预算，请保留记录检查。");
    const entries: { resource_id: string; title: string; status: string }[] =
      [];
    for (const file of files
      .filter((file) => /^[0-9a-f]{64}\.json$/.test(file))
      .sort()) {
      this.#check();
      const record = (await this.recovery.read(
        path.join(this.directory, file),
      )) as Decision | null;
      if (!record || !isDeepStrictEqual(record.work_ref, this.work)) continue;
      const validated = await this.journal(record.resource_id);
      if (validated && path.basename(this.#file(record.resource_id)) === file)
        entries.push({
          resource_id: record.resource_id,
          title: record.title,
          status: record.status,
        });
    }
    this.#check();
    return entries;
  }
  async #owned(id: string, revision?: number) {
    const view = data(
      await this.#call("hetu.resources.get", {
        resource_id: id,
        ...(revision ? { revision } : {}),
      }),
    );
    if (!isDeepStrictEqual(view.resource.work_ref, this.work))
      throw new Error("资料不属于当前作品。");
    return view;
  }
  async get(id: string, revision?: number) {
    return {
      ...(await this.#owned(id, revision)),
      journal: await this.journal(id),
      buffer: await this.draft(id),
    };
  }
  async draft(id: string, value?: any) {
    await this.#owned(id);
    const file = this.#file(id) + ".draft";
    if (value !== undefined) {
      if (value !== null) {
        const fixed = await this.#owned(id, value.base?.revision);
        if (
          fixed.sha256 !== value.base?.sha256 ||
          !value.edits ||
          Object.keys(value.edits).some(
            (key) => !["title", "body", "source_notes"].includes(key),
          ) ||
          Object.values(value.edits).some((text) => typeof text !== "string")
        )
          throw new Error("资料恢复稿的固定版本或字段无效。");
      }
      await this.recovery.write(
        file,
        value === null
          ? null
          : { ...value, work_ref: this.work, resource_id: id },
        8 * 1024 * 1024,
      );
      this.#check();
    }
    const buffer = (await this.recovery.read(file)) as any;
    if (
      buffer &&
      (!isDeepStrictEqual(buffer.work_ref, this.work) ||
        buffer.resource_id !== id)
    )
      throw new Error("资料恢复稿归属无效，请保留记录检查。");
    return buffer;
  }
  async usages(id: string, cursor?: string) {
    await this.#owned(id);
    return this.#call("hetu.resource_usages.list", {
      resource_id: id,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
  }
  #file(id: string) {
    if (!/^resource_[0-9a-f-]{36}$/.test(id)) throw new Error("资料引用无效。");
    return path.join(
      this.directory,
      createHash("sha256")
        .update(
          JSON.stringify([
            this.work.workspace_id,
            this.work.kind,
            this.work.object_id,
            id,
          ]),
        )
        .digest("hex") + ".json",
    );
  }
  async journal(id: string) {
    this.#check();
    const record = (await this.recovery.read(
      this.#file(id),
    )) as Decision | null;
    this.#check();
    if (
      record &&
      (!isDeepStrictEqual(record.work_ref, this.work) ||
        record.resource_id !== id ||
        !actions.has(record.action) ||
        record.input?.resource_id !== id ||
        typeof record.input?.operation_key !== "string" ||
        !record.input?.expected ||
        !["pending", "succeeded", "blocked"].includes(record.status))
    )
      throw new Error("资料恢复记录无效，请保留记录检查。");
    return record;
  }
  async prepare(
    id: string,
    revision: number,
    sha256: string,
    kind: string,
    edits?: any,
  ) {
    const action = `hetu.resources.${kind}`;
    if (!actions.has(action)) throw new Error("资料决定不可用。");
    const view = await this.#owned(id, revision);
    if (view.sha256 !== sha256 || !view.is_head)
      throw new Error("资料已有更新，请重新比较。");
    const prior = await this.journal(id);
    if (prior) throw new Error("请先核对并确认原资料操作的回读结果。");
    const before = view.resource;
    let after: any = {
      ...before,
      state: kind === "adopt" ? "adopted" : "archived",
    };
    let fields = {};
    if (kind === "update") {
      if (
        !edits ||
        Object.keys(edits).some(
          (key) =>
            !["title", "body", "category", "tags", "source_notes"].includes(
              key,
            ),
        )
      )
        throw new Error("资料编辑字段无效。");
      after = { ...before, ...edits };
      fields = Object.fromEntries(
        [
          "title",
          "body",
          "category",
          "tags",
          "source_notes",
          "project_id",
          "entity_refs",
        ].map((key) => [key, after[key]]),
      );
    }
    const title =
      (kind === "adopt" ? "采用" : kind === "archive" ? "归档" : "保存修改") +
      "「" +
      before.title +
      "」";
    const decision: Decision = {
      work_ref: this.work,
      resource_id: id,
      action,
      title,
      status: "pending",
      input: {
        ...fields,
        resource_id: id,
        expected: { revision, sha256 },
        operation_key: randomUUID(),
      },
    };
    const token = randomUUID();
    if (this.#previews.size >= 20)
      this.#previews.delete(this.#previews.keys().next().value!);
    this.#previews.set(token, { decision, before, after });
    return { token, title, action, before, after };
  }
  prepared(token: string) {
    this.#check();
    const value = this.#previews.get(token);
    if (!value) throw new Error("资料预览已失效，请重新审阅。");
    return value;
  }
  async #write(record: Decision) {
    const pending = this.#queue
      .catch(() => {})
      .then(async () => {
        await this.#owned(record.resource_id);
        const prior = await this.journal(record.resource_id);
        if (prior && !isDeepStrictEqual(prior.input, record.input))
          throw new Error("请先恢复并确认原资料操作。");
        await this.recovery.write(
          this.#file(record.resource_id),
          record,
          8 * 1024 * 1024,
        );
        this.#check();
        const result = await this.#call(record.action, record.input);
        record.status =
          result.status === "succeeded"
            ? "succeeded"
            : result.status === "blocked" &&
                result.error?.code !== "workspace_busy"
              ? "blocked"
              : "pending";
        await this.recovery.write(
          this.#file(record.resource_id),
          record,
          8 * 1024 * 1024,
        );
        return result;
      });
    this.#queue = pending;
    return pending;
  }
  async commit(token: string) {
    const prepared = this.prepared(token);
    return this.#write(prepared.decision);
  }
  async recover(id: string) {
    const record = await this.journal(id);
    if (!record) throw new Error("没有待恢复的资料操作。");
    await this.#owned(id);
    const result = await this.#call("hetu.operations.get", {
      action: record.action,
      key: record.input.operation_key,
    });
    if (result.status === "succeeded") {
      const original = result.data.original_result;
      if (original?.status === "succeeded") {
        record.status = "succeeded";
        await this.recovery.write(this.#file(id), record, 8 * 1024 * 1024);
      }
      return original;
    }
    if (result.error?.code !== "not_found") return result;
    return this.#write(record);
  }
  async acknowledge(id: string, key: string) {
    await this.#owned(id);
    const record = await this.journal(id);
    if (
      record &&
      record.status !== "pending" &&
      record.input.operation_key === key
    )
      await this.recovery.write(this.#file(id), null, 8 * 1024 * 1024);
  }
}
