import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import artwork from '../../../assets/marketing/plugin-artwork.json' with { type: 'json' };
import listings from '../src/data/plugin-listings.json' with { type: 'json' };

const slugs = ['relationships', 'timeline', ...listings.map(item => item.slug)];

test('每个插件都有独立生成的宣传图和完整来源，网站制品逐字节一致', async () => {
  expect(artwork.images.map(image => image.slug).sort()).toEqual(slugs.slice().sort());
  expect(new Set(artwork.images.map(image => image.sha256)).size).toBe(slugs.length);
  for (const image of artwork.images) {
    expect(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']).toContain(image.model);
    expect(image.prompt.length).toBeGreaterThan(100);
    expect(image.source_sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const variant of image.variants) {
      const bytes = readFileSync(new URL('../public' + variant.path, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(variant.sha256);
      expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
    }
  }
});

for (const prefix of ['', '/en']) for (const width of [375, 768, 1440]) {
  test(`${prefix || 'zh-CN'} ${width}px 宣传图完整加载，卡片与工作面分开展示`, async ({page}) => {
    await page.setViewportSize({width,height:960});
    const errors: string[] = []; page.on('pageerror',error=>errors.push(error.message));
    await page.goto(prefix+'/plugins/',{waitUntil:'domcontentloaded'});
    const figures=page.locator('.plugin-card [data-plugin-artwork]');
    await expect(figures).toHaveCount(slugs.length);
    await expect(page.locator('.plugin-card .plugin-visual')).toHaveCount(0);
    for (const slug of slugs) {
      const image=page.locator(`[data-plugin-artwork="${slug}"] img`);
      await image.scrollIntoViewIfNeeded();
      await expect(image).toHaveAttribute('alt', /.+/);
      expect(await image.evaluate(async (image:HTMLImageElement)=>{await image.decode();return image.naturalWidth>0&&image.naturalHeight>0;})).toBe(true);
      const box=await image.boundingBox();expect(box!.width/box!.height).toBeCloseTo(1.5,1);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.locator('[data-plugin-search]').fill('script-supervisor');
    await expect(page.locator('.plugin-card:visible')).toHaveCount(1);
    await page.locator('.plugin-card:visible > a').click();
    await expect(page.locator('.plugin-detail-hero [data-plugin-artwork="script-supervisor"] img')).toBeVisible();
    await expect(page.locator('[data-plugin-workspace] img')).toHaveAttribute('src','/plugins/script-supervisor.png');
    await page.screenshot({path:`test-results/artwork-detail-${prefix?'en':'zh'}-${width}.png`,fullPage:true});
  });
}

for (const slug of slugs) for (const prefix of ['', '/en']) test(`${prefix || 'zh-CN'} ${slug} 宣传图与分享图片对应当前插件`,async({page,request})=>{
  const image=artwork.images.find(image=>image.slug===slug)!;
  await page.goto(prefix+'/plugins/'+slug+'/',{waitUntil:'domcontentloaded'});
  const hero=page.locator('.plugin-detail-hero [data-plugin-artwork] img');
  await expect(hero).toHaveAttribute('src',image.path);
  await expect(hero).toHaveAttribute('alt',image.alt[prefix?'en':'zh-CN']);
  expect(await hero.evaluate(async(image:HTMLImageElement)=>{await image.decode();return image.complete&&image.naturalWidth>0;})).toBe(true);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content','https://hetu.limeai.run'+image.path);
  const response=await request.get(image.path);expect(response.status()).toBe(200);
  expect(createHash('sha256').update(await response.body()).digest('hex')).toBe(image.sha256);
});
