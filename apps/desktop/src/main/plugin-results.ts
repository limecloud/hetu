import { sameWork, unwrap, type WorkRef } from "@hetu/plugin-sdk";

interface ResultContext {
  work: WorkRef;
  grant: string;
  packageSha: string;
  call(method: string, params: Record<string, unknown>): Promise<any>;
  check(): void;
}

/** 交接只固定当前插件成果，不附加作品管理或作者决定权限。 */
export async function pluginResultHandoff(context: ResultContext, owner: string, selected: Record<string, unknown>) {
  context.check();
  let fixed: Record<string, unknown>[] = [];
  if (Object.keys(selected).length) {
    if (Object.keys(selected).some(key => !["object_id", "revision", "sha256"].includes(key))
      || typeof selected.object_id !== "string" || !Number.isSafeInteger(selected.revision)
      || Number(selected.revision) < 1 || typeof selected.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(selected.sha256))
      throw new Error("请选择确切版本的插件成果。");
    const result = unwrap<any>(await context.call("extensions/request", {
      grant_id: context.grant, package_sha256: context.packageSha,
      request: { action: "hetu.extensions.objects.get", contract_revision: "1",
        input: { work_ref: context.work, object_id: selected.object_id, revision: selected.revision } },
    }));
    context.check();
    if (!sameWork(result.object.work_ref, context.work) || result.object.owner_plugin_id !== owner
      || result.object.object_id !== selected.object_id || result.object.revision !== selected.revision || result.sha256 !== selected.sha256)
      throw new Error("成果版本或作品不一致，请重新读取。");
    fixed = [{ kind: "plugin_object", work_ref: context.work, owner_plugin_id: owner, ...selected }];
  }
  return { work_ref: context.work, fixed_refs: fixed };
}
