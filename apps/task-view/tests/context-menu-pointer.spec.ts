import {test, expect} from "@playwright/test";
import {build} from "esbuild";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {renderedContrast} from "../../desktop/tests/fixtures/rendered-contrast.ts";

for (const theme of ["light", "dark"] as const) for (const side of ["right", "left"] as const) test(`${theme}多级菜单向${side}展开时，斜向进入子项不误切换相邻项`, async ({page}, info) => {
  const root = path.resolve(import.meta.dirname, "../../.."), x = side === "right" ? 30 : 650;
  const compiled = await build({stdin: {resolveDir: root, loader: "tsx", contents: `
    import React from "react"; import {createRoot} from "react-dom/client";
    import {ContextMenuProvider, useContextMenu} from "./packages/workbench-ui/src/context-menu.tsx";
    function Fixture() {
      const show = useContextMenu(), choose = label => {document.querySelector("output").textContent = label;};
      const items = [...Array.from({length: 8}, (_, index) => ({id: "before" + index, label: "前项" + index, shortcut: "⌘" + index, danger: index === 0, disabled: index === 7, action: () => choose("前项" + index)})),
        {id: "group", label: "格式", children: Array.from({length: 6}, (_, index) => ({id: "child" + index, label: "子项" + index, shortcut: "⌘" + index, action: () => choose("子项" + index)}))},
        ...Array.from({length: 8}, (_, index) => ({id: "after" + index, label: "后项" + index, action: () => choose("后项" + index)}))];
      return <><button style={{position: "fixed", left: ${x}, top: 120}} onContextMenu={event => show(event, "指针验收", items)}>打开菜单</button><output aria-label="执行结果"/></>;
    }
    createRoot(document.getElementById("root")).render(<ContextMenuProvider><Fixture/></ContextMenuProvider>);
  `}, bundle: true, write: false, format: "iife", platform: "browser", target: "es2022"});
  await page.setViewportSize({width: 760, height: 700});
  await page.emulateMedia({colorScheme: theme});
  await page.setContent('<!doctype html><meta charset="utf-8"><div id="root"></div>');
  await page.addStyleTag({content: await readFile(path.join(root, "assets/styles/radix-workbench.css"), "utf8")});
  await page.addStyleTag({content: await readFile(path.join(root, "apps/desktop/dist/renderer/style.css"), "utf8")});
  await page.addScriptTag({content: compiled.outputFiles[0].text});
  const trigger = page.getByRole("button", {name: "打开菜单", exact: true});
  await trigger.click({button: "right", position: {x: 4, y: 31}});
  const parent = page.getByRole("menuitem", {name: "格式", exact: true}); await parent.hover();
  const submenu = page.getByRole("menu", {name: "格式", exact: true}), choice = submenu.getByRole("menuitem", {name: "子项5", exact: true});
  await expect(choice).toBeVisible();
  const parentBounds = (await parent.boundingBox())!, childBounds = (await submenu.boundingBox())!, bounds = (await choice.boundingBox())!;
  expect(side === "right" ? childBounds.x > parentBounds.x : childBounds.x < parentBounds.x).toBe(true);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 3, {steps: 12});
  await expect(choice).toBeVisible();
  const contrasts: unknown[] = [];
  const contrast = async (state: string, item = choice) => {
    const palettes = [];
    for (const [part, node] of [["label", item], ["shortcut", item.locator(".context-menu-shortcut")]] as const) {
      const palette = await node.evaluate(renderedContrast); contrasts.push({theme, side, state, part, ...palette});
      palettes.push(palette);
    }
    await writeFile(info.outputPath("menu-contrast.json"), JSON.stringify(contrasts, null, 2) + "\n");
    for (const palette of palettes) {
      expect(palette.unresolved).toEqual([]);
      expect(palette.background[3]).toBe(255); expect(palette.foreground[3]).toBe(255);
      expect(palette.contrast).toBeGreaterThanOrEqual(4.5);
    }
  };
  await contrast("hover");
  await contrast("normal", page.getByRole("menuitem", {name: "前项1", exact: true}));
  await contrast("danger-normal", page.getByRole("menuitem", {name: "前项0", exact: true}));
  await page.screenshot({path: info.outputPath(`pointer-${side}-submenu.png`)});
  await page.mouse.down(); await contrast("pressed"); await page.mouse.up();
  await expect(page.getByRole("status")).toHaveText("子项5"); await expect(submenu).toHaveCount(0);
  // 反向离开与键盘接管不受指针容错影响。
  await trigger.click({button: "right", position: {x: 4, y: 31}}); await parent.hover(); await expect(submenu).toBeVisible();
  const danger = page.getByRole("menuitem", {name: "前项0", exact: true});
  await danger.hover(); await expect(submenu).toHaveCount(0); await contrast("danger", danger);
  const disabled = page.getByRole("menuitem", {name: "前项7", exact: true}); await expect(disabled).toBeDisabled();
  const disabledBounds = (await disabled.boundingBox())!;
  await page.mouse.click(disabledBounds.x + disabledBounds.width / 2, disabledBounds.y + disabledBounds.height / 2);
  await expect(page.getByRole("status")).toHaveText("子项5");
  await parent.focus(); await parent.press("ArrowRight"); await expect(submenu.getByRole("menuitem", {name: "子项0", exact: true})).toBeFocused();
  await page.keyboard.press("End"); await expect(choice).toBeFocused();
  await contrast("keyboard");
  const selected = await choice.evaluate(node => getComputedStyle(node).backgroundColor);
  await expect(danger).not.toHaveCSS("background-color", selected);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {features: [{name: "prefers-color-scheme", value: theme}, {name: "prefers-contrast", value: "more"}, {name: "prefers-reduced-transparency", value: "reduce"}]});
  await expect(submenu).toHaveCSS("backdrop-filter", "none");
  await contrast("contrast-more");
  await page.screenshot({path: info.outputPath(`pointer-${side}-high-contrast.png`)}); await cdp.detach();
  await page.keyboard.press("Escape"); await expect(parent).toBeFocused();
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await page.screenshot({path: info.outputPath(`pointer-${side}.png`)});
});
