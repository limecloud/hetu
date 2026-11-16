/** 插件仅消费语言无关的作品合同；局部渲染不调用 Core。 */
export interface WorkRef {
  workspace_id: string;
  kind: "novel" | "drama" | "video";
  object_id: string;
}
export interface TypeContribution {
  kind: string;
  schema_version: string;
  schema: Record<string, unknown>;
}
export interface ViewContribution {
  id: string;
  title: string;
  entry: string;
  object_kinds: string[];
}
export interface ActionContribution {
  id: string;
  title: string;
  input_schema: Record<string, unknown>;
  effect: "read" | "managed_write";
}
export interface PluginManifest {
  manifest_version: 1;
  host_api: "1";
  id: string;
  version: string;
  display: Record<"zh-CN" | "en", string>;
  description: Record<"zh-CN" | "en", string>;
  license: string;
  dependencies: { id: string; version: string }[];
  permissions: ("objects.read" | "objects.write")[];
  contributions: {
    views: ViewContribution[];
    data: TypeContribution[];
    actions: ActionContribution[];
  };
  runtime?: { entry: string };
}
export interface PluginObject {
  object_id: string;
  work_ref: WorkRef;
  owner_plugin_id: string;
  kind: string;
  title: string;
  schema_version: string;
  revision: number;
  content: unknown;
  package_sha256: string;
  source_refs?: PluginSourceRef[];
}
export type PluginSourceRef = { work_ref: WorkRef; sha256: string } & (
  | { kind: "document"; document_id: string; revision_id: string }
  | { kind: "blueprint"; blueprint_id: string; revision: number }
  | { kind: "work"; revision_ref: { revision: number } }
  | { kind: "asset"; asset_id: string; revision: number }
  | { kind: "cue"; cue_id: string; revision: number }
);
export interface Result<T = Record<string, unknown>> {
  spec_version: "0.2.1";
  status: string;
  data?: T;
  error?: { code: string; message: string };
  operation?: { key: string };
}
export interface ObjectResult {
  object: PluginObject;
  sha256: string;
}
export interface PluginContext {
  plugin_id: string;
  work_ref: WorkRef;
  package_sha256: string;
  view_id: string;
}
export interface PluginBridge {
  context(): Promise<PluginContext>;
  /** 仅当前作品、插件与视图的本机恢复稿；不属于已保存作品。 */
  buffer(value?: unknown): Promise<unknown>;
  request<T = Record<string, unknown>>(
    action: string,
    input: Record<string, unknown>,
  ): Promise<Result<T>>;
}
export interface BackendContext {
  request: PluginBridge["request"];
  work_ref: WorkRef;
  effect: (dispose: () => void | Promise<void>) => void;
}
export interface BackendModule {
  apply(context: BackendContext): void | Promise<void>;
  invoke(action: string, input: unknown): unknown | Promise<unknown>;
}
export const dataActions = [
  "hetu.extensions.objects.list",
  "hetu.extensions.objects.search",
  "hetu.extensions.index.status",
  "hetu.extensions.index.rebuild",
  "hetu.extensions.objects.get",
  "hetu.extensions.objects.save",
  "hetu.extensions.objects.export",
  "hetu.extensions.operations.get",
  "hetu.extensions.migrations.prepare",
  "hetu.extensions.migrations.list",
  "hetu.extensions.migrations.get",
  "hetu.extensions.migrations.execute",
] as const;
/** 所有权威数据写入统一受动作效果及原操作键约束。 */
export const dataWriteActions: readonly string[] = [
  "hetu.extensions.objects.save",
  "hetu.extensions.migrations.prepare",
  "hetu.extensions.migrations.execute",
];
/** 派生缓存可以重建，不产生权威修订或需要重放的业务操作。 */
export const dataCacheActions: readonly string[] = ["hetu.extensions.index.rebuild"];
export function unwrap<T>(result: Result<T>): T {
  if (result.status !== "succeeded" || result.data === undefined)
    throw new Error(
      result.error?.message ?? "操作未完成，请保留原操作键恢复。",
    );
  return result.data;
}

export function sameWork(left: unknown, right: WorkRef): boolean {
  if (!left || typeof left !== "object" || Object.keys(left).length !== 3)
    return false;
  const ref = left as WorkRef;
  return (
    ref.workspace_id === right.workspace_id &&
    ref.kind === right.kind &&
    ref.object_id === right.object_id
  );
}
