import { test, expect } from '@playwright/test';

for (const prefix of ['', '/en']) {
  test(`${prefix || 'zh-CN'} 改编对照支持键盘且作者主张与市场口径可达`, async ({ page }) => {
    await page.goto(prefix + '/');
    await expect(page.locator('.hero-stage .hero-art')).toBeVisible();
    await expect(page.locator('.hero-stage .hero-art')).toHaveAttribute('src', /hetu-river-background\.webp\?v=/);
    await page.locator('.hero-author-voice').click();
    await expect(page.locator('#author-values')).toBeInViewport();
    const tabs = page.locator('.adaptation-tabs [role="tab"]');
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(page.locator('#adapt-panel-1')).toBeVisible();
    await expect(page.locator('#adapt-panel-0')).toBeHidden();
    await page.keyboard.press('End');
    await expect(page.locator('#adapt-panel-2')).toBeVisible();
    await page.keyboard.press('Home');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.creative-route-grid > article')).toHaveCount(6);
    const market = page.locator('[data-market]');
    await expect(market).toHaveAttribute('data-market', prefix ? 'global' : 'china');
    await expect(market).toContainText(prefix ? 'Sensor Tower' : 'CNNIC');
    const rows = page.locator('.chart-row');
    const ratios = await rows.evaluateAll(items => items.map(row => row.querySelector('.chart-bar')!.getBoundingClientRect().width / row.querySelector('.chart-track')!.getBoundingClientRect().width));
    expect(ratios[0]).toBeGreaterThan(0);
    expect(ratios[0]).toBeLessThan(ratios[1]);
    expect(ratios[1]).toBeLessThan(1);
    await page.goto(prefix + '/blog/story-to-screen/');
    await expect(page.locator('.journal-article')).not.toContainText('{{');
    await expect(page.locator('.journal-article')).toContainText(prefix ? 'United States' : '5.26亿');
    await page.locator('.header-actions .lang').click();
    await expect(page).toHaveURL((prefix ? '' : '/en') + '/blog/story-to-screen/');
    await expect(page.locator('html')).toHaveAttribute('lang', prefix ? 'zh-CN' : 'en');
  });
  test(`${prefix || 'zh-CN'} Agent 一等入口可达并保留作者决定`, async ({ page }) => {
    await page.goto(prefix + '/');
    await expect(page.locator('.hero-agent-signal')).toContainText('MCP / CLI / Skills');
    const entries = page.locator('.entrypoint-grid > a');
    await expect(entries).toHaveCount(3);
    await entries.nth(0).click();
    await expect(page).toHaveURL(prefix + '/docs/agents/#mcp');
    await expect(page.locator('#mcp')).toBeAttached();
    await page.goto(prefix + '/');
    await entries.nth(1).click();
    await expect(page).toHaveURL(prefix + '/docs/agents/#cli');
    await expect(page.locator('#cli')).toBeAttached();
    await page.goto(prefix + '/');
    await entries.nth(2).click();
    await expect(page).toHaveURL(prefix + '/integrations/#skills-catalog');
    await expect(page.locator('[data-skills-catalog]')).toBeVisible();
    await page.goto(prefix + '/#prototype');
    await page.locator('.demo-entrypoints [data-action="settings"]').click();
    await expect(page.locator('.demo-agent')).toBeVisible();
    await expect(page.locator('[data-agent-context="settings"][name="agent-client"]')).toHaveValue('none');
  });

  for (const width of [375, 768, 1440, 2560]) {
    test(`${prefix || 'zh-CN'} ${width}px 首页保持四档字号与克制文案`, async ({ page }) => {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(prefix + '/');
      const sizes = await page.locator('body *').evaluateAll(elements => [...new Set(elements
        .filter(element => element.checkVisibility() && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()))
        .map(element => getComputedStyle(element).fontSize))].sort());
      expect(sizes).toEqual(['12px', '14px', '24px', width <= 760 ? '40px' : '56px']);
      await expect(page.locator('main')).not.toContainText('·');
      await expect(page.locator('main .eyebrow')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const hero = page.locator('.hero-stage');
      const backdrop = page.locator('.hero-backdrop .hero-art');
      await expect.poll(() => backdrop.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      const imageBounds = await backdrop.boundingBox();
      const heroBounds = await hero.boundingBox();
      const canvasBounds = await page.locator('.hero-backdrop').boundingBox();
      expect(Math.abs(canvasBounds!.x - (width - canvasBounds!.x - canvasBounds!.width))).toBeLessThan(1);
      expect(imageBounds!.width).toBe(Math.min(width, 1920));
      expect(imageBounds!.height).toBeGreaterThanOrEqual(heroBounds!.height);
      expect(imageBounds!.y).toBeLessThan(760);
      const copyBounds = await page.locator('.hero-copy').boundingBox();
      expect(Math.abs(copyBounds!.x + copyBounds!.width / 2 - width / 2)).toBeLessThan(1);
      await expect(page.locator('.hero-protocols a')).toHaveCount(3);
      await expect(page.locator('.story-sequence img')).toBeAttached();
      await expect(page.locator('.home-journal .journal-cover')).toHaveCount(3);
      const marketingImages = await page.locator('main img').evaluateAll(images => images.filter(image => !image.closest('.demo')).map(image => new URL(image.getAttribute('src')!, document.baseURI).pathname));
      expect(new Set(marketingImages).size).toBe(marketingImages.length);
      await expect(page.locator('.demo-library-banner')).toContainText('MCP');
      await expect(page.locator('.demo-library-banner')).toContainText('CLI');
      await expect(page.locator('.demo-library-banner')).toContainText('Skills');
    });
  }
}
