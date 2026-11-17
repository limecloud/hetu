import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(target));
    else result.push(target);
  }
  return result;
}
const files = await walk(root);
const paths = new Set(files);
const errors = [];
const registration = JSON.parse(await readFile(new URL('../cloud/web-application.json', import.meta.url), 'utf8'));
assert.equal(registration.web_application.enabled, true);
for (const field of ['desktop_url','mobile_url']) {
  const url = new URL(registration.web_application[field]);
  assert.equal(url.origin, 'https://hetu.limeai.run');
  assert.ok(paths.has(path.join(root, url.pathname, 'index.html')), `Cloud 登记的河图控制台入口缺少产物：${field}`);
}
const versions = JSON.parse(await readFile(new URL('../../../build/website/asset-versions.json', import.meta.url), 'utf8'));
for (const [pathname, version] of Object.entries(versions)) {
  const bytes = await readFile(path.join(root, pathname));
  assert.equal(createHash('sha256').update(bytes).digest('hex').slice(0, 16), version, `发布资产版本不符：${pathname}`);
}
let links = 0;
for (const file of files) {
  const relative = path.relative(root, file).replaceAll(path.sep, '/');
  assert.ok(!/^(?:sources|research|en\/research)\//.test(relative), `工程文档不能发布到官网：${relative}`);
  assert.ok(!/^(?:en\/)?docs\/\d{2}\//.test(relative), `编号工程规范不能发布到官网：${relative}`);
  assert.ok(!/^(?:en\/)?docs\/download-and-install\//.test(relative), `源码构建说明只归GitHub仓库：${relative}`);
  assert.ok(!/^prototype\//.test(relative), `原型只能嵌入首页：${relative}`);
}
const sitemap = await readFile(path.join(root, 'sitemap.xml'), 'utf8');
// 目录展示事实必须对应真实包，不以手写官网版本替代包清单。
const externalListings = JSON.parse(await readFile(new URL('../src/data/plugin-listings.json', import.meta.url), 'utf8'));
for (const slug of ['relationships', 'timeline', ...externalListings.map(entry => entry.slug)]) {
  const listing = externalListings.find(entry => entry.slug === slug);
  const manifest = listing?.manifest ?? JSON.parse(await readFile(new URL(`../../../plugins/${slug}/plugin.json`, import.meta.url), 'utf8'));
  for (const prefix of ['', 'en/']) {
    const pathname = `/${prefix}plugins/${slug}/`;
    const html = await readFile(path.join(root, pathname, 'index.html'), 'utf8');
    assert.ok(html.includes(manifest.id) && html.includes(manifest.version), `插件身份或版本不符：${pathname}`);
    if (listing) {
      for (const value of [listing.source_commit, listing.release.archive_sha256, listing.release.package_sha256, listing.release.download_url]) assert.ok(html.includes(value), '外部插件固定来源缺失：'+pathname);
    }
    for (const permission of manifest.permissions) assert.ok(html.includes(permission), `插件权限未展示：${pathname}/${permission}`);
    assert.ok(sitemap.includes(`<loc>https://hetu.limeai.run${pathname}</loc>`), `站点地图缺少插件：${pathname}`);
  }
}
for (const [collection, route] of [['guides', 'docs'], ['blog', 'blog']]) {
  const localizedFiles = [];
  for (const locale of ['zh-CN', 'en']) {
    const directory = new URL(`../src/content/${collection}/${locale}/`, import.meta.url);
    const entries = (await readdir(directory)).filter(file => file.endsWith('.md')).sort();
    assert.ok(entries.length > 0, `缺少内容：${collection}/${locale}`);
    localizedFiles.push(entries);
    for (const entry of entries) {
      const pathname = `/${locale === 'en' ? 'en/' : ''}${route}/${entry.slice(0, -3)}/`;
      assert.ok(paths.has(path.join(root, pathname, 'index.html')), `内容未发布：${collection}/${locale}/${entry}`);
      assert.ok(sitemap.includes(`<loc>https://hetu.limeai.run${pathname}</loc>`), `站点地图缺少内容：${pathname}`);
    }
  }
  assert.deepEqual(localizedFiles[0], localizedFiles[1], `中英文内容不对应：${collection}`);
}
for (const file of files.filter(name => name.endsWith('.html'))) {
  const html = await readFile(file, 'utf8');
  for (const match of html.matchAll(/(?:https:\/\/hetu\.limeai\.run)?\/(?:images|brand|resources)\/[^"'<>\s]+/g)) {
    const url = new URL(match[0].replaceAll('&amp;', '&'), 'https://hetu.limeai.run');
    if (versions[url.pathname] && url.searchParams.get('v') !== versions[url.pathname]) errors.push(`资产缺少正确版本：${path.relative(root, file)} → ${url.pathname}`);
  }
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const href = match[1].replaceAll('&amp;', '&');
    if (/^(https?:|mailto:|data:|javascript:)/.test(href)) continue;
    const pagePath = '/' + path.relative(root, file).replaceAll(path.sep, '/');
    const url = new URL(href, 'https://hetu.limeai.run' + pagePath);
    if (url.pathname === '/api/hetu/auth/login') {
      assert.ok((await stat(path.join(root, '../functions/api/hetu/[[path]].js'))).isFile(), '登录链接缺少 Pages Function');
      links++;
      continue;
    }
    let target = path.join(root, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) target = path.join(target, 'index.html');
    if (!paths.has(target)) {
      errors.push(`${path.relative(root, file)} → ${href}`);
      continue;
    }
    if (url.hash && target.endsWith('.html')) {
      const source = await readFile(target, 'utf8');
      const anchor = decodeURIComponent(url.hash.slice(1));
      if (!source.includes(`id="${anchor}"`)) errors.push(`缺少锚点：${path.relative(root, file)} → ${href}`);
    }
    links++;
  }
  if (/sk-[A-Za-z0-9]{24,}/.test(html) || html.includes('/Users/')) errors.push(`含敏感数据或本机路径：${file}`);
}
const zh = JSON.parse(await readFile(new URL('../src/i18n/zh-CN.json', import.meta.url), 'utf8'));
const en = JSON.parse(await readFile(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
function keys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, item]) => typeof item === 'object' && item !== null ? keys(item, prefix + key + '.') : [prefix + key]).sort();
}
assert.deepEqual(keys(zh), keys(en), '中英文资源键不一致');
for (const required of ['index.html','en/index.html','docs/getting-started/index.html','en/docs/getting-started/index.html','brand/favicon.ico','sitemap.xml','404.html']) {
  assert.ok(paths.has(path.join(root, required)), `缺少产物：${required}`);
}
for (const home of ['index.html', 'en/index.html']) {
  const html=await readFile(path.join(root,home),'utf8');
  assert.ok(html.includes('data-workbench-preview'), `首页缺少当前桌面预览：${home}`);
  assert.ok(html.includes('data-creative-results'), `首页缺少创作成果示例：${home}`);
  assert.ok(!html.includes('data-hetu-demo'), `首页仍包含过时工作台：${home}`);
}
for (const file of files) assert.ok((await stat(file)).size < 25 * 1024 * 1024, `超过 Pages 单文件限制：${file}`);
assert.deepEqual(errors, [], '静态产物链接或安全检查失败');
console.log(`产物检查通过：${files.filter(p => p.endsWith('.html')).length} 个页面、${links} 个本地引用、双语键与资源限制。`);
