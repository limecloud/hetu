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
      // 逐段访问，确保中段懒加载图片也进入过视口；直接跳到页尾不会请求它们。
      for (const image of await page.locator('img').all()) await image.scrollIntoViewIfNeeded();
      await expect.poll(() => page.locator('img').evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
      const distorted = await page.locator('img').evaluateAll(images => images.flatMap(image => {
        if (!(image instanceof HTMLImageElement)) return [];
        const rect = image.getBoundingClientRect();
        const difference = Math.abs((rect.width / rect.height) / (image.naturalWidth / image.naturalHeight) - 1);
        return difference > .02 && getComputedStyle(image).objectFit === 'fill' ? [{ source: image.getAttribute('src'), width: rect.width, height: rect.height }] : [];
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

test('英文首页原型使用英文演示内容，切换界面不翻译正文', async ({ page }) => {
  await page.goto('/en/');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /social-og-en\.png$/);
  await page.locator('.hero-actions a').first().click();
  await expect(page).toHaveURL(/\/en\/#prototype$/);
  await page.locator('[data-action="open-book"][data-book="0"]').click();
  const manuscript = await page.locator('[name="manuscript"]').inputValue();
  expect(manuscript).toContain('Rain had been falling');
  await page.locator('[data-action="language"]').click();
  await expect(page.locator('.demo')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('[name="manuscript"]')).toHaveValue(manuscript);
  await page.goto('/en/brand/');
  await expect(page.locator('img[src="/images/prototype-mobile-en.webp"]')).toHaveCount(1);
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

test('首页原型区分保存、参考稿审核、局部采纳与作者独立定稿', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#prototype');
  await page.locator('[data-action="open-book"][data-book="0"]').click();
  const text = page.locator('[name="manuscript"]');
  const original = await text.inputValue();
  await text.fill(original + '\n中文输入测试。');
  await expect(page.locator('[data-save-state]')).toHaveText('未保存');
  await page.locator('[data-action="finalize"]').click();
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.locator('.demo-feedback')).toContainText('请先保存');
  await page.locator('[data-action="save"]').click();
  await page.locator('[data-action="chapter"][data-chapter="1"]').click();
  await page.locator('[data-action="chapter"][data-chapter="0"]').click();
  await expect(text).toHaveValue(original + '\n中文输入测试。');
  await page.locator('[data-view="validation"]').click();
  await page.locator('[data-action="source"]').click();
  await page.locator('[data-action="locate"]').click();
  expect(await text.evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd))).toBe('旧玉扣');
  await page.locator('[data-view="bible"]').click();
  await page.locator('[data-action="lock"]').click();
  await expect(page.locator('.demo-content .demo-badge').first()).toHaveText('已解锁');
  await page.locator('[data-view="reviews"]').click();
  await page.locator('[data-action="changes"]').click();
  await expect(page.locator('#demo-review-state')).toHaveText('待审核');
  await page.locator('[name="comment"]').fill('补充玉扣的细节，保留其余正文。');
  await page.locator('[data-action="changes"]').click();
  await expect(page.locator('#demo-review-state')).toHaveText('要求修改');
  await page.locator('[data-action="approve"]').click();
  await expect(page.locator('#demo-review-state')).toHaveText('要求修改');
  await page.locator('[name="evidence"]').check();
  await page.locator('[data-action="approve"]').click();
  await expect(page.locator('#demo-review-state')).toHaveText('审核通过');
  await page.locator('[data-view="novel"]').click();
  await expect(text).toHaveValue(original + '\n中文输入测试。');
  await expect(page.locator('[data-final-state]')).toHaveText('尚未定稿');
  await page.locator('[data-view="reviews"]').click();
  await page.locator('[data-action="adopt"]').click();
  await expect(page.locator('dialog')).toBeVisible();
  await page.locator('dialog button[type="submit"]').click();
  await expect(text).toHaveValue((original + '\n中文输入测试。').replace('旧玉扣', '纹路斑驳的旧玉扣'));
  await expect(page.locator('[data-final-state]')).toHaveText('尚未定稿');
  await page.locator('[data-view="reviews"]').click();
  await page.locator('[data-action="adopt"]').click();
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.locator('.demo-feedback')).toContainText('已采纳');
  await page.locator('[data-view="novel"]').click();
  await page.locator('[data-action="finalize"]').click();
  await page.locator('[name="final-evidence"]').check();
  await page.locator('dialog button[type="submit"]').click();
  await expect(page.locator('[data-final-state]')).toHaveText('当前修订已定稿');
  await text.fill((await text.inputValue()) + '\n继续修改。');
  await expect(page.locator('[data-final-state]')).toHaveText('旧定稿仍保留');
  await page.locator('[data-action="save"]').click();
  await expect(page.locator('[data-final-state]')).toHaveText('旧定稿仍保留');
  await page.locator('[data-view="git"]').click();
  await page.locator('[data-action="snapshot"]').click();
  await page.locator('dialog button[type="submit"]').click();
  await expect(page.locator('.demo-history')).toContainText('作者确认的演示快照');
  await expect(page).toHaveURL(/\/#prototype$/);
  expect(errors).toEqual([]);
});

test('书库搜索筛选、作品隔离、未命名筹备和新建章节', async ({ page }) => {
  await page.goto('/#prototype');
  await page.locator('[name="search"]').fill('不存在的作品');
  await expect(page.locator('.demo-book-card')).toHaveCount(0);
  await expect(page.locator('.demo-empty')).toBeVisible();
  await page.locator('[name="search"]').fill('');
  await page.locator('[data-filter="planning"]').click();
  await expect(page.locator('.demo-book-card')).toHaveCount(1);
  await page.locator('[data-filter="all"]').click();
  await page.locator('[data-action="layout"]').click();
  await expect(page.locator('.demo-books')).toHaveClass(/demo-list/);
  await page.locator('[data-action="open-book"][data-book="0"]').click();
  const original = await page.locator('[name="manuscript"]').inputValue();
  await page.locator('[name="manuscript"]').fill(original + '\n未保存的修改。');
  await page.locator('[data-action="library"]').click();
  await page.locator('[data-action="open-book"][data-book="1"]').click();
  await expect(page.locator('[name="manuscript"]')).not.toHaveValue(original);
  await page.locator('[data-view="bible"]').click();
  await expect(page.locator('.demo-content')).toContainText('当前作品尚无相关记录');
  await expect(page.locator('.demo-content')).not.toContainText('林舟');
  await page.locator('[data-action="library"]').click();
  await page.locator('[data-action="open-book"][data-book="0"]').click();
  await expect(page.locator('[name="manuscript"]')).toHaveValue(original + '\n未保存的修改。');
  await page.locator('[data-action="library"]').click();
  await page.locator('[data-action="new-book"]').click();
  await page.locator('dialog button[type="submit"]').click();
  await expect(page.locator('[name="title"]')).toHaveValue('未命名作品');
  await page.locator('[name="title"]').fill('新故事');
  await page.locator('[data-form="details"] button[type="submit"]').click();
  await expect(page.locator('.demo-context')).toHaveText('新故事');
  await page.locator('[data-view="novel"]').click();
  await page.locator('[data-action="new-chapter"]').click();
  await page.locator('[name="new-title"]').fill('第一章 开始');
  await page.locator('dialog button[type="submit"]').click();
  await expect(page.locator('.demo-document-head h3')).toHaveText('第一章 开始');
  await page.reload();
  await expect(page.locator('.demo-book-card')).toHaveCount(3);
});

test('原型无独立页面，手机可切章节、审核和主题', async ({ page, request }) => {
  for (const target of ['/brand/favicon.ico', '/brand/manifest.webmanifest', '/images/social-og.png', '/sitemap.xml']) {
    expect((await request.get(target)).status()).toBe(200);
  }
  for (const target of ['/prototype/index.html', '/prototype/workbench.html', '/this-page-does-not-exist/']) {
    expect((await request.get(target)).status()).toBe(404);
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#prototype');
  await page.locator('[data-action="open-book"][data-book="0"]').click();
  await page.locator('[data-action="chapter"][data-chapter="1"]').click();
  await expect(page.locator('.demo-document-head')).toContainText('第二章');
  await page.locator('[data-action="theme"]').click();
  await expect(page.locator('.demo')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('[name="manuscript"]')).toBeVisible();
  await page.locator('[data-view="reviews"]').click();
  await expect(page.locator('[name="comment"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/demo-mobile-dark.png', fullPage: true });
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


test('固定引文在当前文字变化后保留，定位失败不选择替代位置', async ({ page }) => {
  await page.goto('/#prototype');
  await page.locator('[data-action="open-book"][data-book="0"]').click();
  await page.locator('[name="manuscript"]').fill('当前写作稿已更换了道具。');
  await page.locator('[data-action="save"]').click();
  await page.locator('[data-view="validation"]').click();
  await page.locator('[data-action="source"]').click();
  await expect(page.locator('.demo-source')).toContainText('他摸了摸怀里的旧玉扣');
  await page.locator('[data-action="locate"]').click();
  await expect(page.locator('.demo-feedback')).toContainText('原文片段已变化');
  await expect(page.locator('[name="manuscript"]')).toHaveValue('当前写作稿已更换了道具。');
  await page.locator('[data-action="new-chapter"]').click();
  await expect(page.locator('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.locator('[data-action="new-chapter"]')).toBeFocused();
});

for (const locale of ['zh-CN', 'en']) {
  for (const width of [375, 1440]) {
    test(`${locale} ${width}px 安装入口共享题材套件状态并保留作品关联`, async ({ page }) => {
      const errors: string[] = [], writes: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
      await page.setViewportSize({ width, height: 960 });
      await page.goto(locale === 'en' ? '/en/#prototype' : '/#prototype');
      const demo = page.locator('.demo');
      await demo.locator('[data-action="settings"]').click();
      await demo.locator('[name="agent-client"]').selectOption('workbuddy');
      await demo.locator('[name="agent-suite"]').selectOption('military');
      await demo.locator('[data-action="install-agent"]').click();
      await expect(page.locator('dialog [name="agent-client"]')).toHaveValue('workbuddy');
      await expect(page.locator('dialog .demo-agent-skills li')).toHaveCount(8);
      await page.locator('dialog button[type="submit"]').click();
      await expect(demo.locator('[data-agent-version]')).toHaveText('0.1.0');
      await demo.locator('[data-action="new-book"]').click();
      await expect(page.locator('dialog [name="agent-client"]')).toHaveValue('workbuddy');
      await expect(page.locator('dialog [name="agent-suite"]')).toHaveValue('general');
      await page.locator('dialog [name="new-title"]').fill('独立创作 Book');
      await page.locator('dialog [name="new-author"]').fill('作者 Author');
      await page.locator('dialog [name="agent-client"]').selectOption('codex');
      await page.locator('dialog [name="agent-suite"]').selectOption('military');
      await page.locator('dialog [data-action="install-agent"]').click();
      await page.locator('dialog [name="agent-client"]').selectOption('other');
      await expect(page.locator('dialog button[type="submit"]')).toBeDisabled();
      await page.locator('dialog [name="agent-client"]').selectOption('codex');
      expect(await page.locator('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.locator('dialog button[type="submit"]').click();
      await expect(page.locator('dialog [name="new-title"]')).toHaveValue('独立创作 Book');
      await expect(page.locator('dialog [name="new-author"]')).toHaveValue('作者 Author');
      await expect(page.locator('dialog [data-agent-version]')).toHaveText('0.1.0');
      await page.locator('dialog button[type="submit"]').click();
      await expect(demo.locator('[name="agent-client"]')).toHaveValue('codex');
      await expect(demo.locator('[name="agent-suite"]')).toHaveValue('military');
      await demo.locator('[data-action="cover-install"]').click();
      await expect(page.locator('dialog [name="agent-suite"]')).toHaveValue('military');
      await page.keyboard.press('Escape');
      await expect(demo.locator('[data-action="cover-install"]')).toBeFocused();
      await demo.locator('[name="agent-client"]').selectOption('workbuddy');
      await expect(demo.locator('[data-agent-version]')).toHaveText('0.1.0');
      await demo.locator('[name="agent-suite"]').selectOption('general');
      await expect(demo.locator('[data-agent-state]')).toContainText(locale === 'en' ? 'not installed' : '未安装');
      await demo.locator('[data-action="library"]').click();
      await demo.locator('[data-action="open-book"][data-book="0"]').click();
      await demo.locator('[data-view="book"]').click();
      await expect(demo.locator('[name="agent-client"]')).toHaveValue('codex');
      await expect(demo.locator('[name="agent-suite"]')).toHaveValue('general');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(page).toHaveURL(/#prototype$/);
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}
