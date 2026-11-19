import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const listings = JSON.parse(readFileSync(new URL('../src/data/plugin-listings.json', import.meta.url), 'utf8'));
const packages = ['relationships', 'timeline'].map(slug => ({ slug, ...JSON.parse(readFileSync(new URL(`../../../plugins/${slug}/plugin.json`, import.meta.url), 'utf8')) })).concat(listings.map((entry:any)=>({slug:entry.slug,...entry.manifest})));

for (const [slug, category] of [['essay-studio','essays'],['criticism-studio','criticism'],['poetry-studio','poetry'],['nonfiction-studio','nonfiction'],['biography-studio','biography'],['lyric-studio','lyrics'],['production-planner','production'],['picturebook','picturebooks'],['murder-mystery','immersive'],['world-studio','worldbuilding'],['mystery-lab','mystery'],['art-direction','art'],['subtitle-studio','subtitles'],['adaptation-studio', 'adaptation'], ['reader-review', 'beta'], ['comic-studio', 'comics'], ['audio-drama', 'audio'], ['story-research', 'research'], ['character-lab', 'characters'], ['story-analysis', 'analysis']]) {
  for (const prefix of ['', '/en']) test(`${prefix || 'zh-CN'} ${slug} 分类与精确身份检索`, async ({ page }) => {
    await page.goto(prefix + '/plugins/', { waitUntil: 'domcontentloaded' });
    await page.locator(`[data-plugin-category="${category}"]`).click();
    await expect(page.locator('.plugin-card:visible')).toHaveCount(1);
    await expect(page.locator('.plugin-card:visible a').first()).toHaveAttribute('href', `${prefix}/plugins/${slug}/`);
    await page.getByRole('searchbox').fill(`org.wordflowlab.${slug}`);
    await expect(page.locator('.plugin-card:visible')).toHaveCount(1);
  });
}

for (const prefix of ['', '/en']) {
  const en = !!prefix;
  for (const width of [375, 768, 1440]) {
    test(`${prefix || 'zh-CN'} ${width}px 插件检索与空状态`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width, height: 960 });
      await page.goto(prefix + '/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.plugin-home a').first()).toHaveAttribute('href', prefix + '/plugins/');
      if (width <= 1100) await page.locator('.mobile-nav summary').click();
      await page.locator(`.site-nav a[href="${prefix}/plugins/"]:visible`).click();
      await expect(page).toHaveURL(prefix + '/plugins/');
      await expect(page.locator('main h1')).toHaveCount(1);
      await expect(page.locator('.plugin-card:visible')).toHaveCount(packages.length);
      const search = page.getByRole('searchbox');
      await search.fill('org.hetu.timeline');
      await expect(page.locator('.plugin-card:visible')).toHaveCount(1);
      await page.locator('[data-plugin-category="relationships"]').click();
      await expect(page.locator('[data-plugin-empty]')).toBeVisible();
      await expect(page.locator('[data-plugin-count]')).toHaveText(en ? '0 plugins' : '0 个插件');
      await page.locator('[data-plugin-reset]').click();
      await expect(search).toBeFocused();
      await expect(page.locator('.plugin-card:visible')).toHaveCount(packages.length);
      await page.locator('[data-plugin-category="timeline"]').click();
      await expect(page.locator('[data-plugin-category="timeline"]')).toHaveAttribute('aria-pressed', 'true');
      await search.fill('no-such-plugin');
      await expect(page.locator('.plugin-empty')).toBeVisible();
      await page.locator('[data-plugin-reset]').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/plugins-${en ? 'en' : 'zh-CN'}-${width}.png`, fullPage: true });

      expect(errors).toEqual([]);
    });
    test(`${prefix || 'zh-CN'} ${width}px 键盘详情与语言接续`, async ({ page, context }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.setViewportSize({ width, height: 960 });
      await page.goto(prefix + '/plugins/', { waitUntil: 'domcontentloaded' });
      await page.locator(`.plugin-card a[href="${prefix}/plugins/relationships/"]`).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(prefix + '/plugins/relationships/');
      await expect(page.locator('.plugin-package')).toContainText(packages[0].version);
      for (const permission of packages[0].permissions) await expect(page.locator('.plugin-package')).toContainText(permission);
      await expect(page.locator('.plugin-package a').first()).toHaveAttribute('href', 'https://github.com/limecloud/hetu/tree/main/plugins/relationships');
      await page.locator('[data-copy-plugin-request]').click();
      await expect(page.locator('[data-plugin-copy-status]')).toHaveText(en ? 'Request copied' : '已复制请求');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe((await page.locator('[data-plugin-request]').textContent())!.trim());
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://hetu.limeai.run${prefix}/plugins/relationships/`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/plugin-detail-${en ? 'en' : 'zh-CN'}-${width}.png`, fullPage: true });
      await page.locator('.header-actions .lang').click();
      await expect(page).toHaveURL((en ? '' : '/en') + '/plugins/relationships/');
      await page.locator('.plugin-back').click();
      await expect(page).toHaveURL((en ? '' : '/en') + '/plugins/');
      expect(errors).toEqual([]);
    });
  }

  for (const path of ['plugins', ...packages.map(item => 'plugins/' + item.slug), 'docs/plugins', 'docs/plugin-development', 'docs/plugin-publishing', 'blog/creative-plugins', 'blog/story-across-media', 'blog/world-to-screen', 'blog/pages-and-players', 'blog/script-to-preparation', 'blog/line-to-take', 'blog/a-life-in-its-own-words', 'blog/fragments-and-readings']) {
    test(`${prefix || 'zh-CN'} ${path} 标题、SEO与站点地图`, async ({ page, request }) => {
      const sitemap = await (await request.get('/sitemap.xml')).text();
      await page.goto(`${prefix}/${path}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('main h1')).toHaveCount(1);
      await expect(page.locator('main h1')).toBeVisible();
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://hetu.limeai.run${prefix}/${path}/`);
      expect(sitemap).toContain(`<loc>https://hetu.limeai.run${prefix}/${path}/</loc>`);
    });
  }

  test(`${prefix || 'zh-CN'} 插件作者与开发者指南和未知插件`, async ({ page, request }) => {
    await page.goto(`${prefix}/docs/plugins/`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.doc-article pre')).toHaveCount(0);
    await page.goto(`${prefix}/docs/plugin-publishing/`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.doc-article a[href*="template=plugin-listing.yml"]')).toHaveCount(1);
    const missing = await request.get(`${prefix}/plugins/not-a-plugin/`);
    expect(missing.status()).toBe(404);
  });
}

test('禁用脚本时插件目录和详情仍可阅读', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  await page.goto('/plugins/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.plugin-card')).toHaveCount(packages.length);
  await expect(page.locator('[data-plugin-filters]')).toBeHidden();
  await page.locator('.plugin-card a[href="/plugins/relationships/"]').click();
  await expect(page.locator('.plugin-package')).toContainText(packages[0].id);
  await expect(page.locator('[data-plugin-request]')).toBeVisible();
  await expect(page.locator('[data-copy-plugin-request]')).toBeHidden();
  await context.close();
});

test('剪贴板受限时保留可手动复制的请求并给出反馈', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw new Error('denied'); } }));
  await page.goto('/plugins/timeline/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-copy-plugin-request]').click();
  await expect(page.locator('[data-plugin-copy-status]')).toContainText('手动复制');
  await expect(page.locator('[data-plugin-request]')).toBeVisible();
});

for (const listing of listings) for (const prefix of ['', '/en']) for (const width of [375, 768, 1440]) test((prefix || 'zh-CN')+` ${width}px ${listing.slug} 外部插件展示发布者、固定制品与验收范围`, async ({page})=>{
  await page.setViewportSize({width,height:960});
  await page.goto(prefix+'/plugins/'+listing.slug+'/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.plugin-byline')).toContainText('WordFlowLab');
  await expect(page.locator('.plugin-byline')).toContainText(prefix?'Preview':'开发预览');
  await expect(page.locator('.plugin-package')).toContainText('macOS arm64');
  await expect(page.locator('.plugin-release > a')).toHaveAttribute('href',listing.release.download_url);
  await page.locator('.plugin-release summary').click();
  await expect(page.locator('.plugin-release')).toContainText(listing.release.package_sha256);
  await expect(page.locator('.plugin-release')).toContainText(listing.release.archive_sha256);
  await expect(page.locator('.plugin-package nav a').first()).toHaveAttribute('href',listing.source_repository+'/tree/'+listing.source_commit);
  await expect(page.locator('.plugin-package nav a').nth(1)).toHaveAttribute('href',listing.source_repository+'/blob/'+listing.source_commit+'/'+(listing.capabilities_path ?? 'CAPABILITIES.md'));
  if (listing.homepage) await expect(page.locator('.plugin-detail-section a[href="'+listing.homepage+'"]')).toBeVisible();
  await expect(page.locator(`img[src="/plugins/${listing.slug}.png"]`)).toBeVisible();
  expect(await page.locator(`img[src="/plugins/${listing.slug}.png"]`).evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    return image.naturalWidth > 0 && image.naturalHeight > 0;
  })).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`test-results/${listing.slug}-${prefix?'en':'zh-CN'}-${width}.png`,fullPage:true});
});
