import manifest from "../../../contracts/baseline.json" with { type: "json" };

/** 基础能力随应用交付；它不登记或安装用户插件。 */
export const baseline = manifest;
export function verifyBaselineSurfaces(surfaces: readonly { id: string; kinds: readonly string[] }[]) {
  const byId = new Map(surfaces.map(surface => [surface.id, surface]));
  for (const module of baseline.modules) {
    for (const expected of module.surfaces) {
      const actual = byId.get(expected.id);
      if (!actual || !actual.kinds.includes(module.work_kind))
        throw new Error(`基础工作面装配不完整：${module.work_kind}/${expected.id}`);
    }
  }
}
