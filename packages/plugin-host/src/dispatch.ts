/** 私有调用编排：核对实际能力后分派，业务规则仍由插件与Core拥有。 */
import { createHash } from "node:crypto";
import Ajv from "ajv";
import { PluginInvocationRejected } from "./rejection.ts";

type Capabilities = {
  plugin_id: string;
  package_sha256: string;
  actions: { id: string; effect?: string }[];
  data_actions: { name: string; effect?: string }[];
  core_actions?: { name: string; effect?: string }[];
};
const validate = new Ajv().compile({
  type: "object", additionalProperties: false,
  required: ["capabilities_sha256", "action", "arguments"],
  properties: {
    capabilities_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    action: { type: "string", minLength: 1 },
    arguments: { type: "object" },
    require_read_only: { type: "boolean" },
  },
});
export function capabilitiesSha(capabilities: unknown): string {
  return createHash("sha256").update(JSON.stringify(capabilities)).digest("hex");
}
export async function dispatchPlugin(capabilities: Capabilities, input: unknown, routes: {
  request: (action: string, input: any) => Promise<unknown>;
  invoke: (action: string, input: any) => Promise<unknown>;
}) {
  if (!validate(input)) throw new PluginInvocationRejected("插件调用参数无效。");
  const value = input as { capabilities_sha256: string; action: string; arguments: Record<string, unknown>; require_read_only?: boolean };
  const capabilities_sha256 = capabilitiesSha(capabilities);
  if (value.capabilities_sha256 !== capabilities_sha256) throw new PluginInvocationRejected("插件能力已变化，请重新发现Schema。");
  const data = [...capabilities.data_actions, ...(capabilities.core_actions ?? [])].find(a => a.name === value.action);
  const professional = capabilities.actions.find(a => a.id === value.action);
  if (value.action !== "skills.read" && !data && !professional) throw new PluginInvocationRejected("插件未声明该动作。");
  const effect = data?.effect ?? (value.action === "skills.read" ? "read" : professional?.effect) ?? "unknown";
  if (value.require_read_only && effect !== "read") throw new PluginInvocationRejected("结果投影只允许已声明的只读动作，不能重新执行写入。");
  const normalize = (v: any): any => Array.isArray(v) ? v.map(normalize)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(key => [key, normalize(v[key])])) : v;
  const invocation = { action: value.action, effect,
    ...(typeof value.arguments.operation_key === "string" ? { operation_key: value.arguments.operation_key } : {}),
    sha256: createHash("sha256").update(JSON.stringify(normalize({ action: value.action, input: value.arguments }))).digest("hex") };
  const result = data ? await routes.request(value.action, value.arguments) : await routes.invoke(value.action, value.arguments);
  return { format_version: 1, plugin_id: capabilities.plugin_id,
    package_sha256: capabilities.package_sha256, capabilities_sha256, invocation, result };
}
