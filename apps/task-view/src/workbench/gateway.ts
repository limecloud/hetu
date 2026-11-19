import type { AppHost } from "../host/bridge.ts";

export type RecordValue = Record<string, unknown>;
export type WorkRef = { workspace_id: string; kind: "novel" | "drama" | "video"; object_id: string };
export type Envelope = { status: string; data?: RecordValue; error?: { code: string; message: string } };
export function object(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
export function result(value: { structuredContent?: unknown; content?: { type: string; text?: string }[] }): Envelope {
  const envelope = object(value.structuredContent ?? JSON.parse(value.content?.find(item => item.type === "text")?.text ?? "null"));
  if (envelope.status !== "succeeded") {
    const error = object(envelope.error);
    throw new Error(`${error.code ?? "unavailable"}：${error.message ?? "读取未完成，请沿原操作恢复。"}`);
  }
  return envelope as Envelope;
}

function properties(schema: RecordValue): RecordValue {
  return Object.assign({}, object(schema.properties), ...[...(Array.isArray(schema.oneOf) ? schema.oneOf : []), ...(Array.isArray(schema.anyOf) ? schema.anyOf : [])].map(item => properties(object(item))));
}

/** 业务视图只依赖动作合同；授权材料留在工具参数，不进入交接文本。 */
export class WorkbenchGateway {
  management?: RecordValue;
  work?: WorkRef;
  private descriptors = new Map<string, RecordValue>();
  constructor(readonly host: AppHost) {}
  async descriptor(action: string) {
    if (!this.descriptors.has(action)) {
      const response = result(await this.host.callServerTool({ name: "hetu_inspect_collaboration", arguments: { action, include_schema: true, limit: 1 } }));
      const descriptor = (response.data?.actions as RecordValue[] | undefined)?.find(item => item.name === action);
      if (!descriptor) throw new Error("当前连接未提供此功能，请让 Agent 检查接入能力。");
      this.descriptors.set(action, descriptor);
    }
    return this.descriptors.get(action)!;
  }
  async read(action: string, input: RecordValue = {}, view?: RecordValue): Promise<RecordValue> {
    const descriptor = await this.descriptor(action);
    const pluginRead = action === "hetu.plugins.invoke" && view !== undefined;
    if (descriptor.effect !== "read" && !pluginRead) throw new Error("此界面只读取成果；请让 Agent 准备固定操作方案。");
    const fields = properties(object(descriptor.input_schema));
    const arguments_: RecordValue = { ...input };
    if (pluginRead) arguments_.view = view;
    if (this.management && "management_ref" in fields) arguments_.management_ref = this.management;
    if (this.work && "work_ref" in fields) arguments_.work_ref = this.work;
    const response = result(await this.host.callServerTool({ name: "hetu_call_action", arguments: { action, input: arguments_, ...(view && !pluginRead ? { view } : {}) } }));
    return response.data ?? {};
  }
  async openTask(locator: RecordValue) {
    const response = await this.host.callServerTool({ name: "hetu_open_app", arguments: { task_locator: locator } });
    result(response);
    return response;
  }
  handoff(intent: string, references: RecordValue = {}) {
    return `请在河图洛书处理：${intent}。${this.work ? `当前作品：${JSON.stringify(this.work)}。` : ""}固定对象：${JSON.stringify(references)}。先发现当前能力并核验精确授权，读取原任务、成果与公开意见；按已有用例准备完整方案，必要作者决定展示确切差异。不要重建已有任务或覆盖未保存稿；结果未知先查询原操作。`;
  }
}
