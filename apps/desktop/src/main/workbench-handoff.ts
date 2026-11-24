import { sameWork, type WorkRef } from "@hetu/plugin-sdk";
import type { Authoring } from "./authoring.ts";
import type { SettingsReview } from "./settings.ts";
import {creativeParticipation} from "../creative-request.ts";

export type HandoffEnvironment = {
  client: string;
  coreCli: string;
  collaborationDirectory?: string;
  localSettingsDirectory?: string;
};
const machine = (environment: HandoffEnvironment) => ({
  client_adapter: environment.client, core_cli: environment.coreCli,
  ...(environment.collaborationDirectory ? { collaboration_directory: environment.collaborationDirectory } : {}),
});
const text = (prompt: string, context: unknown) => prompt + "\n" + JSON.stringify(context, null, 2);

/** 两个作者工作台交接相同的固定事实，宿主仅负责递送文字。 */
export function creationHandoff(kind: string, environment: HandoffEnvironment, managedSession = false) {
  const name = ({novel:"小说",drama:"原创剧本",video:"独立视频"} as Record<string,string>)[kind];
  if (!name) throw new Error("请选择要创建的作品类型。");
  return text("请和我筹备" + name + "。先讨论当前创作目标；临时构思可直接回答，不自动建立作品、章节或首任务。我明确要保留或进入持续创作时，再发现河图实际能力并创建必要内容。不要强制完整设定、大纲或无关上游作品，不直接写 .hetu，不要求我转填表单；参考稿、采纳及定稿沿 Core 合同分别处理。", {
    work_type:kind,...(managedSession ? {client_adapter:environment.client,machine_entrypoint:"hetu CLI/MCP"} : machine(environment)),first_action:"hetu.collaboration.inspect",creation_action:"hetu.creation_projects.create",
  });
}
export type WorkHandoffContext = {
  work: WorkRef; environment: HandoffEnvironment; authoring: Authoring;
  workspacePath: string; managedSession?: boolean; executionPolicy(): Promise<any>; summary(): Promise<any>; check(): void; managementRef?: unknown; pluginConnection?: unknown;
};
export async function workHandoff(page: string, object: Record<string,unknown>, context: WorkHandoffContext) {
  const policy=await context.executionPolicy();context.check();
  const summary=await context.summary();context.check();
  const pageKind=({"work.versions":"git","work.import":"import","work.delivery":"delivery","work.links":"related_works","work.resources":"resources","novel.outlines":"structure","work.media":"media","work.images":"artwork","work.canon":"bible"} as Record<string,string>)[page]??context.work.kind;
  const result=await context.authoring.handoff(pageKind,object);context.check();
  if(result.status!=="succeeded")throw new Error(result.error?.message??"无法准备固定页面交接。");
  const handoff=result.data;
  return text("请围绕当前目标接续作品。"+creativeParticipation+"需要调用河图时先读取实际执行模式和领域Schema，再读取固定修订与现有成果。auto直接处理，不要求逐库或逐任务授权；confirm先读取，将本次写入集中准备为固定计划，获得本次确认后连续执行。保留真实Agent身份、CAS与原操作键，未知结果先回读原计划。", {
    work_ref:context.work,fixed_ref:summary.fixed_ref,page,
    ...(context.managedSession ? {client_adapter:context.environment.client,machine_entrypoint:"hetu CLI/MCP"} : {workspace_path:context.workspacePath,...machine(context.environment)}),
    execution_mode:policy.preferences.execution_mode,policy_revision:policy.execution_policy_revision,first_action:"hetu.execution.get_mode",execution_action:"hetu.execution.invoke",
    ...(Object.keys(object).length ? {handoff_object: object} : {}),
    ...(!context.managedSession && context.managementRef ? {management_ref: context.managementRef} : {}),
    fixed_refs:handoff.fixed_refs,direct_actions:handoff.direct_actions.map((a:any)=>a.name),proposal_actions:handoff.proposal_actions.map((a:any)=>a.name),
    ...(!context.managedSession && context.pluginConnection?{plugin_connection:context.pluginConnection}:{}),
  });
}
export function pluginResultText(fixed: unknown, connection: unknown, client: string) {
  return text("请通过河图的精确插件连接接续当前成果。先inspect或capabilities发现实际能力，再读取固定修订；按我的目标处理。范围仅此作品的插件对象，不含正文采纳、定稿或外部副作用。保留原操作键，未知结果先回读。", {
    ...(fixed as object),page:"plugin.results",client_adapter:client,plugin_connection:connection,limitations:["plugin_objects_only"],
  });
}
export function pluginWorkText(input: any, work: WorkRef, owner: string, managementRef: unknown, connection: unknown, client: string) {
  const fixed=input.object_ref?[{kind:"plugin_object",work_ref:work,owner_plugin_id:owner,...input.object_ref}]:[];
  return text("请通过河图的机器入口接续当前创作工程。先发现实际能力、读取固定成果，再按目标处理；保留原键，未知先回读。正文采纳、定稿、成片认可与外部副作用另行决定。", {
    goal:input.goal,work_ref:work,fixed_refs:fixed,node_id:input.node_id,run_ref:input.run_ref,client_adapter:client,management_ref:managementRef,plugin_connection:connection,
  });
}
export function migrationText(fixed: any, connection: object, client: string) {
  return text("请接续河图的固定插件数据升级。先使用精确插件连接发现实际能力，读取 migrations.get 和原键 operations.get；固定差异与 CAS 核验通过后执行 migrations.execute。保留迁移ID、方案摘要与原操作键，未知结果先回读。范围仅当前作品的插件对象，不包含正文采纳、定稿或其他副作用。", {
    page:"plugin.migration",client_adapter:client,plugin_connection:{...connection,...fixed},
  });
}
export async function settingsHandoff(method: string, input: any, context: {work?:WorkRef; settings:SettingsReview; environment:HandoffEnvironment; check():void}) {
  if(input.work_ref&&(!context.work||!sameWork(context.work,input.work_ref)))throw new Error("作品已切换，请重新交接。");
  const operation=method==="continue"?await context.settings.operation(input.operation_id):undefined;context.check();
  if(operation&&(operation.state!=="approved"||operation.is_expired||!operation.is_current))throw new Error("请选择当前仍有效的已批准方案。");
  return text("请通过河图的独立机器入口处理本机设置。先读取实际偏好与套件目录，再按我的目标准备完整固定方案；我审阅后由你执行原方案。不要读密钥、改账号或声称安装代表本会话已加载。结果未知保留原操作及原键回读。", {
    ...machine({...context.environment,client:operation?.fixed.client_adapter??context.environment.client}),local_settings_directory:context.environment.localSettingsDirectory,
    ...(operation?{action:"hetu.local_settings.execute",input:{operation_id:operation.operation_id,sha256:operation.sha256,operation_key:"execute-"+operation.operation_id}}:{action:"hetu.local_settings.get",input:input.work_ref?{work_ref:input.work_ref}:{},section:input.section??"preferences"}),
  });
}
