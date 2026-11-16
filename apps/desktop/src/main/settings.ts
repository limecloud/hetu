import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { RecoveryStore } from "./recovery.ts";

type Host = (method: string, input: Record<string, unknown>) => Promise<any>;
type Pending = {
  method: "decide" | "update" | "associate" | "package_directory";
  input: any;
  status: "pending" | "succeeded" | "blocked";
  result?: any;
};

/** 本机作者决定只经可信通道提交；先持久化原键，丢回执时重放同一输入。 */
export class SettingsReview {
  #previews = new Map<string, { title: string; view: any; pending: Pending }>();
  #queue: Promise<any> = Promise.resolve();
  constructor(
    private host: Host,
    private recovery: RecoveryStore,
    private file: string,
  ) {}
  get() {
    return this.host("get", {});
  }
  list(cursor?: string) {
    return this.host("list", { limit: 30, ...(cursor ? { cursor } : {}) });
  }
  operation(operation_id: string) {
    return this.host("operation", { operation_id });
  }
  async journal(): Promise<Pending | null> {
    const record = (await this.recovery.read(this.file)) as Pending | null;
    if (
      record &&
      (!["decide", "update", "associate", "package_directory"].includes(record.method) ||
        !["pending", "succeeded", "blocked"].includes(record.status) ||
        typeof record.input?.operation_key !== "string")
    )
      throw new Error("本机设置恢复记录无效，请保留文件检查。");
    return record;
  }
  async prepare(
    operation_id: string,
    sha256: string,
    revision: number,
    approve: boolean,
  ) {
    const view = await this.operation(operation_id);
    if (
      view.sha256 !== sha256 ||
      view.revision !== revision ||
      typeof approve !== "boolean"
    )
      throw new Error("方案已变化，请刷新后审阅。");
    if (["executing", "executed"].includes(view.state))
      throw new Error("已执行方案不能再修改决定。");
    if (approve && (!view.is_current || view.is_expired))
      throw new Error("设置基线已变化或方案已过期，请重新准备。");
    return this.#preview(
      (approve ? "批准" : "拒绝") + "「" + view.fixed.summary + "」",
      view,
      {
        method: "decide",
        input: {
          operation_id,
          sha256,
          revision,
          approve,
          operation_key: randomUUID(),
        },
        status: "pending",
      },
    );
  }
  async manual(expected_revision: number, patch: Record<string, unknown>) {
    const view = await this.get();
    if (view.revision !== expected_revision)
      throw new Error("本机设置已变化，请刷新后修改。");
    const input = structuredClone({
      expected_revision,
      patch,
      operation_key: randomUUID(),
    });
    return this.#preview("保存本机偏好", view, {
      method: "update",
      input,
      status: "pending",
    });
  }
  selection(method: "associate" | "package_directory", input: Record<string, unknown>) {
    return this.#write({ method, input: structuredClone({ ...input, operation_key: randomUUID() }), status: "pending" });
  }
  #preview(title: string, view: any, pending: Pending) {
    const token = randomUUID();
    if (this.#previews.size >= 20)
      this.#previews.delete(this.#previews.keys().next().value!);
    this.#previews.set(token, { title, view, pending });
    return { token, title, view, input: pending.input };
  }
  prepared(token: string) {
    const preview = this.#previews.get(token);
    if (!preview) throw new Error("设置预览已失效，请重新审阅。");
    return preview;
  }
  #write(record: Pending) {
    const action = this.#queue
      .catch(() => {})
      .then(async () => {
        const prior = await this.journal();
        if (
          prior?.status === "pending" &&
          !isDeepStrictEqual(prior.input, record.input)
        )
          throw new Error("原本机操作结果尚未确认，请先恢复。");
        await this.recovery.write(this.file, record, 1024 * 1024);
        let result: any;
        try {
          result = await this.host(record.method, record.input);
        } catch (error) {
          if (
            [
              "revision_conflict",
              "idempotency_conflict",
              "invalid_input",
              "forbidden",
              "hetu.author_confirmation_required",
            ].includes((error as any).code)
          ) {
            record.status = "blocked";
            await this.recovery.write(this.file, record, 1024 * 1024);
          }
          throw error;
        }
        record.status = "succeeded";
        record.result = result;
        await this.recovery.write(this.file, record, 1024 * 1024);
        return result;
      });
    this.#queue = action;
    return action;
  }
  commit(token: string) {
    return this.#write(structuredClone(this.prepared(token).pending));
  }
  async recover() {
    const record = await this.journal();
    if (!record) throw new Error("没有待恢复的本机操作。");
    return this.#write(record);
  }
  async acknowledge() {
    if (["succeeded", "blocked"].includes((await this.journal())?.status ?? ""))
      await this.recovery.write(this.file, null, 1024 * 1024);
  }
}
