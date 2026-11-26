import {test, expect} from "@playwright/test";
import {renderedContrast} from "../../desktop/tests/fixtures/rendered-contrast.ts";

test("对比度叠合文字与祖先透明度，不将声明黑色当作实际黑色", async ({page}) => {
  await page.setContent('<html style="background:white"><body><span id="text" style="color:black;opacity:.5">文字</span><div style="opacity:.5;background:black"><span id="group" style="color:white">文字</span></div></body></html>');
  const text = await page.locator("#text").evaluate(renderedContrast);
  expect(text.unresolved).toEqual([]); expect(text.background).toEqual([255, 255, 255, 255]);
  expect(text.foreground).toEqual([127.5, 127.5, 127.5, 255]); expect(text.contrast).toBeLessThan(4.5);
  const group = await page.locator("#group").evaluate(renderedContrast);
  expect(group.foreground).toEqual([255, 255, 255, 255]); expect(group.background).toEqual([127.5, 127.5, 127.5, 255]);
  expect(group.contrast).toBeCloseTo(text.contrast, 8);
});

test("未知图像和滤镜不计对比通过，已由不透明控件覆盖的背景图不影响该控件", async ({page}) => {
  await page.setContent('<html style="background:white"><body><div style="background-image:linear-gradient(black,white)"><span id="unknown">文字</span><span id="opaque" style="background:white;color:black">文字</span></div><span id="filter" style="filter:brightness(.5)">文字</span></body></html>');
  expect((await page.locator("#unknown").evaluate(renderedContrast)).unresolved).toContain("background-image");
  const opaque = await page.locator("#opaque").evaluate(renderedContrast);
  expect(opaque.unresolved).toEqual([]); expect(opaque.contrast).toBe(21);
  expect((await page.locator("#filter").evaluate(renderedContrast)).unresolved).toContain("filter");
});
