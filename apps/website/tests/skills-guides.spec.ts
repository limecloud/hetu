import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import catalog from '../../../integrations/catalog.json' with { type: 'json' };
import genres from '../../../tools/hetu-skills/genres.json' with { type: 'json' };

const suites = catalog.suites;
const visibleCards = '[data-skills-catalog] [data-suite-id]:not([hidden])';

for (const prefix of ['', '/en']) {
  const locale = prefix ? 'en' : 'zh-CN';

  test(`${locale} 首页提供源码试用、快速起步和首页原型入口`, async ({ page }) => {
    await page.goto(`${prefix}/`);
    await expect(page.locator('.hero-actions a.primary')).toHaveAttribute('href', `${prefix}/#prototype`);
    await expect(page.locator('.hero-quick-start a')).toHaveAttribute('href', `${prefix}/docs/getting-started/`);
    await expect(page.locator('.hero-actions a.secondary')).toHaveAttribute('href', `${prefix}/docs/download-and-install/`);
    await expect(page.locator('#skills [data-suite-id]')).toHaveCount(6);
    await page.locator('#skills [data-suite-id="apocalypse"] a').click();
    await expect(page).toHaveURL(new RegExp(`${prefix}/integrations/#suite-apocalypse$`));
    await expect(page.locator('#suite-apocalypse')).toBeInViewport();
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
    await apocalypse.locator('.skills-methods > summary').focus();
    await page.keyboard.press('Enter');
    await expect(apocalypse.locator('.skills-methods')).toHaveAttribute('open', '');
    await expect(apocalypse.locator('dd[lang="zh-CN"]')).toHaveCount(7);
    await expect(apocalypse.locator('.skills-example')).toHaveText(genres.find(genre => genre.id === 'apocalypse')!.example);
    await apocalypse.locator('.skills-category-paths > summary').click();
    await expect(apocalypse.locator('.skills-category-paths ul')).toContainText('番茄');
    if (prefix) await expect(apocalypse.locator('.skills-method-note')).toContainText('written in Chinese');

    await page.locator('[data-skills-reset]').click();
    await page.locator('[data-skills-family]').selectOption('历史军事');
    await expect(page.locator('[data-suite-id="military"]')).toBeVisible();
    await expect(page.locator('[data-suite-id="apocalypse"]')).toBeHidden();
    const historyCount = suites.filter(suite => suite.family === '历史军事').length;
    await expect(page.locator(visibleCards)).toHaveCount(historyCount);
    await expect(page.locator('[data-skills-count]')).toHaveText(`${historyCount}${prefix ? ' suites' : ' 套题材套件'}`);
  });

  for (const width of [375, 1440]) {
    test(`${locale} 目录在 ${width}px 展开方法后可阅读`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width, height: 960 });
      await page.goto(`${prefix}/integrations/`);
      await page.locator('[data-skills-search]').fill(prefix ? 'military' : '军事');
      const military = page.locator('[data-suite-id="military"]');
      await military.locator('.skills-methods > summary').click();
      await military.locator('.skills-category-paths > summary').click();
      await expect(military.locator('dd').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
      await page.locator('[data-skills-catalog]').screenshot({ path: `test-results/skills-${locale}-${width}.png` });
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
      expect(await article.innerText()).not.toMatch(/\b(?:MCP|JSON|CLI|stdio|API)\b/);
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
    await page.goto(`${prefix}/docs/download-and-install/`);
    await expect(page.locator('.doc-article')).toContainText('./dev-mac.command --check');
    await expect(page.locator('.doc-article')).toContainText('./dev-mac.command');
    for (const href of await page.locator('.doc-article a').evaluateAll(links => links.map(link => link.getAttribute('href')!))) {
      if (href.startsWith('/')) expect((await request.get(href)).status(), href).toBe(200);
    }
    expect(errors).toEqual([]);
  });
}
