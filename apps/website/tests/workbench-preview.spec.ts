import { test, expect } from '@playwright/test';
import captures from '../assets/guides/captures.json' with { type: 'json' };
import { createHash } from 'node:crypto';

for(const prefix of ['', '/en']) for(const width of [375,1440]) {
  test(`${prefix||'zh-CN'} ${width}px 当前Electron预览可切换、放大与返回`, async({page,request})=>{
    await page.setViewportSize({width,height:960});
    const writes:string[]=[],errors:string[]=[];
    page.on('request',r=>{if(r.method()!=='GET') writes.push(r.url());});
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`${prefix}/#prototype`);
    const root=page.locator('[data-workbench-preview]'),tabs=root.getByRole('tab');
    await expect(tabs).toHaveCount(4);
    await expect(root.locator('[data-workbench-panel]:visible')).toContainText(prefix?'Chinese interface':'示例资料');
    for(const [index,id] of ['library','novel','script','review'].entries()) {
      await tabs.nth(index).click();
      const panel=root.locator('[data-workbench-panel]:visible'),img=panel.locator('img');
      await expect(img).toHaveAttribute('src',new RegExp(`electron-${id}\\.webp\\?v=`));
      await expect.poll(()=>img.evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth===1440)).toBe(true);
      const response=await request.get((await img.getAttribute('src'))!);
      expect(response.status()).toBe(200);
      const capture=captures[`electron-${id}.webp` as keyof typeof captures];
      expect(capture.source).toBe('electron-development');
      expect(createHash('sha256').update(await response.body()).digest('hex')).toBe(capture.sha256);
      await panel.locator('[data-preview-zoom]').click();
      const dialog=root.locator('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('img')).toHaveAttribute('src',new URL((await img.getAttribute('src'))!,page.url()).href);
      expect(await dialog.evaluate(e=>e.getBoundingClientRect().width<=innerWidth)).toBe(true);
      if(width===375) {
        const canvas=dialog.locator('.workbench-zoom-canvas');
        expect(await canvas.evaluate(e=>e.scrollWidth>e.clientWidth)).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(panel.locator('[data-preview-zoom]')).toBeFocused();
    }
    await tabs.first().focus();
    await page.keyboard.press('End');
    await expect(tabs.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tabs.first()).toHaveAttribute('aria-selected','true');
    expect(writes).toEqual([]);expect(errors).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await root.screenshot({path:`test-results/electron-preview-${prefix?'en':'zh'}-${width}.png`});
    await root.locator('[data-workbench-panel]:visible .text-link').click();
    await expect(page).toHaveURL(`${prefix}/docs/creative-library/`);
  });
}

test('无JS时首张真实截图与原图链接可用',async({browser})=>{
  const page=await browser.newPage({javaScriptEnabled:false});
  await page.goto('/#prototype');
  const panel=page.locator('#workbench-panel-library');
  await expect(panel).toBeVisible();
  await expect(panel.locator('a[data-preview-zoom]')).toHaveAttribute('href',/electron-library\.webp\?v=/);
  await expect.poll(()=>panel.locator('img').evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth===1440)).toBe(true);
  await page.close();
});
