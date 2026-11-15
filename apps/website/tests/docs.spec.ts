import { test, expect } from '@playwright/test';

for (const prefix of ['', '/en']) {
  const en = !!prefix, locale = en ? 'en' : 'zh-CN';
  test(`${locale} 文档检索覆盖正文、空结果与键盘导航`, async ({ page }) => {
    await page.goto(prefix + '/docs/');
    await expect(page.locator('.guide-group')).toHaveCount(7);
    await expect(page.locator('.doc-index > a')).toHaveCount(26);
    await page.locator('[data-docs-search-open]').focus();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('searchbox');
    await expect(input).toBeFocused();
    await input.fill(en ? 'deduplicating' : '不按同名章节去重');
    await expect(dialog.locator('.docs-search-results a')).toHaveCount(1);
    await expect(dialog.locator('.docs-search-results a')).toHaveAttribute('href', prefix + '/docs/import-manuscript/');
    await page.keyboard.press('ArrowDown');
    await expect(dialog.locator('.docs-search-results a')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(input).toBeFocused();
    await input.fill('no-such-hetu-guide-abcdef');
    await expect(dialog.locator('.docs-search-results a')).toHaveCount(0);
    await expect(dialog.getByRole('status')).toContainText(en ? 'No guides' : '没有找到');
    await input.fill('');
    await expect(dialog.locator('.docs-search-results a')).toHaveCount(26);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-docs-search-open]')).toBeFocused();
    await page.locator('[data-docs-search-open]').click();
    await input.fill(en ? 'cover' : '封面');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(prefix + '/docs/cover-art/');
    await expect(page.locator('.doc-sidebar [aria-current="page"]')).toHaveAttribute('href', prefix + '/docs/cover-art/');
  });

  for (const width of [375, 768, 1440]) {
    test(`${locale} ${width}px 文档阅读、目录定位与品牌一致`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width, height: 960 });
      await page.goto(prefix + '/docs/');
      await expect(page.locator('.docs-paths > section')).toHaveCount(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/docs-index-${locale}-${width}.png`, fullPage: true });
      await page.goto(prefix + '/docs/feedback/');
      const article = page.locator('.doc-article');
      await expect(article.locator('h1')).toBeVisible();
      expect(await article.locator('[data-doc-body] > p').first().evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
      expect(await page.locator('body').evaluate(el => getComputedStyle(el).getPropertyValue('--jade').trim())).toBe('#208368');
      const toc = width > 1200 ? page.locator('.doc-toc') : page.locator('.doc-mobile-toc');
      if (width <= 1200) await toc.locator('summary').click();
      const target = toc.locator('a').nth(2);
      const hash = await target.getAttribute('href');
      await target.click();
      await expect(page).toHaveURL(new RegExp(hash! + '$'));
      const top = await page.locator(hash!).evaluate(el => el.getBoundingClientRect().top);
      expect(top).toBeGreaterThanOrEqual(width <= 760 ? 128 : 140);
      expect(top).toBeLessThan(220);
      if (width > 1200) await expect(target).toHaveAttribute('aria-current', 'location');
      if (width <= 760) {
        await page.locator('.doc-mobile-nav summary').click();
        await expect(page.locator('.doc-mobile-nav [aria-current="page"]')).toHaveAttribute('href', prefix + '/docs/feedback/');
        await page.keyboard.press('Escape');
        await expect(page.locator('.doc-mobile-nav')).not.toHaveAttribute('open');
      }
      const header = await page.locator('.site-nav').boundingBox();
      expect(header!.y).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/docs-reading-${locale}-${width}.png`, fullPage: true });
      await page.locator('.header-actions .lang').click();
      await expect(page).toHaveURL((en ? '' : '/en') + '/docs/feedback/');
      await expect(page.locator('.guide-pagination a[rel="next"]')).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
}

test('复制正文仅包含当前指南，并清楚反馈复制结果', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/docs/cover-art/');
  await page.locator('[data-copy-doc]').click();
  await expect(page.locator('[data-copy-status]')).toHaveText('已复制正文');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('先说故事气质和用途');
  expect(copied).not.toContain('下一篇');
  expect(copied).not.toContain('复制正文');
});
