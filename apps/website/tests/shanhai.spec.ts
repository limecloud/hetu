import { test, expect } from '@playwright/test';

for (const prefix of ['', '/en']) for (const width of [375, 1440]) {
  test(`${prefix || 'zh-CN'} ${width}px 山海独立模板入口`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(prefix + '/');
    const section = page.locator('.shanhai-entry');
    await expect(section.getByRole('heading', { level: 2 })).toBeVisible();
    await expect(section.locator('a[href="https://shanhai.limeai.run/"]')).toBeVisible();
    await expect(section.locator('.shanhai-stories a')).toHaveCount(3);
    for (const id of ['annotated-manuscript', 'dinner-secrets', 'tidal-city']) {
      await expect(section.locator(`a[href="https://shanhai.limeai.run/templates/${id}"]`)).toBeVisible();
    }
    await page.goto(prefix + '/plugins/');
    await expect(page.locator('.site-footer a[href="https://shanhai.limeai.run/"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('不运行脚本仍能进入山海完整模板', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('.shanhai-stories a')).toHaveCount(3);
  await expect(page.locator('.shanhai-entry')).toContainText('独立创作模板库');
  await context.close();
});
