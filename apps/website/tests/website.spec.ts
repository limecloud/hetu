import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import manifest from '../../../assets/manifest.json' with { type: 'json' };
import guideCaptures from '../assets/guides/captures.json' with { type: 'json' };

for (const prefix of ['', '/en']) for (const width of [375, 1440]) {
  test(`${prefix || 'zh-CN'} ${width}px 内页导航、阅读和资源布局完整`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 960 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const path of ['workflow', 'integrations', 'docs', 'faq', 'brand', 'blog', 'blog/agent-work-author-review', 'blog/authors-at-the-center', 'blog/story-to-screen', 'blog/agent-friendly', 'docs/adaptation', 'docs/plugin-development']) {
      await page.goto(`${prefix}/${path}/`);
      await expect(page.locator('main h1'), path).toHaveCount(1);
      await expect(page.locator('main .eyebrow'), path).toHaveCount(0);
      await expect(page.locator('main'), path).not.toContainText('·');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
      const sizes = await page.locator('body *').evaluateAll(elements => [...new Set(elements.filter(element => element.checkVisibility() && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())).map(element => getComputedStyle(element).fontSize))]);
      // 长文阅读采用16px正文，其余导航和标题沿用整站字号。
      const documentation = path === 'docs' || path.startsWith('docs/');
      const scale = documentation ? ['12px', '14px', '16px', '24px', '40px'] : ['12px', '14px', '24px', '40px'];
      expect(sizes.length, `${path}: ${sizes.join(', ')}`).toBeLessThanOrEqual(scale.length);
      expect(sizes.every(size => scale.includes(size)), path).toBe(true);
      for (const image of await page.locator('main img').all()) {
        await image.scrollIntoViewIfNeeded();
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0), { message: `${path}: image loads` }).toBe(true);
      }
      await page.evaluate(() => scrollTo(0, 0));
      if (path === 'integrations') {
        const positions = await page.locator('.integration-journey, #skills-catalog').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
        expect(positions[0]).toBeLessThan(positions[1]);
        await expect(page.locator('.collaboration-map')).toContainText(prefix ? 'Taste. Judgment. Creative intent.' : '品味、判断、创意');
      }
      if (path === 'faq') {
        await expect(page.locator('.faq-groups section')).toHaveCount(3);
        await expect(page.locator('.faq-list details')).toHaveCount(9);
        await page.locator('.faq-nav a').last().click();
        await expect(page.locator('#questions-2')).toBeInViewport();
      }
      if (path.startsWith('blog/')) {
        if (width === 375) await page.locator('.journal-toc-mobile summary').click();
        const tocLinks = page.locator('.journal-toc a:visible');
        expect(await tocLinks.count()).toBeGreaterThan(0);
        await tocLinks.last().click();
        const target = await tocLinks.last().getAttribute('href');
        await expect(page.locator(target!)).toBeInViewport();
      }
      if (path === 'docs/adaptation') await expect(page.locator('.doc-nav-group a[aria-current="page"]:visible')).toHaveCount(width === 375 ? 0 : 1);
    }
    expect(errors).toEqual([]);
  });
}

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
      for (const image of await page.locator('img:visible').all()) await image.scrollIntoViewIfNeeded();
      await expect.poll(() => page.locator('img:visible').evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
      const distorted = await page.locator('img:visible').evaluateAll(images => images.flatMap(image => {
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

test('双语品牌展示、下载、分享卡与Electron截图使用当前资产版本', async ({ page, request }) => {
  test.setTimeout(120_000);
  const requested = new Set<string>();
  const resources = new Map<string, URL>();
  page.on('request', request => requested.add(request.url()));
  for (const prefix of ['', '/en']) for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(prefix + '/brand/');
    for (const image of await page.locator('main img').all()) await image.scrollIntoViewIfNeeded();
    const urls = await page.locator('main img, .brand-downloads a, .brand-gallery a, meta[property="og:image"]').evaluateAll(elements => elements.map(element => element.getAttribute('src') ?? element.getAttribute('href') ?? element.getAttribute('content')));
    for (const href of urls) {
      if (!href || href.includes('#')) continue;
      const url = new URL(href, page.url());
      expect(url.searchParams.get('v'), href).toMatch(/^[a-f0-9]{16}$/);
      resources.set(url.pathname + url.search, url);
    }
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0); });
    await page.screenshot({ path: `test-results/brand-version-${prefix ? 'en' : 'zh-CN'}-${width}.png`, fullPage: true });
    await page.goto(prefix + '/#prototype');
    const preview=page.locator('[data-workbench-preview]');
    await expect(preview.getByRole('tab')).toHaveCount(4);
    for(const tab of await preview.getByRole('tab').all()) {
      await tab.click();
      const image=preview.locator('[data-workbench-panel]:visible img');
      await expect.poll(()=>image.evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth===1440)).toBe(true);
      const url=new URL((await image.getAttribute('src'))!,page.url());
      expect(url.searchParams.get('v')).toMatch(/^[a-f0-9]{16}$/);
      resources.set(url.pathname+url.search,url);
    }
  }
  const entries = [...resources];
  for (let index = 0; index < entries.length; index += 4) {
    await Promise.all(entries.slice(index, index + 4).map(async ([href, url]) => {
      const response = await request.get(href, { timeout: 15_000 });
      expect(response.status(), href).toBe(200);
      const digest = createHash('sha256').update(await response.body()).digest('hex');
      expect(digest.slice(0, 16), href).toBe(url.searchParams.get('v'));
      if (url.pathname !== '/resources/manifest.json') {
        const filename = url.pathname.split('/').at(-1)!;
        const expectedDigest = url.pathname.startsWith('/images/guides/')
          ? guideCaptures[filename as keyof typeof guideCaptures]?.sha256
          : manifest.assets.find(asset => url.pathname.endsWith('/' + asset.path.split('/').at(-1)))?.sha256;
        expect(expectedDigest, href).toBe(digest);
      }
    }));
  }
});

test('使用指南完整双语，工程文档及源副本不对外发布', async ({ page, request }) => {
  test.setTimeout(120_000);
  const slugs = ['getting-started', 'install', 'creative-paths', 'codex-first-task', 'skills', 'writing', 'story-bible', 'adaptation', 'screenplays', 'video', 'review', 'formats-and-delivery', 'agents', 'references', 'data-and-backup', 'creative-library', 'import-manuscript', 'outlining', 'characters-and-scenes', 'cover-art', 'illustrations', 'feedback', 'model-services', 'privacy-and-permissions', 'troubleshooting', 'plugins', 'plugin-development', 'plugin-publishing'];
  for (const prefix of ['', '/en']) {
    await page.goto(`${prefix}/docs/`);
    await expect(page.locator('.doc-index a')).toHaveCount(slugs.length);
    await expect(page.locator('main')).not.toContainText(/产品需求 PRD|产品与工程文档|研究与官方资料/);
    for (const slug of slugs) {
      await page.goto(`${prefix}/docs/${slug}/`);
      await expect(page.locator('.doc-article h1')).toHaveCount(1);
      await expect(page.locator('.doc-article')).toHaveAttribute('lang', prefix ? 'en' : 'zh-CN');
      if (prefix) expect(await page.locator('.doc-article').innerText()).not.toMatch(/\p{Script=Han}/u);
      if (slug === 'getting-started') await expect(page.locator('.doc-article img')).toHaveCount(4);
      if (slug !== 'plugin-development') {
        await expect(page.locator('.doc-article pre, .doc-article .mermaid')).toHaveCount(0);
      } else {
        await expect(page.locator('.doc-article pre')).not.toHaveCount(0);
        await expect(page.locator('.doc-article a[href="https://github.com/limecloud/hetu#快速上手"]')).toHaveCount(1);
      }
    }
  }
  const sitemap = await (await request.get('/sitemap.xml')).text();
  expect(sitemap).not.toMatch(/\/research\/|\/docs\/\d{2}\/|\/docs\/download-and-install\//);
  for (const path of ['/docs/download-and-install/', '/en/docs/download-and-install/', '/docs/01/', '/en/docs/30/', '/research/01/', '/en/research/01/', '/sources/docs/README.md', '/sources/docs/01-%E4%BA%A7%E5%93%81%E9%9C%80%E6%B1%82PRD.md']) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
});

test('旧原型路径返回404，稳定入口展示当前Electron界面', async ({page,request})=>{
  for(const target of ['/brand/favicon.ico','/brand/manifest.webmanifest','/images/social-og.png','/sitemap.xml']) expect((await request.get(target)).status()).toBe(200);
  for(const target of ['/prototype/index.html','/prototype/workbench.html','/this-page-does-not-exist/']) expect((await request.get(target)).status()).toBe(404);
  await page.goto('/#prototype');
  await expect(page.locator('[data-workbench-preview]')).toBeVisible();
  await expect(page.locator('.demo-app,[data-action="adopt"],[data-action="finalize"]')).toHaveCount(0);
});

test('使用指南在桌面和手机布局可读', async ({ page }) => {
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto('/docs/');
    await expect(page.locator('h1')).toHaveText('河图洛书使用文档');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/guides-${width}.png`, fullPage: true });
    await page.goto('/docs/writing/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width === 375) {
      await page.locator('.doc-mobile-nav summary').click();
      await expect(page.locator('.doc-mobile-nav nav')).toBeVisible();
      await expect(page.locator('.doc-mobile-nav').getByRole('link', { name: '维护设定集', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await page.locator('.docs-sections').getByRole('link', { name: '设定与素材', exact: true }).click();
      await expect(page).toHaveURL('/docs/sections/assets/');
      await page.locator('.doc-section-guides').getByRole('link', { name: /维护设定集/ }).click();
      await expect(page.locator('.doc-article h1')).toHaveText('维护设定集');
    }
    await page.screenshot({ path: `test-results/guide-article-${width}.png`, fullPage: true });
  }
});
