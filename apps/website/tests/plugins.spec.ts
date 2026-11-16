import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const packages = ['relationships', 'timeline'].map(slug => ({ slug, ...JSON.parse(readFileSync(new URL(`../../../plugins/${slug}/plugin.json`, import.meta.url), 'utf8')) }));

for (const prefix of ['', '/en']) {
  const en = !!prefix;
  for (const width of [375, 768, 1440]) {
    test(`${prefix || 'zh-CN'} ${width}px 插件检索、详情与语言接续`, async ({ page, context }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.setViewportSize({ width, height: 960 });
      await page.goto(prefix + '/');
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

  test(`${prefix || 'zh-CN'} 插件作者与开发者指南、博客和SEO相互可达`, async ({ page, request }) => {
    const sitemap = await (await request.get('/sitemap.xml')).text();
    for (const path of ['plugins', 'plugins/relationships', 'plugins/timeline', 'docs/plugins', 'docs/plugin-development', 'docs/plugin-publishing', 'blog/creative-plugins']) {
      await page.goto(`${prefix}/${path}/`);
      await expect(page.locator('main h1')).toHaveCount(1);
      await expect(page.locator('main h1')).toBeVisible();
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://hetu.limeai.run${prefix}/${path}/`);
      expect(sitemap).toContain(`<loc>https://hetu.limeai.run${prefix}/${path}/</loc>`);
    }
    await page.goto(`${prefix}/docs/plugins/`);
    await expect(page.locator('.doc-article pre')).toHaveCount(0);
    await page.goto(`${prefix}/docs/plugin-publishing/`);
    await expect(page.locator('.doc-article a[href*="template=plugin-listing.yml"]')).toHaveCount(1);
    const missing = await request.get(`${prefix}/plugins/not-a-plugin/`);
    expect(missing.status()).toBe(404);
  });
}

test('禁用脚本时插件目录和详情仍可阅读', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  await page.goto('/plugins/');
  await expect(page.locator('.plugin-card')).toHaveCount(packages.length);
  await expect(page.locator('[data-plugin-filters]')).toBeHidden();
  await page.locator('.plugin-card a').first().click();
  await expect(page.locator('.plugin-package')).toContainText(packages[0].id);
  await expect(page.locator('[data-plugin-request]')).toBeVisible();
  await expect(page.locator('[data-copy-plugin-request]')).toBeHidden();
  await context.close();
});

test('剪贴板受限时保留可手动复制的请求并给出反馈', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw new Error('denied'); } }));
  await page.goto('/plugins/timeline/');
  await page.locator('[data-copy-plugin-request]').click();
  await expect(page.locator('[data-plugin-copy-status]')).toContainText('手动复制');
  await expect(page.locator('[data-plugin-request]')).toBeVisible();
});
