import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const repo = new URL('../../../', import.meta.url);
const out = new URL('output/design/', repo);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 1 });
  const origin = process.env.HETU_DESIGN_ORIGIN || 'http://127.0.0.1:4351';
  for (const locale of ['zh-CN', 'en']) {
    const suffix = locale === 'en' ? '-en' : '';
    await page.goto(new URL(locale === 'en' ? '/en/' : '/', origin).href);
    await page.locator('.demo-book-card').first().waitFor();
    await page.locator('.demo-app img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await page.locator('.demo-app').screenshot({ path: fileURLToPath(new URL(`prototype-desktop${suffix}.png`, out)) });
    await page.locator('.hero-art').evaluate(image => image.decode());
    await page.screenshot({ path: fileURLToPath(new URL(`prototype-website${suffix}.png`, out)) });
  }
  console.log('已从中英文首页导出当前书库演示与官网界面图。');
} finally { await browser.close(); }
