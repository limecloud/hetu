import {test, expect} from "@playwright/test";
import {build} from "esbuild";
import path from "node:path";

test("中文字体别名用于搜索，预览与保存使用对应CSS家族", async ({page}) => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const compiled = await build({stdin: {resolveDir: root, loader: "tsx", contents: `
    import React, {useState} from "react"; import {createRoot} from "react-dom/client";
    import {ReadingControls} from "./packages/workbench-ui/src/reading-controls.tsx";
    import {defaultReadingProfile} from "./packages/workbench-ui/src/reading.ts";
    function Fixture() {
      const [profile, setProfile] = useState(defaultReadingProfile("novel"));
      return <><ReadingControls kind="novel" preferences={{language: "zh-CN", reading_profiles: {novel: profile}}}
        onChange={patch => setProfile(previous => ({...previous, ...patch.reading_profiles.novel}))}
        loadFonts={async () => ({families: ["示例宋体"], cssNames: {"示例宋体": "Example Serif"}, scanned: 1, skipped: 0, complete: true})}/>
        <output aria-label="保存的字体">{profile.font_family + ":" + profile.font_name}</output></>;
    }
    createRoot(document.getElementById("root")).render(<Fixture/>);
  `}, bundle: true, write: false, format: "iife", platform: "browser", target: "es2022"});
  await page.setContent('<!doctype html><meta charset="utf-8"><div id="root"></div>');
  await page.addScriptTag({content: compiled.outputFiles[0].text});
  await page.getByRole("button", {name: "本机字体", exact: true}).click();
  await page.getByRole("button", {name: "本机字体目录", exact: true}).click();
  await page.getByRole("searchbox", {name: "搜索本机字体", exact: true}).fill("宋体");
  const choice = page.getByRole("button", {name: "选择字体 示例宋体", exact: true});
  await expect(choice).toBeVisible();
  await expect(choice.locator("span")).toHaveCSS("font-family", /Example Serif/);
  await choice.click();
  await expect(page.getByRole("status", {name: "保存的字体", exact: true})).toHaveText("custom:Example Serif");
  await expect(page.getByRole("textbox", {name: "本机字体名称", exact: true})).toHaveValue("Example Serif");
  await expect(page.locator(".reading-style-page")).toHaveCSS("font-family", /Example Serif/);
  // 目录记录不保证浏览器可用，未知规范名仍诚实显示回退。
  await expect(page.locator(".reading-font-status")).toContainText("未检测到此字体");
});
