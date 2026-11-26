import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { WorkRef } from "@hetu/plugin-sdk";
import { RecoveryStore } from "./recovery.ts";
import type { TaskRef } from "./task-review.ts";

type Call = (action: string, input: any) => Promise<any>;
type Decision = {
  document_id?: string;
  task_ref?: TaskRef;
  action: string;
  input: any;
  title: string;
};
type TextRange = { byte_start: number; byte_end: number; quote: string };
type AdoptionContext = {
  document_id?: string;
  task_ref?: TaskRef;
  title: string;
  destination?: string;
  source: string;
  source_format: string;
  target_format?: string;
  before: string;
  request: Record<string, any>;
};
type Scope = string | TaskRef;
type NewTarget = { title: string; volume_id: string | null };
function scopeOf(decision: Decision): Scope {
  const scope = decision.document_id ?? decision.task_ref;
  if (!scope) throw new Error("作者操作缺少固定作用对象。");
  return scope;
}
const decisionActions = new Set([
  "hetu.documents.rename",
  "hetu.documents.duplicate",
  "hetu.documents.move_range",
  "hetu.documents.move_to_new",
  "hetu.documents.restore_move",
  "hetu.drafts.adopt",
  "hetu.documents.validate",
  "hetu.documents.finalize",
  "hetu.documents.withdraw_finalization",
]);
function data(result: any) {
  if (!["succeeded", "partial"].includes(result.status))
    throw new Error(result.error?.message ?? "作者操作未完成。");
  return result.data;
}
function reference(value: any) {
  return {
    document_id: value.document.document_id,
    revision_id: value.revision.revision_id,
    sha256: value.revision.sha256,
  };
}
function decisionDocument(action: string, input: any): unknown {
  if (action === "hetu.documents.rename") return input?.document_id;
  if (action === "hetu.documents.duplicate") return input?.source_ref?.document_id;
  if (action === "hetu.documents.move_range") return input?.source_ref?.document_id;
  if (action === "hetu.documents.move_to_new") return input?.source_ref?.document_id;
  if (action === "hetu.drafts.adopt")
    return input?.preview?.request?.target_ref?.document_id;
  if (action === "hetu.documents.validate")
    return input?.document_ref?.document_id;
  if (action === "hetu.documents.finalize")
    return input?.preview?.request?.document_ref?.document_id;
  if (action === "hetu.documents.withdraw_finalization")
    return input?.document_id;
  return null;
}
const range = (quote: string) => ({
  byte_start: 0,
  byte_end: Buffer.byteLength(quote),
  quote,
});

/** 第一方作者用例：作品范围、固定预览与恢复记录不依赖 renderer 自报批准。 */
export class Authoring {
  #owned = new Set<string>();
  #previews = new Map<string, Decision>();
  #adoptions = new Map<string, AdoptionContext>();
  #queue: Promise<any> = Promise.resolve();
  constructor(
    private work: WorkRef,
    private directory: string,
    private recovery: RecoveryStore,
    private core: Call,
    private active: () => boolean,
    private documentBuffer?: (id: string) => Promise<any>,
  ) {}
  async #cleanDocuments(ids: string[]) {
    if (!this.documentBuffer) return;
    for (const id of ids) {
      const buffer = await this.documentBuffer(id);
      if (!buffer) continue;
      const current = data(await this.#call("hetu.documents.get", {document_id: id}));
      if (buffer.pending || buffer.content !== current.content) throw new Error("移动涉及的文稿存在未保存恢复稿，请先保存或比较。");
    }
  }
  #check() {
    if (!this.active())
      throw new Error("作品上下文已变化，请重新打开对应作品。");
  }
  async #call(action: string, input: any) {
    this.#check();
    const result = await this.core(action, input);
    this.#check();
    return result;
  }
  async #document(id: string) {
    this.#check();
    if (!this.#owned.has(id)) {
      let cursor: string | undefined;
      do {
        const page = data(
          await this.#call("hetu.documents.list", {
            work_ref: this.work,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        );
        for (const doc of page.documents) this.#owned.add(doc.document_id);
        cursor = page.next_cursor ?? undefined;
      } while (cursor && !this.#owned.has(id));
    }
    if (!this.#owned.has(id)) throw new Error("此文稿不属于当前作品。");
  }
  async #episode(id: string) {
    if (this.work.kind !== "drama") throw new Error("请在当前剧本中读取分集。");
    const result = await this.#call("hetu.drama.episodes.get", { episode_id: id });
    const episode = data(result);
    if (episode.project_ref.project_id !== this.work.object_id)
      throw new Error("分集不属于当前剧本。");
    await this.#document(episode.episode.document_id);
    return result;
  }
  async read(action: string, input: any) {
    const documentActions = new Set([
      "hetu.documents.get",
      "hetu.documents.history",
      "hetu.documents.save",
      "hetu.documents.lifecycle",
      "hetu.annotations.list",
      "hetu.annotations.save",
    ]);
    if (action === "hetu.drama.episodes.get") {
      return this.#episode(input.episode_id);
    } else if (action === "hetu.drafts.get" || action === "hetu.working_copies.get") {
      const episode = data(await this.#episode(input.episode_id));
      const reference = episode.manuscript.references.find((item: any) =>
        action === "hetu.drafts.get"
          ? item.kind === "submitted" && item.draft_ref?.draft_id === input.draft_id
          : isDeepStrictEqual(item.task_ref, input.task_ref) && isDeepStrictEqual(item.working_copy_ref, input.working_copy_ref));
      if (!reference) throw new Error("参考稿不属于当前分集或固定修订已变化，请刷新。");
      const result = await this.#call(action, action === "hetu.drafts.get"
        ? { draft_id: input.draft_id }
        : { task_ref: reference.task_ref, working_copy_ref: reference.working_copy_ref });
      const value = data(result);
      if (action === "hetu.drafts.get" && (value.draft.revision !== reference.draft_ref.revision ||
          value.draft.content_sha256 !== reference.sha256 || value.draft.target_document_id !== episode.episode.document_id ||
          !isDeepStrictEqual(value.draft.creative_task_ref, reference.task_ref)))
        throw new Error("参考稿已变化，请刷新分集后重新读取。");
      return result;
    } else if (action === "hetu.documents.scene_index") {
      if (this.work.kind !== "drama" || input.work_ref && !isDeepStrictEqual(input.work_ref, this.work))
        throw new Error("场次目录不属于当前剧本。");
      input = { ...input, work_ref: this.work };
    } else if (action === "hetu.outlines.get") {
      if (this.work.kind !== "novel" || input.work_ref && !isDeepStrictEqual(input.work_ref, this.work)) throw new Error("正式大纲不属于当前小说。");
      const {work_ref: _, ...request} = input; input = request;
    } else if (documentActions.has(action)) {
      await this.#document(input.document_id);
    } else if (
      [
        "hetu.documents.list",
        "hetu.documents.get_move",
        "hetu.blueprints.get",
        "hetu.works.get",
        "hetu.work_links.list",
        "hetu.work_links.get",
        "hetu.assets.list",
        "hetu.cues.list",
      ].includes(action)
    ) {
      if (input.work_ref && !isDeepStrictEqual(input.work_ref, this.work))
        throw new Error("不能在当前工作面切换作品。");
      input = { ...input, work_ref: this.work };
    } else if (action === "hetu.assets.read_blob") {
      if (!isDeepStrictEqual(input.work_ref, this.work)) throw new Error("素材不属于当前作品。");
    } else if (action === "hetu.assets.get" || action === "hetu.cues.get") {
      const result = await this.#call(action, input);
      if (result.status === "succeeded") {
        const record = action === "hetu.assets.get" ? result.data.asset : result.data.cue;
        if (!isDeepStrictEqual(record.work_ref, this.work))
          throw new Error("素材或线索不属于当前作品。");
        // 预览由主进程的固定引用适配；renderer不消费受管文件存储路径。
        if (action === "hetu.assets.get") delete record.blob.path;
      }
      return result;
    } else if (action === "hetu.covers.get") {
      if (this.work.kind !== "novel" || (input.work_ref && !isDeepStrictEqual(input.work_ref, this.work)))
        throw new Error("封面不属于当前小说。");
      const result = await this.#call(action, input.revision === undefined ? {} : { revision: input.revision });
      if (result.status === "succeeded") result.data = { cover: result.data.cover, preview: result.data.preview };
      return result;
    } else if (action === "hetu.drama.projects.get") {
      if (
        this.work.kind !== "drama" ||
        input.project_id !== this.work.object_id
      )
        throw new Error("剧本归属与当前作品不符。");
    } else if (action === "hetu.video.projects.get") {
      if (
        this.work.kind !== "video" ||
        input.video_project_id !== this.work.object_id
      )
        throw new Error("视频归属与当前作品不符。");
    } else throw new Error("工作台用例不可用。");
    const result = await this.#call(action, input);
    // 目录页已由Core按当前作品核验，打开其中的文稿沿用同一归属集合。
    if (action === "hetu.documents.list" && result.status === "succeeded")
      for (const document of result.data.documents) this.#owned.add(document.document_id);
    return result;
  }
  async rename(id: string, revision: string, title: string) {
    await this.#document(id);
    const current = data(await this.#call("hetu.documents.get", {document_id: id}));
    if (current.revision.revision_id !== revision) throw new Error("文稿已有新修订，请保留名称并重新比较。");
    if (typeof title !== "string" || !title.trim() || title.length > 200) throw new Error("文稿名称须为1至200个字符。");
    return this.#write({document_id: id, action: "hetu.documents.rename", title: "重命名文稿",
      input: {document_id: id, base_revision_id: revision, title: title.trim(), operation_key: randomUUID()}});
  }
  async duplicate(id: string, revision: string) {
    await this.#document(id);
    const current = data(await this.#call("hetu.documents.get", {document_id: id}));
    if (current.revision.revision_id !== revision) throw new Error("原文已有新修订，请重新读取后复制。");
    const directory = this.work.kind === "novel"
      ? data(await this.#call("hetu.novels.get", {}))
      : data(await this.#call("hetu.drama.projects.get", {project_id: this.work.object_id}));
    const expected = {revision: directory.revision ?? directory.project?.revision, sha256: directory.sha256};
    const title = Array.from(current.document.title as string).slice(0, 195).join("") + " 副本";
    return this.#prepare({document_id: id, action: "hetu.documents.duplicate", title: "复制「" + current.document.title + "」为「" + title + "」",
      input: {work_ref: this.work, source_ref: reference(current), expected, title, operation_key: randomUUID()}},
      {size_bytes: current.revision.size_bytes, source_format: current.revision.source_format});
  }
  async moveRange(id: string, revision: string, range: TextRange, target_ref: any) {
    await this.#document(id); await this.#document(target_ref.document_id);
    await this.#cleanDocuments([id, target_ref.document_id]);
    const source = data(await this.#call("hetu.documents.get", {document_id: id}));
    const target = data(await this.#call("hetu.documents.get", {document_id: target_ref.document_id}));
    if (source.revision.revision_id !== revision || !isDeepStrictEqual(reference(target), target_ref))
      throw new Error("移动涉及的正文已变化，请保留选区并重新读取。");
    const raw = Buffer.from(source.content, "utf8");
    if (!range || !Number.isSafeInteger(range.byte_start) || !Number.isSafeInteger(range.byte_end) ||
        range.byte_start < 0 || range.byte_end <= range.byte_start || range.byte_end > raw.length ||
        typeof range.quote !== "string" || !Buffer.from(range.quote, "utf8").equals(raw.subarray(range.byte_start, range.byte_end)))
      throw new Error("移动选区与已保存原文不符，请重新选择完整段落。");
    return this.#prepare({document_id: id, action: "hetu.documents.move_range", title: "将所选内容从「" + source.document.title + "」移至「" + target.document.title + "」",
      input: {work_ref: this.work, source_ref: reference(source), target_ref, byte_start: range.byte_start, byte_end: range.byte_end, quote: range.quote, operation_key: randomUUID()}},
      {size_bytes: Buffer.byteLength(range.quote), source_title: source.document.title, target_title: target.document.title});
  }
  async moveToNew(id: string, revision: string, range: TextRange, target: {title: string; volume_id?: string | null; plan?: string}) {
    await this.#document(id);
    await this.#cleanDocuments([id]);
    const source = data(await this.#call("hetu.documents.get", {document_id: id}));
    if (source.revision.revision_id !== revision) throw new Error("移动涉及的正文已变化，请保留选区并重新读取。");
    const raw = Buffer.from(source.content, "utf8");
    if (!range || !Number.isSafeInteger(range.byte_start) || !Number.isSafeInteger(range.byte_end) ||
        range.byte_start < 0 || range.byte_end <= range.byte_start || range.byte_end > raw.length ||
        typeof range.quote !== "string" || !Buffer.from(range.quote, "utf8").equals(raw.subarray(range.byte_start, range.byte_end)))
      throw new Error("移动选区与已保存原文不符，请重新选择完整段落。");
    const directory = this.work.kind === "novel"
      ? data(await this.#call("hetu.novels.get", {}))
      : data(await this.#call("hetu.drama.projects.get", {project_id: this.work.object_id}));
    const expected = {revision: directory.revision ?? directory.project?.revision, sha256: directory.sha256};
    const normalized = {title: String(target?.title ?? "").trim(), ...(this.work.kind === "novel" ? {volume_id: target?.volume_id ?? null} : {plan: String(target?.plan ?? "")})};
    if (!normalized.title || normalized.title.length > 200) throw new Error("新文稿标题须为1至200个字符。");
    return this.#prepare({document_id: id, action: "hetu.documents.move_to_new", title: "将所选内容移至新" + (this.work.kind === "drama" ? "分集" : "章节") + "「" + normalized.title + "」",
      input: {work_ref: this.work, source_ref: reference(source), expected, new_target: normalized, byte_start: range.byte_start, byte_end: range.byte_end, quote: range.quote, operation_key: randomUUID()}},
      {size_bytes: Buffer.byteLength(range.quote), source_title: source.document.title, target_title: normalized.title, is_new: true});
  }
  async restoreMove(id: string, move_ref: any) {
    await this.#document(id);
    const record = data(await this.#call("hetu.documents.get_move", {work_ref: this.work, move_ref})).move;
    if (record.source_after.document_id !== id) throw new Error("此移动不属于当前来源文稿。");
    await this.#document(record.target_after.document_id);
    await this.#cleanDocuments([id, record.target_after.document_id]);
    for (const fixed of [record.source_after, record.target_after]) {
      const current = data(await this.#call("hetu.documents.get", {document_id: fixed.document_id}));
      if (!isDeepStrictEqual(reference(current), fixed)) throw new Error("移动后已有新修订，请先比较两端内容。");
    }
    return this.#prepare({document_id: id, action: "hetu.documents.restore_move", title: "撤销本次跨文稿移动",
      input: {work_ref: this.work, move_ref, operation_key: randomUUID()}}, {move_ref});
  }
  async handoff(view_kind: string, object: Record<string, unknown> = {}) {
    if (
      Object.keys(object).some(
        (key) =>
          ![
            "video_episode_id",
            "media_ref",
            "document_id",
            "snapshot_id",
            "git_path",
            "git_commit_id",
            "revision_id",
            "byte_start",
            "byte_end",
            "quote",
            "link_id",
            "link_revision",
            "entity_ref",
            "blueprint_revision",
            "outline_id",
            "outline_revision",
            "outline_sha256",
            "resource_id",
            "asset_id",
            "cue_id",
            "revision",
          ].includes(key),
      )
    )
      throw new Error("页面交接包含不支持的对象字段。");
    if (typeof object.document_id === "string")
      await this.#document(object.document_id);
    if (typeof object.resource_id === "string") {
      const view = data(await this.#call("hetu.resources.get", { resource_id: object.resource_id, ...(object.revision ? { revision: object.revision } : {}) }));
      if (!isDeepStrictEqual(view.resource.work_ref, this.work)) throw new Error("交接资料不属于当前作品。");
    }
    for (const kind of ["asset", "cue"]) {
      if (typeof object[`${kind}_id`] === "string")
        await this.read(`hetu.${kind === "asset" ? "assets" : "cues"}.get`, {
          [`${kind}_id`]: object[`${kind}_id`],
          ...(object.revision ? { revision: object.revision } : {}),
        });
    }
    if (typeof object.link_id === "string")
      await this.read("hetu.work_links.get", {
        link_id: object.link_id,
        ...(object.link_revision ? { revision: object.link_revision } : {}),
      });
    return this.#call("hetu.handoffs.get", {
      view_kind,
      object_ref: { ...object, work_ref: this.work },
    });
  }
  async #task(task_ref: TaskRef) {
    const value = data(
      await this.#call("hetu.creative_tasks.get", { task_ref }),
    );
    if (
      !isDeepStrictEqual(
        value.request.input_snapshot.scope_context.work_ref,
        this.work,
      )
    )
      throw new Error("任务不属于当前作品。");
  }
  async #scope(scope: Scope) {
    if (typeof scope === "string") await this.#document(scope);
    else await this.#task(scope);
  }
  #file(id: Scope) {
    // 已有正文恢复文件保持原身份；新任务引用按字段值固定，不依赖 JSON 属性顺序。
    const identity =
      typeof id === "string"
        ? [this.work, id]
        : [
            {
              workspace_id: this.work.workspace_id,
              kind: this.work.kind,
              object_id: this.work.object_id,
            },
            {
              scope_ref: { kind: id.scope_ref.kind, id: id.scope_ref.id },
              task_id: id.task_id,
              request_revision: id.request_revision,
            },
          ];
    const key = createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex");
    return path.join(this.directory, key + ".json");
  }
  async journal(id: Scope) {
    await this.#scope(id);
    const journal: any = await this.recovery.read(this.#file(id));
    this.#check();
    const documentId = journal?.action === "hetu.documents.restore_move"
      ? data(await this.#call("hetu.documents.get_move", {work_ref: this.work, move_ref: journal.input?.move_ref})).move.source_after.document_id
      : journal && decisionDocument(journal.action, journal.input);
    if (
      journal &&
      (!isDeepStrictEqual(journal.work_ref, this.work) ||
        !isDeepStrictEqual(scopeOf(journal), id) ||
        (typeof id === "string"
          ? documentId !== id
          : journal.action !== "hetu.drafts.adopt" ||
            journal.input?.preview?.request?.target_ref !== null ||
            !isDeepStrictEqual(
              journal.input?.preview?.snapshot?.draft?.creative_task_ref,
              id,
            ) ||
            !isDeepStrictEqual(
              journal.input?.preview?.snapshot?.draft?.blueprint_ref?.work_ref,
              this.work,
            ) ||
            (this.work.kind === "drama"
              ? journal.input?.preview?.request?.new_document?.drama_project_ref
                  ?.project_id !== this.work.object_id
              : this.work.kind !== "novel")) ||
        !decisionActions.has(journal.action) ||
        typeof journal.input?.operation_key !== "string")
    )
      throw new Error("作者操作恢复记录损坏，请保留记录后检查。");
    return journal;
  }
  async #write(decision: Decision) {
    const pending = this.#queue
      .catch(() => {})
      .then(async () => {
        const scope = scopeOf(decision);
        await this.#scope(scope);
        if (decision.action === "hetu.documents.move_range") await this.#cleanDocuments([decision.input.source_ref.document_id, decision.input.target_ref.document_id]);
        if (decision.action === "hetu.documents.move_to_new") await this.#cleanDocuments([decision.input.source_ref.document_id]);
        if (decision.action === "hetu.documents.restore_move") {
          const record = data(await this.#call("hetu.documents.get_move", {work_ref: this.work, move_ref: decision.input.move_ref})).move;
          await this.#cleanDocuments([record.source_after.document_id, record.target_after.document_id]);
        }
        const prior = await this.journal(scope);
        if (
          prior?.status === "pending" &&
          (prior.action !== decision.action ||
            !isDeepStrictEqual(prior.input, decision.input))
        )
          throw new Error("原作者操作结果尚未确认，请先恢复。");
        const journal = { ...decision, work_ref: this.work, status: "pending" };
        await this.recovery.write(this.#file(scope), journal, 8 * 1024 * 1024);
        const result = await this.#call(decision.action, decision.input);
        journal.status = ["succeeded", "partial"].includes(result.status)
          ? "succeeded"
          : result.status === "blocked" &&
              result.error?.code !== "workspace_busy"
            ? "blocked"
            : "pending";
        await this.recovery.write(this.#file(scope), journal, 8 * 1024 * 1024);
        this.#check();
        return result;
      });
    this.#queue = pending;
    return pending;
  }
  async acknowledge(id: Scope, key: string) {
    const record = await this.journal(id);
    if (
      record &&
      record.input.operation_key === key &&
      record.status !== "pending"
    )
      await this.recovery.write(this.#file(id), null, 8 * 1024 * 1024);
  }
  async recover(id: Scope) {
    const journal = await this.journal(id);
    if (!journal) throw new Error("没有待恢复的作者操作。");
    const original = await this.#call("hetu.operations.get", {
      action: journal.action,
      key: journal.input.operation_key,
    });
    if (original.status === "succeeded") {
      const result = original.data.original_result;
      if (["succeeded", "partial"].includes(result?.status)) {
        journal.status = "succeeded";
        await this.recovery.write(this.#file(id), journal, 8 * 1024 * 1024);
      }
      return result;
    }
    if (original.error?.code !== "not_found") return original;
    return this.#write(journal);
  }
  #prepare(decision: Omit<Decision, "input"> & { input: any }, content: any) {
    this.#check();
    const token = randomUUID();
    if (this.#previews.size >= 20)
      this.#previews.delete(this.#previews.keys().next().value!);
    this.#previews.set(token, decision);
    return {
      token,
      document_id: decision.document_id,
      recovery_scope: decision.task_ref,
      title: decision.title,
      ...content,
    };
  }
  async #adoptionContext(
    candidate: any,
    task_ref: TaskRef,
    newTarget?: NewTarget,
  ): Promise<AdoptionContext> {
    await this.#task(task_ref);
    const value = data(
      await this.#call("hetu.drafts.get", {
        draft_id: candidate.draft_ref.draft_id,
      }),
    );
    const draft = value.draft;
    if (
      !isDeepStrictEqual(draft.creative_task_ref, task_ref) ||
      draft.revision !== candidate.draft_ref.revision ||
      draft.content_sha256 !== candidate.draft_ref.sha256
    )
      throw new Error("候选参考稿已变化，请重新读取。");
    const id = draft.target_document_id;
    if (!id) {
      if (!isDeepStrictEqual(draft.blueprint_ref?.work_ref, this.work))
        throw new Error("参考稿没有当前作品的固定设定归属。");
      if (
        newTarget &&
        (Object.keys(newTarget).some(
          (key) => !["title", "volume_id"].includes(key),
        ) ||
          typeof newTarget.title !== "string" ||
          !(
            newTarget.volume_id === null ||
            typeof newTarget.volume_id === "string"
          ))
      )
        throw new Error("新稿目标包含无效字段。");
      const title = newTarget?.title ?? draft.title;
      let destination: string;
      const target: Record<string, any> = {
        title,
        volume_id: newTarget?.volume_id ?? null,
        novel_expected: null,
      };
      if (this.work.kind === "novel" && draft.package === "novel") {
        const novel = data(await this.#call("hetu.novels.get", {}));
        target.novel_expected = {
          revision: novel.revision,
          sha256: novel.sha256,
        };
        destination =
          "所属分卷：" +
          (target.volume_id === null
            ? "未分卷"
            : (novel.novel.volumes.find(
                (item: any) => item.volume_id === target.volume_id,
              )?.title ?? "分卷已不存在"));
      } else if (this.work.kind === "drama" && draft.package === "drama") {
        if (target.volume_id !== null) throw new Error("剧本不使用小说分卷。");
        const project = data(
          await this.read("hetu.drama.projects.get", {
            project_id: this.work.object_id,
          }),
        );
        target.drama_project_ref = {
          project_id: this.work.object_id,
          revision: project.project.revision,
          sha256: project.sha256,
        };
        destination =
          "所属剧本：" +
          project.project.title +
          " 新增为第" +
          (project.project.episode_refs.length + 1) +
          "集";
      } else throw new Error("此候选不能在当前作品中新建正文。");
      return {
        task_ref,
        title,
        destination,
        source: value.content,
        source_format: draft.source_format,
        before: "",
        request: {
          draft_ref: candidate.draft_ref,
          target_ref: null,
          new_document: target,
        },
      };
    }
    if (newTarget) throw new Error("已有固定目标的参考稿不能改为新稿。");
    await this.#document(id);
    const current = data(
      await this.#call("hetu.documents.get", { document_id: id }),
    );
    return {
      document_id: id,
      title: current.document.title,
      source: value.content,
      source_format: draft.source_format,
      target_format: current.revision.source_format,
      before: current.content,
      request: {
        draft_ref: candidate.draft_ref,
        target_ref: reference(current),
        new_document: null,
      },
    };
  }
  async #previewAdoption(
    context: AdoptionContext,
    source: TextRange,
    target: TextRange,
  ) {
    const planned = data(
      await this.#call("hetu.drafts.preview_adoption", {
        ...context.request,
        selected_ranges: [{ source, target }],
      }),
    );
    return this.#prepare(
      {
        document_id: context.document_id,
        task_ref: context.task_ref,
        action: "hetu.drafts.adopt",
        input: { preview: planned.preview, operation_key: randomUUID() },
        title: context.document_id
          ? "采纳参考稿到「" + context.title + "」"
          : "采纳为新" +
            (this.work.kind === "drama" ? "分集" : "章节") +
            "「" +
            context.title +
            "」",
      },
      {
        before: context.before,
        after: planned.content,
        baseline: planned.baseline?.content,
        eligible: true,
        is_new: !context.document_id,
        kind: this.work.kind,
        source_format: context.source_format,
        destination: context.destination,
      },
    );
  }
  async adoptionOptions(candidate: any, task_ref: TaskRef) {
    const context = await this.#adoptionContext(candidate, task_ref);
    const novel =
      !context.document_id && this.work.kind === "novel"
        ? data(await this.#call("hetu.novels.get", {}))
        : undefined;
    return {
      is_new: !context.document_id,
      kind: this.work.kind,
      title: context.title,
      volumes: novel?.novel.volumes ?? [],
    };
  }
  async adoption(candidate: any, task_ref: TaskRef, newTarget?: NewTarget) {
    const context = await this.#adoptionContext(candidate, task_ref, newTarget);
    return this.#previewAdoption(
      context,
      range(context.source),
      range(context.before),
    );
  }
  async adoptionContext(candidate: any, task_ref: any) {
    const context = await this.#adoptionContext(candidate, task_ref);
    this.#check();
    const token = randomUUID();
    if (this.#adoptions.size >= 20)
      this.#adoptions.delete(this.#adoptions.keys().next().value!);
    this.#adoptions.set(token, context);
    return {
      token,
      document_id: context.document_id,
      title: context.title,
      source: context.source,
      source_format: context.source_format,
      target_format: context.target_format,
      before: context.before,
    };
  }
  async adoptionPartial(token: string, source: TextRange, target: TextRange) {
    this.#check();
    const context = this.#adoptions.get(token);
    if (!context) throw new Error("局部采纳对照已失效，请重新读取。");
    // 仅接收选区；目标、参考稿和基线始终使用主进程保存的固定引用。
    for (const span of [source, target]) {
      if (
        !span ||
        Object.keys(span).length !== 3 ||
        !Number.isSafeInteger(span.byte_start) ||
        !Number.isSafeInteger(span.byte_end) ||
        typeof span.quote !== "string"
      )
        throw new Error("请选择固定原文中的有效片段。");
    }
    return this.#previewAdoption(context, source, target);
  }
  async check(id: string) {
    await this.#document(id);
    const value = data(
      await this.#call("hetu.documents.get", { document_id: id }),
    );
    return this.#write({
      document_id: id,
      action: "hetu.documents.validate",
      input: {
        document_ref: reference(value),
        plot_options: {},
        validation_options: {},
        operation_key: randomUUID(),
      },
      title: "检查当前固定修订",
    });
  }
  async finalization(
    id: string,
    report: any,
    comments: string,
    coverage: string,
  ) {
    await this.#document(id);
    if (!comments?.trim() || !coverage?.trim())
      throw new Error("请填写定稿理由及人工核对说明。");
    const value = data(
      await this.#call("hetu.documents.get", { document_id: id }),
    );
    const planned = data(
      await this.#call("hetu.documents.preview_finalization", {
        document_ref: reference(value),
        expected_finalization_ref: value.document.finalization_ref ?? null,
        report_refs: [report],
        comments,
        coverage_acknowledgement: coverage,
      }),
    );
    return this.#prepare(
      {
        document_id: id,
        action: "hetu.documents.finalize",
        input: { preview: planned.preview, operation_key: randomUUID() },
        title: "定稿「" + value.document.title + "」当前修订",
      },
      {
        after: planned.content,
        kind: this.work.kind,
        source_format: value.revision.source_format,
        eligible: planned.preview.eligible,
        blocker: planned.preview.blocker,
      },
    );
  }
  async withdrawal(id: string, reason: string) {
    await this.#document(id);
    if (!reason?.trim()) throw new Error("请填写撤回理由。");
    const value = data(
      await this.#call("hetu.documents.get", { document_id: id }),
    );
    if (!value.document.finalization_ref)
      throw new Error("此文稿没有当前定稿记录。");
    return this.#prepare(
      {
        document_id: id,
        action: "hetu.documents.withdraw_finalization",
        input: {
          document_id: id,
          expected_finalization_ref: value.document.finalization_ref,
          reason,
          operation_key: randomUUID(),
        },
        title: "撤回「" + value.document.title + "」的定稿决定",
      },
      { eligible: true, after: value.content, kind: this.work.kind, source_format: value.revision.source_format },
    );
  }
  prepared(token: string) {
    this.#check();
    const decision = this.#previews.get(token);
    if (!decision) throw new Error("预览已失效，请重新核对。");
    return decision;
  }
  async commit(token: string) {
    return this.#write(this.prepared(token));
  }
}
