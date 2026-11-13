import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

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
let links = 0;
for (const file of files) {
  const relative = path.relative(root, file).replaceAll(path.sep, '/');
  assert.ok(!/^(?:sources|research|en\/research)\//.test(relative), `工程文档不能发布到官网：${relative}`);
  assert.ok(!/^(?:en\/)?docs\/\d{2}\//.test(relative), `编号工程规范不能发布到官网：${relative}`);
  assert.ok(!/^prototype\//.test(relative), `原型只能嵌入首页：${relative}`);
}
for (const locale of ['zh-CN', 'en']) {
  const directory = new URL(`../src/content/guides/${locale}/`, import.meta.url);
  const guides = await readdir(directory);
  assert.equal(guides.filter(file => file.endsWith('.md')).length, 8, '使用指南数量不一致');
}
for (const file of files.filter(name => name.endsWith('.html'))) {
  const html = await readFile(file, 'utf8');
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const href = match[1].replaceAll('&amp;', '&');
    if (/^(https?:|mailto:|data:|javascript:)/.test(href)) continue;
    const pagePath = '/' + path.relative(root, file).replaceAll(path.sep, '/');
    const url = new URL(href, 'https://hetu.limeai.run' + pagePath);
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
  assert.ok((await readFile(path.join(root, home), 'utf8')).includes('data-hetu-demo'), `首页缺少交互原型：${home}`);
}
for (const file of files) assert.ok((await stat(file)).size < 25 * 1024 * 1024, `超过 Pages 单文件限制：${file}`);
assert.deepEqual(errors, [], '静态产物链接或安全检查失败');
console.log(`产物检查通过：${files.filter(p => p.endsWith('.html')).length} 个页面、${links} 个本地引用、双语键与资源限制。`);
