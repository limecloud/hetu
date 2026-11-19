import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** 构建检查随包基础合同；不读取或改动本机插件安装状态。 */
export async function verifyBaseline(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "contracts/baseline.json"), "utf8"));
  const catalog = JSON.parse(await readFile(path.join(root, "contracts/actions.json"), "utf8"));
  const names = new Set(catalog.actions.map(row => row.name));
  if (manifest.delivery !== "application" || manifest.requires_optional_plugins !== false)
    throw new Error("基础产品必须随应用交付，不能依赖额外插件安装。");
  const kinds = new Set();
  for (const module of manifest.modules) {
    if (kinds.has(module.work_kind)) throw new Error("重复基础作品类型。");
    kinds.add(module.work_kind);
    for (const action of [...manifest.shared_actions, ...module.actions])
      if (!names.has(action)) throw new Error("缺少基础核心动作：" + action);
    for (const surface of module.surfaces) {
      if (!surface.source.startsWith("apps/desktop/src/renderer/") || surface.source.includes("..")) throw new Error("基础模块源码路径无效。");
      if (!(await stat(path.join(root, surface.source))).isFile()) throw new Error("缺少基础工作面：" + surface.id);
    }
  }
  if ([...kinds].sort().join(",") !== "drama,novel,video") throw new Error("基础产品必须提供小说、剧本与视频。");
  return manifest;
}
