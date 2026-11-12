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
  await page.goto(new URL('design/workbench.html?lang=en', repo).href);
  await page.locator('html[lang=en]').waitFor();
  await page.locator('.brand img').evaluate(image => image.decode());
  const text = await page.locator('body').innerText();
  const chinese = text.match(/\p{Script=Han}+/gu)?.filter(word => word !== '中文') || [];
  if (chinese.length) throw new Error('英文桌面原型含中文可见文案：' + chinese.join(', '));
  await page.screenshot({ path: fileURLToPath(new URL('prototype-desktop-en.png', out)) });
  console.log('已从英文原型导出桌面界面图。');
  if (process.env.HETU_DESIGN_ORIGIN) {
    await page.goto(new URL('/en/', process.env.HETU_DESIGN_ORIGIN).href);
    await page.locator('.hero-art').evaluate(image => image.decode());
    await page.screenshot({ path: fileURLToPath(new URL('prototype-website-en.png', out)) });
    console.log('已从英文网站导出宣传页界面图。');
  }
} finally { await browser.close(); }
