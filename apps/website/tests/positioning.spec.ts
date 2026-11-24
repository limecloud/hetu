import {test,expect} from '@playwright/test';

for(const prefix of ['', '/en'])for(const width of [375,1440]){
  test(`${prefix||'zh-CN'} ${width}px 从适用判断进入真实例子和指南`,async({page})=>{
    await page.setViewportSize({width,height:960});await page.goto(prefix+'/');
    const hero=page.locator('.hero-actions');await hero.locator('a').first().click();
    await expect(page.locator('#review-experience')).toBeInViewport();
    await page.goto(prefix+'/');await hero.locator('a').nth(1).click();
    await expect(page.locator('#when-to-use')).toBeInViewport();
    await expect(page.locator('#when-to-use dl > div')).toHaveCount(3);
    await page.locator('#when-to-use > a').click();await expect(page).toHaveURL(prefix+'/docs/when-to-use/');
    await expect(page.getByRole('heading',{name:prefix?'Reading can be a complete task':'只读也是完整任务',exact:true}).first()).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.goto(prefix+'/blog/intentional-differences/');await expect(page.locator('main')).toContainText(prefix?'The witness may lie':'目击者可能说谎');
    await page.screenshot({path:`test-results/positioning-${prefix?'en':'zh'}-${width}.png`,fullPage:true});
  });
}
