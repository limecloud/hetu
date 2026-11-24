import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import catalog from '../../../integrations/catalog.json' with { type: 'json' };
import genres from '../../../tools/hetu-skills/genres.json' with { type: 'json' };

const suites = catalog.suites;
const visibleCards = '[data-skills-catalog] [data-suite-id]:not([hidden])';

for (const prefix of ['', '/en']) {
  const locale = prefix ? 'en' : 'zh-CN';

  test(`${locale} 首页提供 Agent 接入、快速起步和桌面预览入口`, async ({ page }) => {
    await page.goto(`${prefix}/`);
    await expect(page.locator('.hero-actions a.primary')).toHaveAttribute('href', '#review-experience');
    await expect(page.locator('.closing-links a.button')).toHaveAttribute('href', `${prefix}/docs/getting-started/`);
    await expect(page.locator('.hero-actions a.secondary')).toHaveAttribute('href', '#when-to-use');
    await expect(page.locator('#skills [data-suite-id]')).toHaveCount(6);
    await page.locator('#skills [data-suite-id="apocalypse"] a').click();
    await expect(page).toHaveURL(new RegExp(`${prefix}/integrations/#suite-apocalypse$`));
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#skills-dialog-title')).toContainText(prefix ? 'Apocalypse' : '末世');
    await page.reload();
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-dialog-close]').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-open-suite="apocalypse"]')).toBeFocused();
    await expect(page.locator('[data-hetu-demo]')).toHaveCount(0);
  });

  test(`${locale} 完整目录按题材、平台和频道定位并保留中文方法`, async ({ page }) => {
    await page.goto(`${prefix}/integrations/`);
    await expect(page.locator(visibleCards)).toHaveCount(suites.length);
    await expect(page.locator('[data-skill-task]')).toHaveCount(catalog.skills.length);
    const renderedVersions = await page.locator('[data-skills-catalog] [data-suite-id]').evaluateAll(cards => Object.fromEntries(cards.map(card => [card.getAttribute('data-suite-id'), card.querySelector('.skills-card-heading small')?.textContent])));
    for (const suite of suites) {
      const version = JSON.parse(readFileSync(new URL(`../../../integrations/codex/${suite.pluginName}/plugin.json`, import.meta.url), 'utf8')).version;
      expect(renderedVersions[suite.id]).toContain(version);
    }

    const search = page.locator('[data-skills-search]');
    await search.fill('末世');
    await expect(page.locator('[data-suite-id="apocalypse"]')).toBeVisible();
    await expect(page.locator('[data-suite-id="military"]')).toBeHidden();
    await search.fill('无限流');
    await expect(page.locator('[data-suite-id="infinite"]')).toBeVisible();
    await search.fill('unlikely-genre-no-match');
    await expect(page.locator(visibleCards)).toHaveCount(0);
    await expect(page.locator('[data-skills-empty]')).toBeVisible();
    await page.locator('[data-skills-reset]').click();
    await expect(search).toHaveValue('');
    await expect(page.locator(visibleCards)).toHaveCount(suites.length);
    await expect(page.locator('[data-skills-empty]')).toBeHidden();

    for (const scope of [
      { platform: 'fanqie', channel: '' },
      { platform: 'fanqie', channel: 'female' },
      { platform: 'qidian', channel: 'female' },
    ]) {
      await page.locator('[data-skills-platform]').selectOption(scope.platform);
      await page.locator('[data-skills-channel]').selectOption(scope.channel);
      const expected = [...new Set(catalog.categories
        .filter(category => category.kind !== 'field' && category.platform === scope.platform && (!scope.channel || category.channel === scope.channel))
        .flatMap(category => category.suiteIDs))].sort();
      await expect.poll(() => page.locator(visibleCards).evaluateAll(cards => cards.map(card => card.getAttribute('data-suite-id')).sort())).toEqual(expected);
      await expect(page.locator('[data-skills-empty]')).toBeVisible({ visible: expected.length === 0 });
    }

    await page.locator('[data-skills-platform]').selectOption('fanqie');
    await page.locator('[data-skills-channel]').selectOption('female');
    await search.fill('末世');
    await expect(page.locator('[data-suite-id="apocalypse"]')).toBeVisible();
    await expect(page.locator('[data-suite-id="military"]')).toBeHidden();
    const apocalypse = page.locator('[data-suite-id="apocalypse"]');
    const openButton = apocalypse.locator('[data-open-suite]');
    await openButton.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('dd[lang="zh-CN"]')).toHaveCount(7);
    await expect(dialog.locator('.skills-example')).toHaveText(genres.find(genre => genre.id === 'apocalypse')!.example);
    await dialog.locator('.skills-category-paths > summary').click();
    await expect(dialog.locator('.skills-category-paths ul')).toContainText('番茄');
    if (prefix) await expect(dialog.locator('.skills-method-note')).toContainText('written in Chinese');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(openButton).toBeFocused();
    await expect(search).toHaveValue('末世');

    await page.locator('[data-skills-reset]').click();
    await page.locator('[data-skills-family]').selectOption('历史军事');
    await expect(page.locator('[data-suite-id="military"]')).toBeVisible();
    await expect(page.locator('[data-suite-id="apocalypse"]')).toBeHidden();
    const historyCount = suites.filter(suite => suite.family === '历史军事').length;
    await expect(page.locator(visibleCards)).toHaveCount(historyCount);
    await expect(page.locator('[data-skills-count]')).toHaveText(`${historyCount}${prefix ? ' suites' : ' 套题材套件'}`);
  });

  for (const width of [375, 1440]) {
    test(`${locale} 目录在 ${width}px 使用可滚动弹窗查看方法`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width, height: 960 });
      await page.goto(`${prefix}/integrations/`);
      await page.locator('[data-skills-search]').fill(prefix ? 'military' : '军事');
      const military = page.locator('[data-suite-id="military"]');
      await military.locator('[data-open-suite]').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('dd').first()).toBeVisible();
      await expect(dialog.locator('[data-dialog-close]')).toBeFocused();
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
      await dialog.locator('.skills-category-paths > summary').click();
      await expect(dialog.locator('.skills-category-paths ul')).toBeVisible();
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(960);
      expect(await dialog.locator('.skills-dialog-body').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
      await page.screenshot({ path: `test-results/skills-${locale}-${width}.png` });
      await page.goBack();
      await expect(dialog).toBeHidden();
    });
  }

  test(`${locale} 作者指南用截图和按钮步骤引导上手`, async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 375, height: 960 });
    await page.goto(`${prefix}/docs/`);
    await expect(page.locator('.help-index .page-hero .primary')).toHaveAttribute('href', `${prefix}/docs/getting-started/`);
    for (const slug of ['getting-started', 'skills', 'codex-first-task', 'agents']) {
      await page.goto(`${prefix}/docs/${slug}/`);
      const article = page.locator('.doc-article');
      await expect(article.locator('pre, .mermaid')).toHaveCount(0);
      expect(await article.innerText()).not.toMatch(slug === 'agents' ? /\b(?:JSON|stdio|API)\b/ : /\b(?:MCP|JSON|CLI|stdio|API)\b/);
      const expectedImages = { 'getting-started': 4, skills: 1, 'codex-first-task': 1, agents: 0 };
      await expect(article.locator('img')).toHaveCount(expectedImages[slug as keyof typeof expectedImages]);
      for (const image of await article.locator('img').all()) {
        await image.scrollIntoViewIfNeeded();
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
        await expect(image).toHaveAttribute('src', /\/images\/guides\/.+\.webp\?v=[a-f0-9]{16}$/);
        await expect(image.locator('..')).toHaveAttribute('target', '_blank');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (slug !== 'agents') await page.screenshot({ path: `test-results/${slug}-${locale}-375.png`, fullPage: true });
    }
    await page.goto(`${prefix}/docs/skills/`);
    const catalogLink = page.locator('.doc-article a[href*="/integrations/"]');
    await expect(catalogLink).toHaveAttribute('href', `${prefix}/integrations/#skills-catalog`);
    await catalogLink.click();
    await expect(page.locator('#skills-catalog')).toBeInViewport();
    await page.goto(`${prefix}/docs/install/`);
    await expect(page.locator('.doc-article a[href="https://github.com/limecloud/hetu/releases/latest"]')).toHaveCount(1);
    await expect(page.locator('.doc-article pre')).toHaveCount(0);
    expect((await request.get(`${prefix}/docs/download-and-install/`)).status()).toBe(404);
    for (const href of await page.locator('.doc-article a').evaluateAll(links => links.map(link => link.getAttribute('href')!))) {
      if (href.startsWith('/')) expect((await request.get(href)).status(), href).toBe(200);
    }
    expect(errors).toEqual([]);
  });
}
