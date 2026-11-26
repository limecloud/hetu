import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { WorkRef } from "@hetu/plugin-sdk";
import { RecoveryStore } from "./recovery.ts";
import {taskSourceContext} from "./agent/source-context.ts";
import {continuationText} from "../../../../packages/workbench-ui/src/task-reference.ts";

export type TaskRef = {
  scope_ref: { kind: string; id: string };
  task_id: string;
  request_revision: 1;
};
type Journal = {
  task_ref: TaskRef;
  action: string;
  input: Record<string, any>;
  status: "pending" | "succeeded" | "blocked";
};
const tools = new Map([
  ["hetu_open_task_view", "hetu.interactions.get"],
  ["hetu_save_task_feedback", "hetu.task_feedback.save"],
  ["hetu_list_task_feedback", "hetu.task_feedback.list"],
  ["hetu_save_task_selection", "hetu.interactions.save_selection"],
  ["hetu_read_task_context", "hetu.task_context.read"],
  ["hetu_read_task_candidate", "hetu.creative_tasks.read_candidate"],
  ["hetu_list_working_copies", "hetu.working_copies.list"],
  ["hetu_read_working_copy", "hetu.working_copies.get"],
]);
const writes = new Set([
  "hetu.task_feedback.save",
  "hetu.interactions.save_selection",
]);
function unwrap(result: any) {
  if (result.status !== "succeeded")
    throw new Error(result.error?.message ?? "任务操作未完成。");
  return result.data;
}
function toolResult(result: any) {
  return {
    structuredContent: result,
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    isError: result.status !== "succeeded",
  };
}

/** 仅第一方审阅面板使用；不向第三方插件暴露作者 Core 通道。 */
export class TaskReview {
  #tasks = new Map<string, TaskRef>();
  #queue: Promise<unknown> = Promise.resolve();
  private work: WorkRef;
  private directory: string;
  private recovery: RecoveryStore;
  private core: (action: string, input: unknown) => Promise<any>;
  private active: () => boolean;
  constructor(
    work: WorkRef,
    directory: string,
    recovery: RecoveryStore,
    core: (action: string, input: unknown) => Promise<any>,
    active: () => boolean,
  ) { this.work=work;this.directory=directory;this.recovery=recovery;this.core=core;this.active=active; }
  #check(ref?: TaskRef) {
    if (!this.active())
      throw new Error("任务页面的作品上下文已结束，请重新打开。");
    if (ref && !isDeepStrictEqual(this.#tasks.get(ref.task_id), ref))
      throw new Error("请先从当前作品的任务目录打开此任务。");
  }
  #file(ref: TaskRef) {
    const key = createHash("sha256")
      .update(JSON.stringify([this.work, this.#tasks.get(ref.task_id)]))
      .digest("hex");
    return path.join(this.directory, key + ".json");
  }
  async list(cursor?: string) {
    this.#check();
    const result = await this.core("hetu.creative_tasks.list", {
      work_ref: this.work,
      limit: 30,
      ...(cursor ? { cursor } : {}),
    });
    this.#check();
    for (const task of unwrap(result).tasks) {
      if (!isDeepStrictEqual(task.work_ref, this.work))
        throw new Error("任务归属与当前作品不一致。");
      this.#tasks.set(task.task_ref.task_id, task.task_ref);
    }
    return result;
  }
  async journal(ref: TaskRef): Promise<Journal | null> {
    this.#check(ref);
    const journal = (await this.recovery.read(
      this.#file(ref),
    )) as Journal | null;
    this.#check(ref);
    if (
      journal &&
      (!isDeepStrictEqual(journal.task_ref, ref) ||
        !writes.has(journal.action) ||
        !isDeepStrictEqual(journal.input.task_ref, ref) ||
        typeof journal.input.operation_key !== "string")
    )
      throw new Error("任务恢复记录无效，请保留本机记录后检查。");
    return journal;
  }
  async assess(ref:TaskRef,input:{submission_id?:string;professional_refs?:unknown[]}={}){
    this.#check(ref);
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!["submission_id","professional_refs"].includes(key)))throw Error("交付核对参数无效。");
    let candidate_refs:unknown[]|undefined;
    if(input.submission_id!==undefined){
      if(typeof input.submission_id!=="string"||!/^submission_[a-f0-9-]{36}$/.test(input.submission_id))throw Error("请选择确切成果批次。");
      const fixed=unwrap(await this.core("hetu.interactions.get",{task_ref:ref,submission_id:input.submission_id}));this.#check(ref);
      if(fixed.submission?.submission_id!==input.submission_id)throw Error("成果批次与当前任务不一致。");
      candidate_refs=fixed.submission.candidates.map((candidate:any)=>({task_ref:ref,submission_id:input.submission_id,candidate_id:candidate.candidate_id}));
    }
    const result=await this.core("hetu.creative_tasks.assess",{task_ref:ref,...(candidate_refs?{candidate_refs}:{}),...(input.professional_refs!==undefined?{professional_refs:input.professional_refs}:{})});
    this.#check(ref);return result;
  }
  async continuation(ref: TaskRef, input: {feedback_ref: {feedback_id: string; sha256: string}; language?: string}) {
    this.#check(ref);
    if (!input || Object.keys(input).some(key => !["feedback_ref", "language"].includes(key))) throw Error("继续请求参数无效。");
    const source = await taskSourceContext(this.work, {task_ref: ref, submission_id: null, feedback_ref: input.feedback_ref}, async (action, args) => {
      const result = await this.core(action, args); this.#check(ref); return unwrap(result);
    });
    this.#check(ref);
    const feedback = source.fixed_refs.find(item => item.kind === "task_feedback");
    if (!feedback) throw Error("请选择已保存的确切公开意见。");
    const fixedTask = {...ref, sha256: source.fixed_refs[0].sha256};
    return {work_ref: this.work, fixed_refs: source.fixed_refs, prompt: continuationText(fixedTask, feedback.feedback_ref, input.language ?? "zh-CN")};
  }
  async call(ref: TaskRef, name: string, input: Record<string, any>) {
    this.#check(ref);
    if (!isDeepStrictEqual(input.task_ref, ref))
      throw new Error("面板只能操作打开时的固定任务。");
    if (name === "hetu_read_task_operation")
      return toolResult(await this.#operation(ref, input.action, input.key));
    const action = tools.get(name);
    if (!action) throw new Error("任务面板没有此能力。");
    if (!writes.has(action)) {
      const result = await this.core(action, input);
      this.#check(ref);
      return toolResult(result);
    }
    const pending = this.#queue
      .catch(() => {})
      .then(async () => {
        this.#check(ref);
        const prior = await this.journal(ref);
        if (
          prior?.status === "pending" &&
          (prior.action !== action || !isDeepStrictEqual(prior.input, input))
        )
          throw new Error("原保存结果尚未确认，请先恢复原操作。");
        const journal: Journal = {
          task_ref: ref,
          action,
          input,
          status: "pending",
        };
        await this.recovery.write(this.#file(ref), journal, 1024 * 1024);
        this.#check(ref);
        const result = await this.core(action, input);
        journal.status =
          result.status === "succeeded"
            ? "succeeded"
            : result.status === "blocked" &&
                result.error?.code !== "workspace_busy"
              ? "blocked"
              : "pending";
        await this.recovery.write(this.#file(ref), journal, 1024 * 1024);
        this.#check(ref);
        return toolResult(result);
      });
    this.#queue = pending;
    return pending;
  }
  async #operation(ref: TaskRef, action: string, key: string) {
    const journal = await this.journal(ref);
    if (
      !journal ||
      journal.action !== action ||
      journal.input.operation_key !== key
    )
      throw new Error("只能查询此任务已登记的原保存操作。");
    const result = await this.core("hetu.operations.get", { action, key });
    this.#check(ref);
    return result;
  }
  async resource(ref: TaskRef, uri: string) {
    const journal = await this.journal(ref);
    if (!journal) throw new Error("没有此任务的原保存操作。");
    const expected = `hetu://task/${ref.scope_ref.kind}/${ref.scope_ref.id}/${ref.task_id}/operations/by-key?action=${journal.action}&key=${encodeURIComponent(journal.input.operation_key)}`;
    if (uri !== expected) throw new Error("面板不能读取其他任务资源。");
    const result = await this.#operation(
      ref,
      journal.action,
      journal.input.operation_key,
    );
    return {
      contents: [
        { uri, mimeType: "application/json", text: JSON.stringify(result) },
      ],
    };
  }
  async recover(ref: TaskRef) {
    const journal = await this.journal(ref);
    if (!journal) throw new Error("没有需要恢复的保存操作。");
    const result = await this.#operation(
      ref,
      journal.action,
      journal.input.operation_key,
    );
    if (result.status === "succeeded") {
      if (result.data.original_result?.status !== "succeeded")
        throw new Error("原操作尚未确认成功，请保留恢复记录。");
      await this.recovery.write(this.#file(ref), null, 1024 * 1024);
      return result;
    }
    if (result.error?.code !== "not_found") return result;
    // Core 原键校验先于 CAS；只重放已落盘的完整输入。
    const repeated = await this.call(
      ref,
      [...tools].find(([, action]) => action === journal.action)![0],
      journal.input,
    );
    if (repeated.structuredContent.status === "succeeded")
      await this.recovery.write(this.#file(ref), null, 1024 * 1024);
    return repeated.structuredContent;
  }
  async candidate(ref: TaskRef, candidate_id: string) {
    this.#check(ref);
    const value = unwrap(
      await this.core("hetu.interactions.get", { task_ref: ref }),
    );
    this.#check(ref);
    const candidate = value.submission?.candidates.find(
      (item: any) =>
        item.candidate_id === candidate_id &&
        item.kind === "text" &&
        item.draft_ref,
    );
    if (!candidate)
      throw new Error("当前批次没有此文本候选，请刷新后重新选择。");
    return candidate;
  }
}
