import { test, expect } from '@playwright/test';

for (const width of [375, 768, 1440]) {
  for (const locale of ['zh-CN', 'en']) {
    test(`${locale} 首页在 ${width}px 无溢出且资源完整`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.status() >= 400) errors.push(response.url()); });
      await page.setViewportSize({ width, height: 960 });
      await page.goto(locale === 'en' ? '/en/' : '/');
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('h1')).toHaveCount(1);
      await page.locator('footer').scrollIntoViewIfNeeded();
      await expect.poll(() => page.locator('img').evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
      const distorted = await page.locator('img').evaluateAll(images => images.flatMap(image => {
        if (!(image instanceof HTMLImageElement)) return [];
        const rect = image.getBoundingClientRect();
        const difference = Math.abs((rect.width / rect.height) / (image.naturalWidth / image.naturalHeight) - 1);
        return difference > .02 ? [{ source: image.getAttribute('src'), width: rect.width, height: rect.height }] : [];
      }));
      expect(distorted).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(page.locator('h1')).toBeInViewport();
      await page.screenshot({ path: `test-results/home-${locale}-${width}.png`, fullPage: true });
    });
  }
}

test('移动菜单、语言切换与文档位置保留', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.locator('.mobile-nav summary').click();
  await expect(page.locator('.mobile-nav')).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(page.locator('.mobile-nav')).not.toHaveAttribute('open', '');
  await page.locator('.mobile-nav summary').click();
  await page.locator('.mobile-nav').getByRole('link', { name: '使用指南', exact: true }).click();
  await page.locator('.doc-index').getByRole('link', { name: /快速入门/ }).click();
  await page.locator('.header-actions .lang').click();
  await expect(page).toHaveURL(/\/en\/docs\/getting-started\/$/);
  await expect(page.locator('.doc-article')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.doc-article h1')).toHaveText('Quick start');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('英文入口使用英文界面图、分享卡和英文原型样例', async ({ page }) => {
  await page.goto('/en/');
  await expect(page.locator('.product-shot')).toHaveAttribute('src','/images/prototype-desktop-en.webp');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content',/social-og-en\.png$/);
  await page.locator('.hero-actions').getByRole('link',{name:/Explore the prototype/}).click();
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  const manuscript=await page.locator('#manuscript').inputValue();
  expect(manuscript).toContain('Rain had been falling');
  await page.locator('#language').click();
  await expect(page.locator('#manuscript')).toHaveValue(manuscript);
  await page.goto('/en/brand/');
  await expect(page.locator('img[src="/images/prototype-mobile-en.webp"]')).toHaveCount(1);
  await expect(page.locator('img[src="/images/prototype-website-en.webp"]')).toHaveCount(1);
});

test('使用指南完整双语，工程文档及源副本不对外发布', async ({ page, request }) => {
  test.setTimeout(120_000);
  const slugs = ['getting-started', 'writing', 'story-bible', 'adaptation', 'review', 'formats-and-delivery', 'agents', 'data-and-backup'];
  for (const prefix of ['', '/en']) {
    await page.goto(`${prefix}/docs/`);
    await expect(page.locator('.doc-index a')).toHaveCount(8);
    await expect(page.locator('main')).not.toContainText(/产品需求 PRD|产品与工程文档|研究与官方资料/);
    for (const slug of slugs) {
      await page.goto(`${prefix}/docs/${slug}/`);
      await expect(page.locator('.doc-article h1')).toHaveCount(1);
      await expect(page.locator('.doc-article')).toHaveAttribute('lang', prefix ? 'en' : 'zh-CN');
      if (prefix) expect(await page.locator('.doc-article').innerText()).not.toMatch(/\p{Script=Han}/u);
      if (slug === 'getting-started') {
        await page.waitForFunction(() => document.querySelector('.mermaid svg'));
        await expect(page.locator('.mermaid .error-icon')).toHaveCount(0);
      }
    }
  }
  const sitemap = await (await request.get('/sitemap.xml')).text();
  expect(sitemap).not.toMatch(/\/research\/|\/docs\/\d{2}\//);
  for (const path of ['/docs/01/', '/en/docs/30/', '/research/01/', '/en/research/01/', '/sources/docs/README.md', '/sources/docs/01-%E4%BA%A7%E5%93%81%E9%9C%80%E6%B1%82PRD.md']) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
});

test('原型支持中文编辑、来源定位、返工、批准及交付预览', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/prototype/workbench.html');
  const original = await page.locator('#manuscript').inputValue();
  await page.locator('#manuscript').fill(original + '\n中文输入测试。');
  await page.locator('#save').click();
  await expect(page.locator('#saveState')).toContainText('13');
  await page.locator('[data-chapter="2"]').click();
  await page.locator('[data-chapter="1"]').click();
  await expect(page.locator('#manuscript')).toHaveValue(original + '\n中文输入测试。');
  await page.locator('#locate').click();
  expect(await page.locator('#manuscript').evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd))).toBe('旧玉扣');
  await page.locator('[data-view="bible"]').click();
  await page.locator('#toggleLock').click();
  await expect(page.locator('#bibleStatus')).toContainText('已解锁');
  await page.locator('[data-view="review"]').click();
  await page.locator('#changes').click();
  await expect(page.locator('#reviewStatus')).toHaveText('待审核');
  await page.locator('#comment').fill('补充玉扣出现的时间依据。');
  await page.locator('#changes').click();
  await expect(page.locator('#reviewStatus')).toHaveText('要求修改');
  await page.locator('#approve').click();
  await expect(page.locator('#approvalDialog')).not.toBeVisible();
  await page.locator('#evidence').check();
  await page.locator('#approve').click();
  await expect(page.locator('#approvalDialog')).toBeVisible();
  await page.locator('#confirmApproval').click();
  await expect(page.locator('#reviewStatus')).toHaveText('已定稿');
  await page.locator('#language').click();
  await expect(page.locator('#reviewStatus')).toHaveText('Approved');
  await page.locator('[data-view="delivery"]').click();
  await page.locator('#export').click();
  await expect(page.locator('#exportResult')).toContainText('4 content groups');
  expect(errors).toEqual([]);
});

test('品牌、原型手机布局、站点地图与真实 404', async ({ page, request }) => {
  for (const target of ['/brand/favicon.ico', '/brand/manifest.webmanifest', '/images/social-og.png', '/docs/getting-started/', '/en/docs/writing/', '/sitemap.xml']) {
    expect((await request.get(target)).status()).toBe(200);
  }
  // Astro 预览与 Pages 均应返回实际 404，而非首页兜底。
  expect((await request.get('/this-page-does-not-exist/')).status()).toBe(404);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/prototype/index.html');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto('/prototype/workbench.html');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('[data-view="review"]').click();
  await expect(page.locator('#comment')).toBeVisible();
});


test('使用指南在桌面和手机布局可读', async ({ page }) => {
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto('/docs/');
    await expect(page.locator('h1')).toHaveText('使用指南');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/guides-${width}.png`, fullPage: true });
    await page.goto('/docs/writing/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width === 375) {
      await page.locator('.doc-mobile-nav summary').click();
      await expect(page.locator('.doc-mobile-nav nav')).toBeVisible();
      await page.locator('.doc-mobile-nav').getByRole('link', { name: '维护设定集', exact: true }).click();
      await expect(page.locator('.doc-article h1')).toHaveText('维护设定集');
    }
    await page.screenshot({ path: `test-results/guide-article-${width}.png`, fullPage: true });
  }
});
