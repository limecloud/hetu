import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { WorkRef } from "@hetu/plugin-sdk";
import type { SettingsReview } from "./settings.ts";

export function workAssociation(state: any, work?: WorkRef) {
  const exact = work && Object.values(state.associations ?? {}).find((entry: any) => isDeepStrictEqual(entry.work_ref, work)) as any;
  const defaults = state.associations?.default;
  return { client: exact?.client ?? state.preferences.agent_client, suite: exact?.suite ?? defaults?.suite ?? "general" };
}
type Context = {
  work: WorkRef; directory: string; settings: SettingsReview;
  check(): void; refresh(): Promise<unknown>;
  inspect(input: Record<string, unknown>): Promise<any>;
  prepare(input: Record<string, unknown>): Promise<any>;
  choose(): Promise<string | undefined>;
  reveal(directory: string): void;
};
export async function workAgentRequest(method: string, input: any, context: Context): Promise<any> {
  const { work, settings } = context;
  const state = await settings.get(); context.check();
  const association = workAssociation(state, work);
  const journal = await settings.journal(); context.check();
  if (method === "get") return { revision: state.revision, association, suites: state.suites, skills: state.skills,
    categories: state.categories, installable_clients: state.installable_clients, directory: context.directory,
    journal: journal?.input?.work_ref && isDeepStrictEqual(journal.input.work_ref, work) ? journal : undefined,
    other_pending: journal?.status === "pending" && !isDeepStrictEqual(journal.input?.work_ref, work) };
  if (method === "inspect" || method === "reveal_bundle") {
    const result = await context.inspect({ agent_client: association.client, suite_id: association.suite }); context.check();
    if (method === "reveal_bundle") { context.reveal(result.bundle_directory); return { revealed: true }; }
    return result;
  }
  if (method === "select") {
    if (!state.suites.some((suite: any) => suite.suite_id === input.suite_id)) throw new Error("请选择目录中的创作套件。");
    if (input.expected_revision !== state.revision) throw new Error("本机设置已变化，请刷新后选择。");
    await settings.selection("associate", { work_ref: work, expected_revision: state.revision, agent_client: input.agent_client, suite_id: input.suite_id });
    await context.refresh(); context.check(); await settings.acknowledge();
    return workAgentRequest("get", {}, context);
  }
  if (method === "choose_package" || method === "auto_detect") {
    const directory = method === "choose_package" ? await context.choose() : null; context.check();
    if (directory === undefined) return { canceled: true };
    await settings.selection("package_directory", { work_ref: work, expected_revision: state.revision, agent_client: association.client, suite_id: association.suite, directory });
    await context.refresh(); context.check(); await settings.acknowledge();
    return { saved: true };
  }
  if (method === "prepare_install") {
    if (!state.installable_clients.includes(association.client)) throw new Error("该客户端请使用接入说明安装。");
    const plan = await context.prepare({ kind: "agent_suite", work_ref: work, suite_id: association.suite, agent_client: association.client,
      install: true, summary: "安装当前作品的创作套件", operation_key: randomUUID() });
    context.check(); return plan;
  }
  if (method === "recover" || method === "acknowledge") {
    if (!journal || !isDeepStrictEqual(journal.input?.work_ref, work)) throw new Error("待恢复的本机操作不属于当前作品，请在设置中检查。");
    if (method === "recover") await settings.recover();
    await settings.acknowledge(); await context.refresh(); context.check();
    return workAgentRequest("get", {}, context);
  }
  throw new Error("未知作品协作用例。");
}
