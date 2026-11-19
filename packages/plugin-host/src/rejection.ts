/** 只由受信宿主在专业动作分派前创建；不能按插件错误文字推断未执行。 */
export class PluginInvocationRejected extends Error {}

export function invocationRejection(error: PluginInvocationRejected) {
  return { format_version: 1, kind: "hetu.plugin_invocation_rejected", message: error.message };
}

export function isInvocationRejection(value: unknown): value is ReturnType<typeof invocationRejection> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reply = value as Record<string, unknown>;
  return Object.keys(reply).length === 3 && reply.format_version === 1 &&
    reply.kind === "hetu.plugin_invocation_rejected" && typeof reply.message === "string";
}
