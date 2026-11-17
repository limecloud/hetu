/** 私有调用编排：核对实际能力后分派，业务规则仍由插件与Core拥有。 */
import { createHash } from "node:crypto";
import Ajv from "ajv";

type Capabilities = {
  plugin_id: string;
  package_sha256: string;
  actions: { id: string }[];
  data_actions: { name: string }[];
  core_actions?: { name: string }[];
};
const validate = new Ajv().compile({
  type: "object", additionalProperties: false,
  required: ["capabilities_sha256", "action", "arguments"],
  properties: {
    capabilities_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    action: { type: "string", minLength: 1 },
    arguments: { type: "object" },
  },
});
export function capabilitiesSha(capabilities: unknown): string {
  return createHash("sha256").update(JSON.stringify(capabilities)).digest("hex");
}
export async function dispatchPlugin(capabilities: Capabilities, input: unknown, routes: {
  request: (action: string, input: any) => Promise<unknown>;
  invoke: (action: string, input: any) => Promise<unknown>;
}) {
  if (!validate(input)) throw new Error("插件调用参数无效。");
  const value = input as { capabilities_sha256: string; action: string; arguments: Record<string, unknown> };
  const capabilities_sha256 = capabilitiesSha(capabilities);
  if (value.capabilities_sha256 !== capabilities_sha256) throw new Error("插件能力已变化，请重新发现Schema。");
  const data = [...capabilities.data_actions, ...(capabilities.core_actions ?? [])].some(a => a.name === value.action);
  if (value.action !== "skills.read" && !data && !capabilities.actions.some(a => a.id === value.action)) throw new Error("插件未声明该动作。");
  const result = data ? await routes.request(value.action, value.arguments) : await routes.invoke(value.action, value.arguments);
  return { format_version: 1, plugin_id: capabilities.plugin_id,
    package_sha256: capabilities.package_sha256, capabilities_sha256, result };
}
