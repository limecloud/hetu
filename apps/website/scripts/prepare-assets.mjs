import { mkdir,copyFile,cp,rm,readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const repo=new URL('../../../',import.meta.url);const out=new URL('../public/',import.meta.url);
await mkdir(new URL('brand/',out),{recursive:true});await mkdir(new URL('images/',out),{recursive:true});
await cp(new URL('assets/brand/icons/web/',repo),new URL('brand/',out),{recursive:true});
for(const name of ['app-icon-1024.png','mascot-master.png','river-seal.svg'])await copyFile(new URL('assets/brand/'+name,repo),new URL('brand/'+name,out));
await cp(new URL('assets/marketing/',repo),new URL('images/',out),{recursive:true});
// 首页原型复用原生书库与工作台插画，不复制另一份原型页面。
await cp(new URL('assets/illustrations/library/',repo),new URL('images/library/',out),{recursive:true});
await mkdir(new URL('resources/brand/',out),{recursive:true});
for(const name of ['mascot-master.png','icon-overview.png','icon-overview-en.png','wordmark.png','wordmark-en.png','wordmark-dark.png','wordmark-en-dark.png'])await copyFile(new URL('assets/brand/'+name,repo),new URL('resources/brand/'+name,out));
await copyFile(new URL('assets/brand/icons/macos/Hetu.icns',repo),new URL('resources/brand/Hetu.icns',out));
await copyFile(new URL('assets/brand/icons/windows/hetu.ico',repo),new URL('resources/brand/hetu.ico',out));
await copyFile(new URL('assets/manifest.json',repo),new URL('resources/manifest.json',out));
// 只从受管清单生成版本，先核对发布副本，避免旧 CDN 缓存继续展示旧名称。
const manifest = JSON.parse(await readFile(new URL('assets/manifest.json', repo), 'utf8'));
const versions = {};
// 作者指南使用真实界面截图；只发布登记的图片并核对摘要。
const guides = JSON.parse(await readFile(new URL('../assets/guides/captures.json', import.meta.url), 'utf8'));
await mkdir(new URL('images/guides/', out), { recursive: true });
for (const [name, image] of Object.entries(guides)) {
  if (!/^[a-zA-Z0-9-]+\.webp$/.test(name)) throw new Error(`无效指南图片名称：${name}`);
  const source = new URL('../assets/guides/' + name, import.meta.url);
  const digest = createHash('sha256').update(await readFile(source)).digest('hex');
  if (digest !== image.sha256) throw new Error(`指南截图摘要不符：${name}`);
  await copyFile(source, new URL('images/guides/' + name, out));
  versions['/images/guides/' + name] = digest.slice(0, 16);
}
for (const asset of manifest.assets) {
  const path = asset.path;
  let destination;
  if (path.startsWith('assets/marketing/')) destination = path.replace('assets/marketing/', 'images/');
  else if (path.startsWith('assets/illustrations/library/')) destination = path.replace('assets/illustrations/library/', 'images/library/');
  else if (path.startsWith('assets/brand/icons/web/')) destination = path.replace('assets/brand/icons/web/', 'brand/');
  else if (['assets/brand/app-icon-1024.png', 'assets/brand/mascot-master.png', 'assets/brand/river-seal.svg'].includes(path)) destination = path.replace('assets/brand/', 'brand/');
  else if (/^assets\/brand\/(?:wordmark(?:-en)?(?:-dark)?|icon-overview(?:-en)?)\.png$/.test(path)) destination = path.replace('assets/brand/', 'resources/brand/');
  else if (path === 'assets/brand/icons/macos/Hetu.icns') destination = 'resources/brand/Hetu.icns';
  else if (path === 'assets/brand/icons/windows/hetu.ico') destination = 'resources/brand/hetu.ico';
  if (!destination) continue;
  const actual = createHash('sha256').update(await readFile(new URL(destination, out))).digest('hex');
  if (actual !== asset.sha256) throw new Error(`发布副本与资产摘要不同：${path}`);
  versions['/' + destination] = asset.sha256.slice(0, 16);
}
// 清单不能包含自身摘要，下载地址使用发布清单原始字节的摘要。
versions['/resources/manifest.json'] = createHash('sha256').update(await readFile(new URL('resources/manifest.json', out))).digest('hex').slice(0, 16);
await mkdir(new URL('build/website/', repo), { recursive: true });
await writeFile(new URL('build/website/asset-versions.json', repo), JSON.stringify(versions, null, 2) + '\n');
// 仅清理构建生成的旧文档副本；工程规范不属于网站发布资源。
await rm(new URL('sources/',out),{recursive:true,force:true});
await rm(new URL('prototype/',out),{recursive:true,force:true});
console.log('品牌与原生插画已同步；交互原型仅在首页，工程文档不参与发布。');
