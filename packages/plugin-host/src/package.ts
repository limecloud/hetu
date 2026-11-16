import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import Ajv from "ajv";
import type { PluginManifest } from "@hetu/plugin-sdk";
import manifestSchema from "../../../contracts/schemas/plugin-manifest.schema.json" with { type: "json" };
export { manifestSchema };
const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(manifestSchema);
export function resourcePath(value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((p) => !p || p === "." || p === "..") ||
    path.posix.isAbsolute(value) ||
    /[:?#]/.test(value)
  )
    throw new Error("插件资源路径不安全。");
  return value;
}
export class PluginPackage {
  readonly manifest: PluginManifest;
  readonly sha256: string;
  readonly source: string;
  readonly #files: Map<string, Buffer>;
  private constructor(
    source: string,
    files: Map<string, Buffer>,
    manifest: PluginManifest,
    sha256: string,
  ) {
    this.source = source;
    this.#files = files;
    this.manifest = deepFreeze(manifest);
    this.sha256 = sha256;
  }
  static async inspect(source: string): Promise<PluginPackage> {
    if (!path.isAbsolute(source)) throw new Error("插件目录须为绝对路径。");
    if ((await lstat(source)).isSymbolicLink())
      throw new Error("插件根目录不能是软链接。");
    const root = await realpath(source);
    const files = new Map<string, Buffer>();
    const portableNames = new Set<string>();
    let total = 0;
    async function walk(relative: string) {
      for (const name of (await readdir(path.join(root, relative))).sort()) {
        const rel = resourcePath(relative ? relative + "/" + name : name);
        const portable = rel.normalize("NFC").toLowerCase();
        if (
          portableNames.has(portable) ||
          rel
            .split("/")
            .some(
              (part) =>
                /[. ]$/.test(part) ||
                /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
            )
        )
          throw new Error("插件资源存在跨系统名称冲突。");
        portableNames.add(portable);
        const full = path.join(root, rel);
        const stat = await lstat(full);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
          throw new Error("插件只允许普通文件与目录。");
        if (stat.isDirectory()) {
          if (rel.split("/").length > 12)
            throw new Error("插件目录层级超过预算。");
          await walk(rel);
          continue;
        }
        if (
          stat.size > 8 * 1024 * 1024 ||
          total + stat.size > 20 * 1024 * 1024 ||
          files.size >= 1000
        )
          throw new Error("插件包超过文件或字节预算。");
        const data = await readFile(full);
        total += data.length;
        if (total > 20 * 1024 * 1024) throw new Error("插件包读取超过预算。");
        files.set(rel, data);
      }
    }
    await walk("");
    const raw = files.get("plugin.json");
    if (!raw || raw.length > 128 * 1024)
      throw new Error("插件清单缺失或过大。");
    const manifest: PluginManifest = JSON.parse(raw.toString("utf8"));
    if (!validate(manifest))
      throw new Error("插件清单不兼容：" + ajv.errorsText(validate.errors));
    const names = new Set<string>();
    for (const v of manifest.contributions.views) {
      if (names.has(v.id)) throw new Error("视图贡献重复。");
      names.add(v.id);
      if (!files.has(resourcePath(v.entry))) throw new Error("视图入口缺失。");
    }
    names.clear();
    const dependencies = new Set<string>();
    for (const dependency of manifest.dependencies) {
      if (dependency.id === manifest.id || dependencies.has(dependency.id))
        throw new Error("插件不能依赖自身或重复声明依赖。");
      dependencies.add(dependency.id);
    }
    for (const t of manifest.contributions.data) {
      if (names.has(t.kind)) throw new Error("数据类型重复。");
      names.add(t.kind);
      if (JSON.stringify(t.schema).length > 32768)
        throw new Error("数据Schema超过预算。");
      new Ajv({ strict: false }).compile(t.schema);
    }
    names.clear();
    for (const a of manifest.contributions.actions) {
      if (a.id.startsWith("hetu.") || names.has(a.id))
        throw new Error("插件动作重复或覆盖核心动作。");
      names.add(a.id);
      new Ajv({ strict: false }).compile(a.input_schema);
    }
    if (manifest.contributions.actions.length && !manifest.runtime)
      throw new Error("动作贡献缺少后端入口。");
    if (manifest.runtime && !files.has(resourcePath(manifest.runtime.entry)))
      throw new Error("后端入口缺失。");
    const hash = createHash("sha256");
    for (const [name, data] of [...files].sort(([a], [b]) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    )) {
      const nameBytes = Buffer.from(name);
      const sizes = Buffer.alloc(12);
      sizes.writeUInt32BE(nameBytes.length);
      sizes.writeBigUInt64BE(BigInt(data.length), 4);
      hash.update(sizes).update(nameBytes).update(data);
    }
    return new PluginPackage(root, files, manifest, hash.digest("hex"));
  }
  file(relative: string): Buffer {
    const bytes = this.#files.get(resourcePath(relative));
    if (!bytes) throw new Error("插件资源不存在。");
    return Buffer.from(bytes);
  }
  entries(): [string, Buffer][] {
    return [...this.#files].map(([name, data]) => [name, Buffer.from(data)]);
  }
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
