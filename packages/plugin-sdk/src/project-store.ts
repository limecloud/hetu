/** 独立专业插件的受管存储适配；领域语义由插件提供。 */
import type { BackendContext, ObjectResult, PluginSourceRef, Result } from "./index.ts";

export class ProjectError extends Error {
  code: string;
  constructor(message: string, code = "invalid_input") { super(message); this.code = code; }
}
export function requireValue(value: unknown, message: string, code?: string): asserts value {
  if (!value) throw new ProjectError(message, code);
}
export function canonical(value: unknown): string {
  const normalize = (v: any): any => Array.isArray(v) ? v.map(normalize)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])])) : v;
  return JSON.stringify(normalize(value));
}
export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
export function fixed(record: ObjectResult) {
  return { object_id: record.object.object_id, revision: record.object.revision, sha256: record.sha256 };
}
export function success(data: any): Result<any> { return { spec_version: "0.2.1", status: "succeeded", data }; }
export function failure(error: unknown): Result<any> {
  return { spec_version: "0.2.1", status: "failed", error: {
    code: error instanceof ProjectError ? error.code : "plugin.failure",
    message: error instanceof Error ? error.message : String(error),
  } };
}
export function data(result: Result<any>): any {
  if (result.status !== "succeeded") throw new ProjectError(result.error?.message ?? "结果未知，请沿原操作回读。", result.error?.code ?? "unknown");
  return result.data;
}

export class ProjectStore {
  readonly context: BackendContext;
  readonly owner: string;
  readonly kind: string;
  readonly validate: (content: any) => void;
  constructor(context: BackendContext, owner: string, kind: string, validate: (content: any) => void) {
    this.context=context;this.owner=owner;this.kind=kind;this.validate=validate;
  }
  async call(action: string, input: Record<string, any>): Promise<Result<any>> {
    return this.context.request(action, action.startsWith("hetu.extensions.") ? { ...input, work_ref: this.context.work_ref } : input);
  }
  async get(id: string, revision?: number): Promise<ObjectResult> {
    const r: ObjectResult = data(await this.call("hetu.extensions.objects.get", {
      object_id: id, ...(revision === undefined ? {} : { revision }),
    }));
    requireValue(r.object.owner_plugin_id === this.owner && r.object.kind === this.kind, "对象不属于当前专业插件。", "forbidden");
    this.validate(r.object.content);
    return r;
  }
  async baseline(input: any) {
    const r = await this.get(input.object_id, input.expected_revision);
    requireValue(r.sha256 === input.expected_sha256, "固定编辑基线摘要不一致。", "revision_conflict");
    return r;
  }
  async sources(refs: PluginSourceRef[]) {
    const results = [];
    for (const source_ref of refs) results.push(data(await this.call("hetu.extensions.sources.inspect", { source_ref })));
    return results;
  }
  async recover(operation_key: string) {
    const r = await this.call("hetu.extensions.operations.get", { operation_key });
    if (r.status === "succeeded") return r;
    if (r.error?.code !== "not_found") throw new ProjectError(r.error?.message ?? "原操作暂时不可查询。", r.error?.code ?? "unknown");
    return undefined;
  }
  async save(input: any, content: any, previous?: ObjectResult) {
    this.validate(content);
    requireValue(new TextEncoder().encode(content.title).length<=512, "方案标题超过512字节，请缩短标题。");
    requireValue(new TextEncoder().encode(canonical(content)).length <= 512 * 1024, "单方案超过512KiB，请按固定来源拆分为多个方案。", "hetu.budget_exceeded");
    const refs = input.source_refs ?? previous?.object.source_refs ?? [];
    requireValue(refs.length <= 100, "单方案来源超过100项，请分拆制作范围。", "hetu.budget_exceeded");
    // 既有索引不能重定向，新增来源只能追加；Core逐项核验固定字节。
    for (const [i, old] of (previous?.object.source_refs ?? []).entries())
      requireValue(canonical(refs[i]) === canonical(old), "已有固定来源不可移除或替换，请追加新修订。", "hetu.stale_evidence");
    return this.call("hetu.extensions.objects.save", {
      ...(input.object_id ? { object_id: input.object_id } : {}), kind: this.kind,
      title: content.title, schema_version: "1.0.0", content, source_refs: refs,
      expected_revision: input.expected_revision, expected_sha256: input.expected_sha256,
      operation_key: input.operation_key,
    });
  }
}
