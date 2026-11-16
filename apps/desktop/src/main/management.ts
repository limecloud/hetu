import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import type { WorkRef } from "@hetu/plugin-sdk";
import { RecoveryStore } from "./recovery.ts";

type Call = (action: string, input: any) => Promise<any>;
type Decision = {
  work_ref: WorkRef;
  proposal_id: string;
  title: string;
  action: "hetu.agent_operations.decide";
  input: any;
  status: "pending" | "succeeded" | "blocked";
};
function data(result: any) {
  if (result.status !== "succeeded")
    throw new Error(result.error?.message ?? "管理方案未能读取。");
  return result.data;
}

/** 读取使用精确 Agent 授权，作者通道只提交经审阅的同一决定。 */
export class ManagementReview {
  #previews = new Map<string, { decision: Decision; view: any }>();
  #queue: Promise<any> = Promise.resolve();
  constructor(
    private work: WorkRef,
    private directory: string,
    private recovery: RecoveryStore,
    private scoped: Call,
    private author: Call,
    private active: () => boolean,
  ) {}
  #check() {
    if (!this.active()) throw new Error("作品已变化，请重新打开管理方案。");
  }
  async #read(action: string, input: any) {
    this.#check();
    const result = await this.scoped(action, input);
    this.#check();
    return result;
  }
  list(cursor?: string) {
    return this.#read("hetu.agent_operations.list", {
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
  }
  async get(id: string, sha256?: string) {
    const view = data(
      await this.#read("hetu.agent_operations.get", {
        proposal_id: id,
        ...(sha256 ? { proposal_sha256: sha256 } : {}),
      }),
    );
    return { ...view, journal: await this.journal(id) };
  }
  async verify(id: string, sha256: string) {
    const view = await this.get(id, sha256);
    if (view.action !== "hetu.bundles.export" || view.state !== "executed" ||
        typeof view.result?.bundle_id !== "string")
      throw new Error("请选择当前作品已执行的交付包方案。");
    return this.#read("hetu.bundles.verify", {
      work_ref: this.work,
      bundle_id: view.result.bundle_id,
    });
  }
  #file(id: string) {
    if (!/^proposal_[0-9a-f-]{36}$/.test(id)) throw new Error("方案引用无效。");
    return path.join(
      this.directory,
      createHash("sha256")
        .update(JSON.stringify([this.work, id]))
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
        record.proposal_id !== id ||
        record.action !== "hetu.agent_operations.decide" ||
        record.input?.proposal_id !== id ||
        typeof record.input?.operation_key !== "string" ||
        !["approve", "reject"].includes(record.input?.decision))
    )
      throw new Error("方案决定恢复记录无效，请保留记录检查。");
    return record;
  }
  async prepare(
    id: string,
    sha256: string,
    revision: number,
    decision: string,
  ) {
    if (!["approve", "reject"].includes(decision))
      throw new Error("请选择批准或拒绝。");
    const view = await this.get(id, sha256);
    if (view.state_revision !== revision)
      throw new Error("审核状态已变化，请刷新后重新审阅。");
    if (["executed", "executing"].includes(view.state))
      throw new Error("已执行方案保留历史，不能修改决定。");
    if (decision === "approve" && (view.is_expired || !view.is_current))
      throw new Error("方案已过期或作品已有变化，请让 Agent 重新准备。");
    const token = randomUUID();
    if (this.#previews.size >= 20)
      this.#previews.delete(this.#previews.keys().next().value!);
    const record: Decision = {
      work_ref: this.work,
      proposal_id: id,
      title:
        (decision === "approve" ? "批准" : "拒绝") + "「" + view.summary + "」",
      action: "hetu.agent_operations.decide",
      input: {
        proposal_id: id,
        proposal_sha256: sha256,
        expected_state_revision: revision,
        decision,
        operation_key: randomUUID(),
      },
      status: "pending",
    };
    this.#previews.set(token, { decision: record, view });
    return { token, title: record.title, view };
  }
  prepared(token: string) {
    this.#check();
    const value = this.#previews.get(token);
    if (!value) throw new Error("方案决定预览已失效，请重新审阅。");
    return value;
  }
  async #write(record: Decision) {
    const pending = this.#queue
      .catch(() => {})
      .then(async () => {
        await this.get(record.proposal_id, record.input.proposal_sha256);
        const prior = await this.journal(record.proposal_id);
        if (
          prior?.status === "pending" &&
          !isDeepStrictEqual(prior.input, record.input)
        )
          throw new Error("原审核决定结果尚未确认，请先恢复。");
        await this.recovery.write(
          this.#file(record.proposal_id),
          record,
          1024 * 1024,
        );
        this.#check();
        const result = await this.author(record.action, record.input);
        record.status =
          result.status === "succeeded"
            ? "succeeded"
            : result.status === "blocked" &&
                result.error?.code !== "workspace_busy"
              ? "blocked"
              : "pending";
        await this.recovery.write(
          this.#file(record.proposal_id),
          record,
          1024 * 1024,
        );
        this.#check();
        return result;
      });
    this.#queue = pending;
    return pending;
  }
  async commit(token: string) {
    const prepared = this.prepared(token);
    const current = await this.get(
      prepared.decision.proposal_id,
      prepared.decision.input.proposal_sha256,
    );
    if (current.state_revision !== prepared.view.state_revision)
      throw new Error("审核状态已有变化，请重新审阅。");
    return this.#write(prepared.decision);
  }
  async acknowledge(id: string, key: string) {
    const record = await this.journal(id);
    if (
      record &&
      record.status !== "pending" &&
      record.input.operation_key === key
    )
      await this.recovery.write(this.#file(id), null, 1024 * 1024);
  }
  async recover(id: string) {
    const record = await this.journal(id);
    if (!record) throw new Error("没有待恢复的审核决定。");
    await this.get(id, record.input.proposal_sha256);
    const result = await this.author("hetu.operations.get", {
      action: record.action,
      key: record.input.operation_key,
    });
    this.#check();
    if (result.status === "succeeded") {
      const original = result.data.original_result;
      if (original?.status === "succeeded") {
        record.status = "succeeded";
        await this.recovery.write(this.#file(id), record, 1024 * 1024);
      }
      return original;
    }
    if (result.error?.code !== "not_found") return result;
    return this.#write(record);
  }
}
