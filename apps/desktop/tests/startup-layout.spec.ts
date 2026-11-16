import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const root = path.resolve(import.meta.dirname, "../../..");

test("启动页限制品牌图尺寸并加载完整浅暗布局", async ({}, testInfo) => {
  // 覆盖独立应用冷启动与退出，不与单页交互共用较短预算。
  test.setTimeout(240000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "hetu-startup-layout-"));
  const executable = process.env.HETU_PACKAGED_APP;
  const application = await electron.launch({
    ...(executable ? { executablePath: executable, args: process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : [] } : { args: [path.join(root, "apps/desktop")] }),
    env: { ...process.env, HETU_DESKTOP_PROFILE: profile },
  });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.getByRole("button", { name: "刷新创作库", exact: true })).toBeEnabled();
    for (const [width, height, appearance] of [[1360, 850, "light"], [960, 800, "dark"]] as const) {
      await page.setViewportSize({ width, height });
      // 新偏好默认跟随系统；媒体模拟也能承受异步偏好回读。
      await page.emulateMedia({ colorScheme: appearance });
      await expect(page.locator(".project-navigation")).toHaveCSS(
        "background-color", appearance === "dark" ? "rgb(16, 18, 17)" : "rgb(251, 253, 252)",
      );
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: testInfo.outputPath(`startup-${appearance}.png`) });
      const layout = await page.evaluate(() => {
        const icon = document.querySelector<HTMLImageElement>(".brand-icon")!;
        const bar = document.querySelector(".workbench-topbar")!;
        const nav = document.querySelector(".project-navigation")!;
        const button = [...document.querySelectorAll("button")].find(element => element.textContent === "打开作品")!;
        const rectangle = (element: Element) => {
          const value = element.getBoundingClientRect();
          return { x: value.x, y: value.y, width: value.width, height: value.height };
        };
        return {
          icon: rectangle(icon), decoded: icon.complete && icon.naturalWidth > 0,
          bar: rectangle(bar), nav: rectangle(nav), button: rectangle(button),
          background: getComputedStyle(nav).backgroundColor,
          border: getComputedStyle(bar).borderBottomWidth,
          overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
        };
      });
      await testInfo.attach(`layout-${appearance}`, { body: JSON.stringify(layout), contentType: "application/json" });
      expect(layout.decoded).toBe(true);
      expect(layout.icon.width).toBe(32);
      expect(layout.icon.height).toBe(32);
      expect(layout.bar.height).toBe(60);
      expect(layout.icon.y).toBeGreaterThanOrEqual(0);
      expect(layout.icon.y + layout.icon.height).toBeLessThanOrEqual(layout.bar.height);
      expect(layout.nav.y).toBe(layout.bar.height);
      expect(layout.nav.width).toBe(190);
      expect(layout.button.height).toBeGreaterThanOrEqual(32);
      expect(layout.button.x + layout.button.width).toBeLessThanOrEqual(width);
      // 低像素密度屏幕会将0.5px边框量化到一个物理像素。
      expect(Number.parseFloat(layout.border)).toBeGreaterThanOrEqual(0.5);
      expect(Number.parseFloat(layout.border)).toBeLessThanOrEqual(1);
      expect(layout.background).toBe(appearance === "dark" ? "rgb(16, 18, 17)" : "rgb(251, 253, 252)");
      expect(layout.overflow).toBe(false);
    }
    expect(errors).toEqual([]);
  } finally {
    await application.close();
  }
});
