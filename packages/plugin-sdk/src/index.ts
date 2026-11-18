/** 插件仅消费语言无关的作品合同；局部渲染不调用 Core。 */
export { ProjectStore, ProjectError, requireValue, canonical, clone, fixed, success, failure, data } from './project-store.ts';
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
  /** integrated 将返回入口合入插件工具栏，宿主菜单仍保留返回。 */
  navigation?: "host" | "integrated";
}
export interface ActionContribution {
  id: string;
  title: string;
  input_schema: Record<string, unknown>;
  effect: "read" | "managed_write";
}
/** 由插件包拥有的方法；通过宿主按需读取，不注册新的客户端插件。 */
export interface SkillContribution {
  id: string;
  name: string;
  description: string;
  entry: string;
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
  /** 工作面适用范围；省略兼容全部作品类型，不改变作品授权。 */
  work_kinds?: WorkRef["kind"][];
  /** 历史清单字段；开放宿主不据此限制核心能力。 */
  permissions?: ("objects.read" | "objects.write" | "work.read")[];
  contributions: {
    views: ViewContribution[];
    data: TypeContribution[];
    actions: ActionContribution[];
    skills?: SkillContribution[];
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
  | { kind: "resource"; resource_id: string; revision: number }
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
/** 同作品的固定专业依据；不携带另一作品授权或写入权限。 */
export interface PluginBasisRef {
  owner_plugin_id: string;
  object_id: string;
  revision: number;
  sha256: string;
}
export interface PluginContext {
  plugin_id: string;
  work_ref: WorkRef;
  package_sha256: string;
  view_id: string;
  navigation?: "host" | "integrated";
}
export type WorkSurface = "profile" | "manuscript" | "canon";
export interface PluginBridge {
  context(): Promise<PluginContext>;
  /** 仅当前作品、插件与视图的本机恢复稿；不属于已保存作品。 */
  buffer(value?: unknown): Promise<unknown>;
  /** 关闭视图前完成恢复稿；拒绝时保留当前视图。 */
  onBeforeClose?(callback: () => void | Promise<void>): () => void;
  /** 桌面工作面服务；handoff只返回已复制，不返回私密授权。 */
  host?(action: "preferences" | "handoff" | "open_document" | "open_work" | "work_snapshot" | "export_file" | "save_artifact" | "media_open" | "media_release" | "close_view", input: Record<string, unknown>): Promise<unknown>;
  onPreferences?(callback: (value: {theme:string;language:string}) => void): () => void;
  invoke(action: string, input: Record<string, unknown>): Promise<unknown>;
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
  "hetu.extensions.work.snapshot",
  "hetu.extensions.sources.inspect",
  "hetu.extensions.sources.read_blob",
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

export function supportsWork(manifest: Pick<PluginManifest, "work_kinds">, work: WorkRef): boolean {
  return manifest.work_kinds === undefined || manifest.work_kinds.includes(work.kind);
}

/** 核心服务不依赖 Electron 或 Cordis；Schema 以当前入口能力发现为准。 */
export interface CoreAction {
  name: string;
  contract_revision: string;
  effect: string;
  input_schema: Record<string, unknown>;
}
export interface HostCapabilities { actions: CoreAction[]; }
export function createHostClient(request: PluginBridge["request"]) {
  return {
    request,
    capabilities: async () => unwrap(await request<HostCapabilities>("hetu.capabilities.get", {})),
    novelSnapshot: async (input: Record<string, unknown> = {}) => unwrap(await request("hetu.novels.snapshot", input)),
  };
}
