/** 静态方法资源由安装包持有，发现及读取均不执行插件代码。 */
import { createHash } from "node:crypto";
import path from "node:path";
import Ajv from "ajv";
import type { PluginPackage } from "./package.ts";
import { resourcePath } from "./package.ts";

export const skillReadAction = {
  name: "skills.read",
  effect: "read",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["skill_id"],
    properties: {
      skill_id: { type: "string", minLength: 1, maxLength: 64 },
      resource: { type: "string", minLength: 1, maxLength: 250 },
    },
  },
} as const;
const validate = new Ajv().compile(skillReadAction.input_schema);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function textResource(pkg: PluginPackage, entry: string) {
  const bytes = pkg.file(entry);
  if (bytes.length > 64 * 1024) throw new Error("Skill单项资源超过64 KiB，请拆分引用文件。");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (content.includes("\0")) throw new Error("Skill资源须为UTF-8文本。");
  return { content, content_sha256: sha256(bytes) };
}
export function skillSummaries(pkg: PluginPackage) {
  return (pkg.manifest.contributions.skills ?? []).map(skill => ({
    ...skill,
    plugin_id: pkg.manifest.id,
    package_sha256: pkg.sha256,
    content_sha256: textResource(pkg, skill.entry).content_sha256,
  }));
}
export function readSkill(pkg: PluginPackage, input: unknown) {
  if (!validate(input)) throw new Error("Skill读取参数无效。");
  const args = input as { skill_id: string; resource?: string };
  const skill = pkg.manifest.contributions.skills?.find(s => s.id === args.skill_id);
  if (!skill) throw new Error("当前插件未声明该Skill。");
  const entry = args.resource
    ? resourcePath(path.posix.dirname(skill.entry) + "/" + resourcePath(args.resource))
    : skill.entry;
  return {
    plugin_id: pkg.manifest.id,
    package_sha256: pkg.sha256,
    skill_id: skill.id,
    name: skill.name,
    entry: skill.entry,
    resource: args.resource ?? path.posix.basename(skill.entry),
    media_type: "text/markdown",
    ...textResource(pkg, entry),
  };
}
