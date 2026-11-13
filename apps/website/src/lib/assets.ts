import versions from '../../../../build/website/asset-versions.json';

/** 与发布副本核对过的清单摘要，供静态页面与首页演示共用。 */
export function assetURL(path: string): string {
  const version = (versions as Record<string, string>)[path];
  if (!version) throw new Error(`资产未登记：${path}`);
  return `${path}?v=${version}`;
}
