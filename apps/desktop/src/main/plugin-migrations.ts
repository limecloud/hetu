import { randomUUID } from "node:crypto";
import { sameWork, unwrap, type WorkRef } from "@hetu/plugin-sdk";

interface MigrationContext {
  work: WorkRef;
  grant: string;
  packageSha: string;
  call(method: string, params: Record<string, unknown>): Promise<any>;
  check(): void;
}
/** 可信工作面只能批准本次已读取的完整方案，不能代替插件执行。 */
export class PluginMigrationReview {
  #preview?: { token: string; context: MigrationContext; params: Record<string, unknown> };
  readonly #context: (owner: string) => Promise<MigrationContext>;
  constructor(context: (owner: string) => Promise<MigrationContext>) { this.#context = context; }

  async handoff(owner: string, migrationId: string, planSha: string) {
    const context = await this.#context(owner);
    const result = unwrap<any>(await context.call("extensions/request", {
      grant_id: context.grant, package_sha256: context.packageSha,
      request: { action: "hetu.extensions.migrations.get", contract_revision: "1", input: { work_ref: context.work, migration_id: migrationId } },
    }));
    context.check();
    if (result.plan_sha256 !== planSha || result.plan.owner_plugin_id !== owner || !sameWork(result.plan.work_ref, context.work)
      || result.plan.package_sha256 !== context.packageSha) throw new Error("升级方案或作品已变化，请重新交接。");
    return { work_ref: context.work, grant_id: context.grant, package_sha256: context.packageSha,
      migration_id: migrationId, plan_sha256: planSha, operation_key: result.plan.operation_key };
  }

  async preview(owner: string, migrationId: string, planSha: string) {
    this.#preview = undefined;
    const context = await this.#context(owner);
    const result = unwrap<any>(await context.call("extensions/request", {
      grant_id: context.grant, package_sha256: context.packageSha,
      request: { action: "hetu.extensions.migrations.get", contract_revision: "1", input: { work_ref: context.work, migration_id: migrationId } },
    }));
    context.check();
    if (result.plan_sha256 !== planSha || result.plan.owner_plugin_id !== owner || !sameWork(result.plan.work_ref, context.work)
      || result.plan.package_sha256 !== context.packageSha || result.result.data.state !== "prepared")
      throw new Error("升级方案、插件包或作品已变化，请重新读取。");
    const token = randomUUID();
    this.#preview = { token, context, params: { grant_id: context.grant, package_sha256: context.packageSha, migration_id: migrationId, plan_sha256: planSha } };
    return { ...result, token };
  }

  async approve(token: string) {
    const preview = this.#preview;
    if (!preview || preview.token !== token) throw new Error("请先审阅确切的数据升级内容。");
    preview.context.check();
    const result = unwrap(await preview.context.call("extensions/host", { method: "approve_migration", params: preview.params }));
    preview.context.check();
    return result;
  }
}
