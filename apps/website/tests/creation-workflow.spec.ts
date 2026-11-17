import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Chromium 长截图可能合成视口外的 fixed 链接；保留实际获得焦点的跳转链接。
const screenshotStyle = '.skip-link:not(:focus) { visibility: hidden; }';

test('品牌图标保留来源与原始文件摘要', () => {
  const directory = new URL('../src/assets/agents/', import.meta.url);
  const sources = JSON.parse(readFileSync(new URL('sources.json', directory), 'utf8'));
  expect(sources.logos).toHaveLength(13);
  for (const logo of sources.logos) {
    const bytes = readFileSync(new URL(logo.file, directory));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(logo.sha256);
    expect(logo.source_url).toMatch(/^https:\/\//);
    expect(bytes.toString()).toContain('<svg');
    expect(bytes.toString()).not.toMatch(/<script|<foreignObject|\sonload=/i);
  }
});

for (const prefix of ['', '/en']) {
  test(`${prefix || 'zh-CN'} 真实品牌图标与多客户端安装提示词联动`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const clients = [
      ['codex', 'Codex', 'Codex Plugin'],
      ['claude-code', 'Claude Code', prefix ? 'Skills & MCP' : 'Skills 与 MCP'],
      ['cursor', 'Cursor', prefix ? 'Skills & MCP' : 'Skills 与 MCP'],
      ['workbuddy', 'WorkBuddy', prefix ? 'Skills & connector' : 'Skills 与连接器'],
    ];
    for (const path of ['/#creation-workflow', '/workflow/#connect']) {
      await page.goto(prefix + path);
      const scope = page.locator('[data-agent-workflow]');
      await expect(scope.locator('[data-workflow-client]')).toHaveCount(4);
      for (const [id, name, method] of clients) {
        const selector = scope.locator(`[data-workflow-client="${id}"]`);
        await selector.focus();
        await page.keyboard.press('Enter');
        await expect(selector).toHaveAttribute('aria-pressed', 'true');
        await expect(scope).toHaveAttribute('data-client', id);
        for (const label of await scope.locator('[data-selected-agent-name]').all()) await expect(label).toHaveText(name);
        await scope.locator('[data-copy-install]').click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        expect(copied).toContain(prefix ? `connect ${name} to Hetu` : `把 ${name} 接入河图`);
        await expect(scope.locator('[data-install-status]')).toHaveText(prefix ? `Copied. Paste into ${name}.` : `已复制，粘贴给 ${name}。`);
        const icon = await selector.locator('img').getAttribute('src');
        for (const selected of await scope.locator('[data-selected-agent-icon]').all()) await expect(selected).toHaveAttribute('src', icon!);
        if (path.startsWith('/#')) {
          await expect(scope.locator('[data-selected-agent-method]')).toHaveText(method);
          await expect(scope.locator('[data-connect-prompt]')).toContainText(name);
          await scope.locator('#wf-panel-connect [data-workflow-step="1"]').click();
          await expect(scope.locator('#wf-panel-connect [data-wf-preview-line="0"]')).toHaveText(name);
        }
      }
      await expect(scope.locator('.wf-models li')).toHaveText(['OpenAI', 'Anthropic', 'Gemini', 'DeepSeek', 'GLM', 'Kimi', 'Qwen', prefix ? 'Doubao' : '豆包', prefix ? 'Hunyuan' : '混元']);
      await expect.poll(() => scope.locator('img[data-brand-logo]').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
      await expect(scope.locator('[data-workflow-client][aria-pressed="true"]')).toHaveCount(1);
    }
  });

  test(`${prefix || 'zh-CN'} 流程演示切换、逐步查看与作者审阅`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${prefix}/#creation-workflow`);
    const demo = page.locator('[data-workflow-demo]');
    const tabs = demo.getByRole('tab');
    await expect(tabs).toHaveCount(5);
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    const novel = page.locator('#wf-panel-novel');
    await expect(novel).toBeVisible();
    await novel.locator('[data-workflow-step="3"]').click();
    await expect(novel).toHaveAttribute('data-phase', '3');
    await expect(novel.locator('.wf-artifacts .is-current')).toContainText(prefix ? 'Chapter draft' : '章节参考稿');
    await novel.locator('[data-workflow-step]').last().click();
    await expect(novel.locator('[data-wf-core]')).toHaveText(prefix ? 'Awaiting review' : '待审阅');
    await expect(demo).toHaveAttribute('data-playing', 'false');
    await tabs.nth(3).click();
    const video = page.locator('#wf-panel-video');
    await expect(video.locator('.wf-film-frame')).toHaveCount(3);
    await video.locator('[data-workflow-step="3"]').click();
    await expect(video.locator('[data-wf-core]')).toContainText(prefix ? 'preview separately' : '预演单独审阅');
    await video.locator('[data-workflow-step]').last().click();
    await expect(video.locator('[data-wf-core]')).toHaveText(prefix ? 'Cut awaiting review' : '成片待审');
    expect(await video.locator('.wf-film-frame').evaluateAll(frames => frames.every(frame => getComputedStyle(frame).opacity === '1'))).toBe(true);
    await expect(video.locator('.wf-edit-tracks')).toBeVisible();
    await demo.locator('[data-workflow-detail]').click();
    await expect(page).toHaveURL(`${prefix}/workflow/#video`);
    await expect(page.locator('#video')).toBeVisible();
    await expect(page.locator('#novel')).toBeHidden();
    await page.locator('.header-actions .lang').click();
    await expect(page).toHaveURL(`${prefix ? '' : '/en'}/workflow/#video`);
    await expect(page.locator('#video')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test(`${prefix || 'zh-CN'} 安装提示词真实复制且失败可手动恢复`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${prefix}/workflow/#connect`);
    await page.locator('[data-copy-install]').click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('https://github.com/limecloud/hetu');
    expect(copied).toContain(prefix ? 'Do not read my creative library' : '不读取创作库');
    await expect(page.locator('[data-install-status]')).toHaveText(prefix ? 'Copied. Paste into Codex.' : '已复制，粘贴给 Codex。');
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Clipboard unavailable')) } }); });
    await page.locator('[data-copy-install]').click();
    await expect(page.locator('.wf-prompt-details')).toHaveAttribute('open', '');
    const prompt = page.locator('.wf-prompt-details textarea');
    await expect(prompt).toBeFocused();
    expect(await prompt.evaluate((text: HTMLTextAreaElement) => text.selectionEnd - text.selectionStart === text.value.length)).toBe(true);
    await expect(page.locator('[data-install-status]')).toHaveText(prefix ? 'Select and copy the prompt below.' : '请选择下方提示词复制。');
  });
}

test('动画离开视口暂停，暂停与减少动态效果保持当前阶段', async ({ page }) => {
  await page.clock.install();
  await page.goto('/#creation-workflow');
  const demo = page.locator('[data-workflow-demo]');
  const panel = page.locator('#wf-panel-connect');
  await demo.scrollIntoViewIfNeeded();
  await expect(demo).toHaveAttribute('data-playing', 'true');
  await page.clock.runFor(3500);
  await expect(panel).toHaveAttribute('data-phase', '1');
  await demo.locator('[data-workflow-play]').click();
  const paused = await panel.getAttribute('data-phase');
  await page.clock.runFor(7000);
  await expect(panel).toHaveAttribute('data-phase', paused!);
  await demo.locator('[data-workflow-play]').click();
  await page.evaluate(() => scrollTo(0, 0));
  await expect(demo).toHaveAttribute('data-playing', 'false');
  await page.clock.runFor(7000);
  await expect(panel).toHaveAttribute('data-phase', paused!);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await demo.scrollIntoViewIfNeeded();
  await demo.locator('[data-workflow-replay]').click();
  await page.clock.runFor(7000);
  await expect(panel).toHaveAttribute('data-phase', '0');
  await expect(demo).toHaveAttribute('data-playing', 'false');
  const animations = await demo.locator('.wf-wires path').evaluateAll(paths => paths.map(path => getComputedStyle(path).animationName));
  expect(animations.every(name => name === 'none')).toBe(true);
});

for (const prefix of ['', '/en']) for (const width of [375, 768, 1440]) {
  test(`${prefix || 'zh-CN'} ${width}px 五场景与完整流程视觉检查`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${prefix}/#creation-workflow`);
    const demo = page.locator('[data-workflow-demo]');
    for (const id of ['connect', 'novel', 'screenplay', 'video', 'revision']) {
      await page.locator(`[data-workflow-tab="${id}"]`).click();
      const panel = page.locator(`[data-workflow-scene="${id}"]`);
      await panel.locator('[data-workflow-step]').last().click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await panel.locator('.wf-steps').evaluate(steps => steps.scrollWidth <= steps.clientWidth)).toBe(true);
      await demo.screenshot({ path: `test-results/workflow-${prefix ? 'en' : 'zh'}-${width}-${id}.png`, style: screenshotStyle });
    }
    await page.locator('[data-workflow-client="claude-code"]').click();
    await page.locator('[data-agent-workflow]').screenshot({ path: `test-results/workflow-brands-${prefix ? 'en' : 'zh'}-${width}.png`, style: screenshotStyle });
    await page.goto(`${prefix}/workflow/#video`);
    await expect(page.locator('#video')).toBeVisible();
    await expect(page.locator('#screenplay')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // 从页顶截取，避免 Chromium 将视口上方的 fixed 跳转链接合成到长截图中。
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `test-results/workflow-full-${prefix ? 'en' : 'zh'}-${width}.png`, fullPage: true, style: screenshotStyle });
    const mapTabs = page.locator('[data-map-tab]');
    await mapTabs.last().focus();
    await page.keyboard.press('Home');
    await expect(page.locator('#novel')).toBeVisible();
    await expect(mapTabs.first()).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#screenplay')).toBeVisible();
  });
}
