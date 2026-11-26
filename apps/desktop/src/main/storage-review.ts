/** 桌面与MCP工作台共享固定清理决定；渲染端不提供文件路径。 */
export async function storageAction(request: (params: any) => Promise<any>, action: string, input: any) {
  const value = await request({client_adapter:"generic",request:{action,contract_revision:"1",input}});
  if (value.status !== "succeeded") throw Object.assign(new Error(value.error?.message ?? "存储操作未完成。"), {code:value.error?.code});
  return value.data;
}
export async function storageRequest(
  method: string, input: any,
  call: (action: string, input: any) => Promise<any>,
  confirm: (message: string, detail: string) => Promise<boolean>,
) {
  if (method === "storage_inspect") return call("hetu.local_settings.inspect_storage", {});
  if (method === "storage_prepare") {
    try { return await call("hetu.local_settings.prepare", {
      kind: "storage_cleanup", selected_ids: input.selected_ids, storage_snapshot: input.storage_snapshot,
      summary: "清理本机存储空间", operation_key: input.operation_key,
    }); } catch (error) {
      // 确定的准备拒绝可以重新选择；传输未知仍保留原键。
      if (["revision_conflict", "invalid_input", "idempotency_conflict", "hetu.capability_unavailable"].includes((error as any).code))
        return {preparation_failure: {message: (error as Error).message, code: (error as any).code}};
      throw error;
    }
  }
  let plan = await call("hetu.local_settings.get_operation", { operation_id: input.operation_id });
  if (plan.fixed.kind !== "storage_cleanup") throw new Error("此方案不是存储清理方案。");
  if (method === "storage_operation") return plan;
  if (method === "storage_cancel") {
    if (plan.state === "rejected") return plan;
    if (!["pending", "approved"].includes(plan.state)) throw new Error("原方案已开始执行，请先恢复原清理操作。");
    return call("hetu.local_settings.record_decision", {
      operation_id: plan.operation_id, sha256: plan.sha256, revision: plan.revision,
      decision: "reject", authorization_note: "作者返回清理选择，放弃当前固定方案。",
      operation_key: "storage-cancel-" + plan.operation_id + "-" + plan.revision,
    });
  }
  if (method !== "storage_execute") throw new Error("未知存储空间操作。");
  if (plan.state === "pending") {
    const items = plan.fixed.storage.items;
    const detail = `${items.length} 项，共 ${formatStorageBytes(plan.fixed.storage.bytes)}。\n${items.slice(0, 10).map((item: any) => item.name).join("\n")}${items.length > 10 ? `\n另有 ${items.length - 10} 项，完整清单保留在存储空间页面。` : ""}\n\n永久删除所选缓存和已移除会话；会话记录无法恢复。文件变化或核验失败时保留。`;
    if (!await confirm("清理所选项目？", detail)) return { cancelled: true, plan };
    plan = await call("hetu.local_settings.record_decision", {
      operation_id: plan.operation_id, sha256: plan.sha256, revision: plan.revision,
      decision: "approve", authorization_note: "作者在存储空间审阅固定清单后，点击原生确认清理。",
      operation_key: "storage-decision-" + plan.operation_id,
    });
  }
  return call("hetu.local_settings.execute", { operation_id: plan.operation_id, sha256: plan.sha256,
    operation_key: "storage-execute-" + plan.operation_id });
}
export function formatStorageBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index++; }
  return `${Number(bytes.toFixed(index ? 1 : 0))} ${units[index]}`;
}
