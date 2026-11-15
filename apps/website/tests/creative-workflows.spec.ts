import { test, expect } from '@playwright/test';

for (const prefix of ['', '/en']) for (const width of [375, 1440]) {
  const locale = prefix ? 'en' : 'zh-CN';
  test(`${locale} ${width}px 三类创作路径、指南与文章可接续`, async ({ page, request }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 960 });
    await page.goto(prefix + '/');
    await expect(page.locator('.creative-routes .section-intro')).toContainText(prefix ? 'creative library' : '创作库');
    await page.screenshot({ path: `test-results/creative-home-${locale}-${width}.png` });
    await page.locator(`.creative-route-grid a[href="${prefix}/docs/screenplays/"]`).click();
    await expect(page.locator('.doc-article blockquote').first()).toBeVisible();
    await expect(page.locator('.doc-article pre')).toHaveCount(0);
    await page.locator(`.doc-article a[href="${prefix}/docs/video/"]`).first().click();
    await expect(page.locator('.doc-article table')).toBeVisible();
    await page.locator('.header-actions .lang').click();
    await expect(page).toHaveURL((prefix ? '' : '/en') + '/docs/video/');
    await expect(page.locator('html')).toHaveAttribute('lang', prefix ? 'zh-CN' : 'en');

    for (const target of ['docs/getting-started', 'docs/screenplays', 'docs/video', 'blog/creative-library', 'blog/preview-before-production']) {
      await page.goto(`${prefix}/${target}/`);
      await expect(page.locator('main h1')).toBeVisible();
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://hetu.limeai.run${prefix}/${target}/`);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /\S+/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/creative-${target.replace('/', '-')}-${locale}-${width}.png`, fullPage: true });
    }
    await page.goto(prefix + '/docs/');
    await expect(page.locator(`.doc-index a[href="${prefix}/docs/screenplays/"]`)).toBeVisible();
    await expect(page.locator(`.doc-index a[href="${prefix}/docs/video/"]`)).toBeVisible();
    const sitemap = await (await request.get('/sitemap.xml')).text();
    for (const target of ['docs/screenplays', 'docs/video', 'blog/creative-library', 'blog/preview-before-production']) {
      expect(sitemap).toContain(`https://hetu.limeai.run${prefix}/${target}/`);
    }
    expect(errors).toEqual([]);
  });
}
