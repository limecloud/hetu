import { test, expect } from '@playwright/test';

for (const [locale, prefix] of [['zh-CN',''],['en','/en']] as const) {
  test(`${locale} 模型服务未配置与未连接`,async({page})=>{
    let configured=false;
    await page.route('**/api/hetu/**',route=>route.fulfill({status:configured?401:503,json:{error:{code:configured?'login_required':'service_unconfigured'}}}));
    await page.goto(prefix+'/console/');
    await expect(page.locator('[data-status]')).toContainText(locale==='en'?'not been configured':'尚未完成配置');
    await expect(page.locator('[data-login]')).toBeHidden();
    configured=true;await page.locator('[data-retry]').click();
    await expect(page.locator('[data-login]')).toBeVisible();
    await expect(page.locator('[data-session]')).toBeHidden();
  });
  test(`${locale} 模型目录、显式配对和退出清理`,async({page})=>{
    let signedIn=true,approved=0,loggedOut=0;
    const code='a'.repeat(64);
    await page.route('**/api/hetu/**',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(!signedIn)return route.fulfill({status:401,json:{error:{code:'login_required'}}});
      if(url.pathname.endsWith('/auth/logout')){expect(request.headers()['x-hetu-csrf']).toBe('csrf-test');loggedOut++;signedIn=false;return route.fulfill({json:{status:'signed_out'}});}
      if(url.pathname.endsWith('/session'))return route.fulfill({json:{name:'Author test',environment:'sandbox',csrf:'csrf-test',console_url:'https://console.test/account',open_url:'https://open.test'}});
      if(url.pathname==='/api/hetu/console/operations')return route.fulfill({json:{items:[],next_cursor:null}});
      if(url.pathname.includes('/connections/')){
        if(request.method()==='POST'){approved++;expect(request.headers()['x-hetu-csrf']).toBe('csrf-test');return route.fulfill({json:{status:'connected'}});}
        return route.fulfill({json:{label:'Hetu test',verification_code:'AAAAAAAA',connected:false}});
      }
      return route.fulfill({json:{items:[{id:url.pathname.endsWith('text')?'text-one':'image-one',billing:{credits_per_unit:'12'}}]}});
    });
    await page.goto(prefix+'/console/?connect='+code);
    await expect(page.locator('[data-view="connections"]')).toHaveAttribute('aria-current','page');
    expect(new URL(await page.locator('[data-language]').getAttribute('href') as string)).toHaveProperty('search','?connect='+code);
    await expect(page.locator('[data-name]')).toHaveText('Author test');await expect(page.locator('[data-code]')).toHaveText('AAAAAAAA');
    await expect(page.locator('[data-models="text"]')).toContainText('text-one');await expect(page.locator('[data-models="image"]')).toContainText('image-one');
    await page.locator('[data-view="models"]').click();await page.locator('[data-model-tab="text"]').focus();await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-model-tab="image"]')).toHaveAttribute('aria-selected','true');await expect(page.locator('[data-models="image"]')).toBeVisible();await expect(page.locator('[data-models="text"]')).toBeHidden();
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.locator('.site-footer')).toHaveCount(0);await page.locator('[data-view="connections"]').click();
    expect(approved).toBe(0);await page.locator('[data-confirm]').click();await expect(page.locator('[data-confirm]')).toBeDisabled();expect(approved).toBe(1);
    await page.locator('[data-view="connections"]').click();await page.locator('[data-logout]').click();await expect(page.locator('[data-session]')).toBeHidden();await expect(page.locator('[data-login]')).toBeVisible();expect(loggedOut).toBe(1);
    await expect(page.locator('[data-models="text"]')).toBeEmpty();
  });
  test(`${locale} 手机无横向溢出`,async({page})=>{
    await page.setViewportSize({width:390,height:844});await page.route('**/api/hetu/**',route=>route.fulfill({status:401,json:{error:{code:'login_required'}}}));
    await page.goto(prefix+'/console/');await expect(page.locator('[data-login]')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.locator('[data-view="connections"]')).toBeVisible();
  });
  test(`${locale} 河图控制台查询原操作与失权清理`,async({page})=>{
    let reads=0,revoked=false;
    await page.route('**/api/hetu/**',route=>{
      const request=route.request(),path=new URL(request.url()).pathname;expect(request.method()).toBe('GET');
      if(revoked)return route.fulfill({status:403,json:{error:{code:'permission_denied'}}});
      if(path.endsWith('/session'))return route.fulfill({json:{name:'History author',environment:'sandbox',csrf:'csrf-test',console_url:'https://console.test/account',open_url:'https://open.test'}});
      if(path.endsWith('/console/operations'))return route.fulfill({json:{items:[{operation_key:'original-01',model_id:'text-one',max_credits:'12',created_at:1700000000000}],next_cursor:null}});
      if(path.endsWith('/console/operations/original-01')){reads++;return route.fulfill({json:{status:'succeeded',operation_key:'original-01',model_id:'text-one'}});}
      return route.fulfill({json:{items:[]}});
    });
    await page.goto(prefix+'/console/');await page.locator('[data-view="history"]').click();await expect(page.locator('[data-history]')).toContainText('text-one');expect(reads).toBe(0);
    await page.locator('[data-history] button').click();await expect(page.locator('[data-history]')).toContainText(locale==='en'?'Completed':'已完成');expect(reads).toBe(1);
    revoked=true;await page.locator('[data-history-refresh]').click();await expect(page.locator('[data-session]')).toBeHidden();await expect(page.locator('[data-history]')).toBeEmpty();await expect(page.locator('[data-login]')).toBeVisible();
    expect(reads).toBe(1);
  });
  test(`${locale} 会员额度、独立连接和托管订阅入口`,async({page})=>{
    let connected=false,revoked=false;
    const subscription='https://console.test/billing/subscriptions?application=hetu&environment=sandbox';
    await page.route('**/api/hetu/**',route=>{
      const request=route.request(),path=new URL(request.url()).pathname;expect(request.method()).toBe('GET');
      if(revoked)return route.fulfill({status:401,json:{error:{code:'login_required'}}});
      if(path.endsWith('/session'))return route.fulfill({json:{name:'Member author',environment:'sandbox',csrf:'test',console_url:'https://console.test/account',subscription_url:subscription}});
      if(path.endsWith('/membership'))return connected?route.fulfill({json:{name:locale==='en'?'Author plan':'作者方案',status:'active',period_remaining:'80',pack_remaining:'20',period_end:'2026-12-01T00:00:00Z',payment_mode:'test'}}):route.fulfill({status:401,json:{error:{code:'membership_connection_required'}}});
      return route.fulfill({json:{items:[],next_cursor:null}});
    });
    await page.goto(prefix+'/console/#billing');await expect(page.locator('[data-view="billing"]')).toHaveAttribute('aria-current','page');
    await expect(page.locator('[data-membership-connect]')).toBeVisible();
    await expect(page.locator('[data-membership-connect]')).toHaveAttribute('href',`/api/hetu/auth/login?resource=membership&lang=${locale}`);
    await expect(page.locator('[data-subscription]')).toHaveAttribute('href',subscription);
    connected=true;await page.locator('[data-membership-refresh]').click();
    await expect(page.locator('[data-membership]')).toContainText('80 Credits');await expect(page.locator('[data-membership]')).toContainText(locale==='en'?'Test payment':'测试支付');
    await expect(page.locator('[data-membership-connect]')).toBeHidden();
    await page.screenshot({path:`../../output/model-service-qa/membership-${locale}-desktop.png`,fullPage:true});
    await page.setViewportSize({width:375,height:812});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`../../output/model-service-qa/membership-${locale}-mobile.png`,fullPage:true});
    revoked=true;await page.locator('[data-membership-refresh]').click();await expect(page.locator('[data-session]')).toBeHidden();
    await expect(page.locator('[data-membership]')).toBeEmpty();await expect(page.locator('[data-subscription]')).not.toHaveAttribute('href');
  });

}
