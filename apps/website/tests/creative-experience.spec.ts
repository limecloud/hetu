import { test, expect } from '@playwright/test';

for (const prefix of ['', '/en']) {
  test(`${prefix || 'zh-CN'} 成果可读、键盘切换与分镜手动预览`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${prefix}/`);
    const root = page.locator('[data-creative-results]');
    const tabs = root.getByRole('tab');
    await expect(root).toHaveAttribute('data-step','5');
    await root.locator('#result-panel-novel summary').click();
    await expect(root.locator('#result-panel-novel details')).toHaveAttribute('open','');
    await expect(root.locator('#result-panel-novel details p')).toContainText(prefix?'Qing looked':'沈青看着');
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(page.locator('#result-panel-screenplay')).toBeVisible();
    await page.keyboard.press('End');
    await expect(page.locator('#result-panel-video')).toBeVisible();
    await root.locator('[data-result-shot="1"]').click();
    await expect(root).toHaveAttribute('data-shot','1');
    await expect(root.locator('[data-result-shot="1"]')).toHaveAttribute('aria-pressed','true');
    await tabs.last().focus();
    await page.keyboard.press('Home');
    await expect(page.locator('#result-panel-novel')).toBeVisible();
    await expect(root.locator('[data-result-shot]')).toHaveCount(6);
    expect(new Set(await root.locator('[data-story-thumbnail]').evaluateAll(es=>es.map(e=>e.getAttribute('src')))).size).toBe(6);
  });

  test(`${prefix || 'zh-CN'} 三类意见与预置变体准确对应新版且不自动采用`, async ({ page }) => {
    await page.goto(`${prefix}/#review-experience`);
    const root = page.locator('[data-revision-demo]');
    const requests: string[] = [];
    page.on('request',request=>{if(request.method()!=='GET') requests.push(request.url());});
    for (const kind of ['novel','screenplay','video']) {
      await root.locator(`[data-review-tab="${kind}"]`).click();
      const panel=root.locator(`[data-review-panel="${kind}"]`);
      const originalNote=await panel.locator('[data-revision-note]').textContent();
      const originalAfter=await panel.locator('[data-revision-after]').textContent();
      await panel.locator('[data-revision-variant="1"]').click();
      if(kind==='video') {
        await expect(panel.locator('[data-revision-anchor]')).toHaveText('00:04–00:06');
        await expect(panel.locator('[data-revision-context]')).toHaveText(prefix?'Shot 03 / The letter':'第三镜 / 来信');
        await expect(panel.locator('[data-revision-shot="2"]')).toHaveAttribute('data-active','true');
      }
      await expect(panel.locator('[data-revision-note]')).not.toHaveText(originalNote!);
      await expect(panel.locator('[data-revision-after]')).not.toHaveText(originalAfter!);
      await expect(panel.locator('.revision-pending')).toHaveText(prefix?'Awaiting review':'待审阅');
      await expect(panel.locator('[data-revision-variant="0"]')).toHaveAttribute('aria-pressed','false');
      await expect(root).toHaveAttribute('data-step','4');
      await expect(root).toHaveAttribute('data-playing','false');
      await panel.locator('[data-revision-variant="0"]').click();
      await expect(panel.locator('[data-revision-after]')).toHaveText(originalAfter!);
    }
    expect(requests).toEqual([]);
    await expect(root.getByRole('button',{name:prefix?'Adopt':'采纳',exact:true})).toHaveCount(0);
    const layers=page.locator('[data-project-layers]');
    const tabs=layers.getByRole('tab');
    await tabs.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(layers.locator('#layer-panel-1')).toBeVisible();
    await page.keyboard.press('End');
    await expect(layers.locator('#layer-panel-4')).toBeVisible();
    await expect(layers.locator('#layer-panel-4')).toContainText('.pdf');
  });
}

test('成果展开一次后停止，主动暂停不会因重新入屏恢复', async ({ page })=>{
  await page.clock.install();
  await page.goto('/');
  const root=page.locator('[data-creative-results]');
  await root.scrollIntoViewIfNeeded();
  await expect(root).toHaveAttribute('data-playing','true');
  await page.clock.runFor(12200);
  await expect(root).toHaveAttribute('data-step','5');
  await expect(root).toHaveAttribute('data-playing','false');
  await root.locator('[data-motion-replay]').click();
  await page.clock.runFor(2500);
  await root.locator('[data-motion-play]').click();
  await expect(root).toHaveAttribute('data-step','1');
  await page.evaluate(()=>scrollTo(0,0));
  await page.clock.runFor(9000);
  await root.scrollIntoViewIfNeeded();
  await page.clock.runFor(5000);
  await expect(root).toHaveAttribute('data-step','1');
  await expect(root).toHaveAttribute('data-playing','false');
});

test('连续镜头实际换图与文案联动，手动浏览后保持暂停',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/');
  const root=page.locator('[data-creative-results]'),image=root.locator('.result-art > img');
  const shots=JSON.parse((await root.getAttribute('data-story-shots'))!);
  for(const [index,shot] of shots.entries()) {
    await root.locator(`[data-result-shot="${index}"]`).click();
    await expect(image).toHaveAttribute('src',shot.src);
    await expect(root.locator('[data-result-caption]')).toHaveText(shot.caption);
    await expect(root.locator('[data-result-frame-count]')).toHaveText(`${String(index+1).padStart(2,'0')} / 06`);
    await expect.poll(()=>image.evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth>0)).toBe(true);
  }
  await expect(root).toHaveAttribute('data-playing','false');
});

test('安装提示词折叠恢复内容高度，不留下展开占位',async({page})=>{
  await page.goto('/');
  const details=page.locator('.wf-showcase .wf-prompt-details');
  const section=page.locator('.wf-showcase');
  const before=(await section.boundingBox())!.height;
  await details.locator('summary').click();
  const expanded=(await section.boundingBox())!.height;
  expect(expanded-before).toBeGreaterThan(100);
  await details.locator('summary').click();
  expect(Math.abs((await section.boundingBox())!.height-before)).toBeLessThan(1);
  const gap=await page.locator('.wf-showcase,.revision-experience').evaluateAll(es=>es[1].getBoundingClientRect().top-es[0].getBoundingClientRect().bottom);
  expect(gap).toBeLessThanOrEqual(40);
  await expect(page.locator('.revision-storyboard')).toHaveCount(0);
});

test('后台与离屏停止推进，同屏共用一个播放焦点', async ({ page })=>{
  await page.clock.install();
  await page.goto('/');
  const root=page.locator('[data-revision-demo]');
  await root.scrollIntoViewIfNeeded();
  await expect(root).toHaveAttribute('data-playing','true');
  await page.clock.runFor(2900);
  const step=await root.getAttribute('data-step');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(root).toHaveAttribute('data-playing','false');
  await page.clock.runFor(10000);
  await expect(root).toHaveAttribute('data-step',step!);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(root).toHaveAttribute('data-playing','true');
  expect(await page.locator('[data-playing="true"]').count()).toBeLessThanOrEqual(1);
  await page.evaluate(()=>scrollTo(0,0));
  await expect(root).toHaveAttribute('data-playing','false');
  await page.clock.runFor(10000);
  await expect(root).toHaveAttribute('data-step',step!);
});

test('减少动态效果时内容完整，不运行持续动画', async ({ page })=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/');
  await expect(page.locator('[data-creative-results]')).toHaveAttribute('data-step','5');
  await expect(page.locator('[data-revision-demo]')).toHaveAttribute('data-step','4');
  expect(await page.locator('[data-playing="true"]').count()).toBe(0);
  const styles=await page.locator('.result-beat,.result-review-state,.revision-after').evaluateAll(es=>es.filter(e=>e.checkVisibility()).map(e=>({opacity:getComputedStyle(e).opacity,animation:getComputedStyle(e).animationName})));
  expect(styles.every(style=>style.opacity==='1'&&style.animation==='none')).toBe(true);
});

test('无JS与图片失败仍能阅读成果，山水首屏不被卡片遮挡', async ({ browser })=>{
  const page=await browser.newPage({javaScriptEnabled:false,viewport:{width:1440,height:960}});
  await page.route('**/images/ferry-*',route=>route.abort());
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('#result-panel-novel')).toContainText('最后一班渡船还没走');
  await expect(page.locator('#review-panel-novel [data-revision-after]')).toContainText('指腹停在最后一笔');
  await page.locator('#result-panel-novel summary').click();
  await expect(page.locator('#result-panel-novel details p')).toBeVisible();
  const bounds=await page.locator('.hero-stage,.creative-results').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().toJSON()));
  expect(bounds[1].top).toBeGreaterThanOrEqual(bounds[0].bottom);
  await page.close();
});

for (const prefix of ['', '/en']) for (const width of [375,768,1440]) {
  test(`${prefix||'zh-CN'} ${width}px 成果与比较视觉检查`, async ({page})=>{
    test.setTimeout(60_000);
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.setViewportSize({width,height:960});
    await page.goto(`${prefix}/`);
    for(const kind of ['novel','screenplay','video']) {
      await page.locator(`[data-result-tab="${kind}"]`).click();
      await page.locator(`[data-review-tab="${kind}"]`).click();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.locator('[data-revision-demo]').screenshot({path:`test-results/review-${prefix?'en':'zh'}-${width}-${kind}.png`});
    }
    await page.locator('#project-layers').screenshot({path:`test-results/layers-${prefix?'en':'zh'}-${width}.png`});
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:`test-results/scenery-${prefix?'en':'zh'}-${width}.png`});
  });
}
