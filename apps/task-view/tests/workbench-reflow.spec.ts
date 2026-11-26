import {test, expect} from "@playwright/test";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {AppServer} from "../../desktop/src/main/rpc.ts";
import {navigate} from "../../desktop/tests/navigation.ts";
import {openWorkbenchHost} from "./workbench-host.ts";

for (const appearance of ["light", "dark"] as const) test(`stdio ${appearance} 工作台在320及480宽度重排，阅读和设置操作保持可达`, async ({page}, info) => {
  test.setTimeout(180000);
  const root = path.resolve(import.meta.dirname, "../../.."), folder = await mkdtemp(path.join(tmpdir(), "hetu-reflow-"));
  const workspace = path.join(folder, "work"), profile = path.join(folder, "profile"), collaboration = path.join(folder, "collaboration");
  const bin = process.env.HETU_ACCEPT_MCP_BINARY ? path.dirname(process.env.HETU_ACCEPT_MCP_BINARY) : path.join(root, "target/debug");
  const fixtures = process.env.HETU_ACCEPT_FIXTURE_DIRECTORY ?? path.join(root, "target/debug/examples"), suffix = process.platform === "win32" ? ".exe" : "";
  const seed = spawnSync(path.join(fixtures, "baseline_fixture" + suffix), [workspace, collaboration], {encoding: "utf8"});
  expect(seed.status, seed.error?.message ?? seed.stderr).toBe(0); const refs = JSON.parse(seed.stdout);
  await mkdir(profile); await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: refs.novel.workspace_id, works: [{work_ref: refs.novel, title: "默认小说"}]}]}));
  const core = await AppServer.open(path.join(bin, "hetu-app-server" + suffix), workspace);
  const before = await core.request("workspace/request", {action: "hetu.documents.get", input: {document_id: refs.document.document.document_id}, contract_revision: "1"});
  expect(before.status).toBe("succeeded");
  const failures: unknown[] = [];
  const host = await openWorkbenchHost("stdio", page, {...process.env, HETU_DESKTOP_PROFILE: profile, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "LocalSettings"), HETU_PLUGIN_STATE_DIR: profile, HETU_COLLABORATION_DIR: collaboration, HETU_PLUGIN_NODE: process.execPath, HETU_APP_SERVER: path.join(bin, "hetu-app-server" + suffix), HETU_CLI: path.join(bin, "hetu" + suffix), ...(!process.env.HETU_PACKAGED_APP ? {HETU_INTEGRATIONS_DIR: path.join(root, "integrations")} : {})}, async (method, args, run) => {
    try {const result = await run(); if (result.isError || result.structuredContent?.error) failures.push({method, action: typeof args[0] === "string" ? args[0] : undefined, error: result.structuredContent?.error}); return result;}
    catch (error) {failures.push({method, action: typeof args[0] === "string" ? args[0] : undefined, error: String(error)}); throw error;}
  });
  const view = host.view, metrics: unknown[] = [];
  const measure = async (stage: string, width: number) => {
    await page.setViewportSize({width, height: 900});
    const value = await view.locator("#root").evaluate(() => {
      const surface = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog:modal")).at(-1) ?? document;
      const clipped = Array.from(surface.querySelectorAll<HTMLElement>("button,summary,input,select,textarea")).filter(element => {
        if (!element.checkVisibility() || element.closest('[hidden],[aria-hidden="true"],.settings-tabs,.document-tabs')) return false;
        const rect = element.getBoundingClientRect();
        return rect.top < innerHeight && rect.bottom > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
      }).map(element => ({tag: element.tagName, label: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 60), x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width}));
      return {width: innerWidth, root_overflow: document.documentElement.scrollWidth > innerWidth + 1, clipped_controls: clipped,
        settings_overflow: Array.from(document.querySelectorAll(".settings-panel")).some(element => element.scrollWidth > element.clientWidth + 1)};
    });
    metrics.push({stage, ...value}); await page.screenshot({path: info.outputPath(`${stage}-${width}.png`)});
    expect.soft(value.root_overflow, stage + " page overflow").toBe(false);
    expect.soft(value.clipped_controls, stage + " clipped controls").toEqual([]);
    expect.soft(value.settings_overflow, stage + " settings overflow").toBe(false);
  };
  try {
    await page.setViewportSize({width: 1280, height: 900});
    await expect(view.getByRole("button", {name: "打开作品 默认小说", exact: true})).toBeVisible();
    expect(await view.locator("#root").evaluate(() => [typeof window.hetuDesktop.maximize, typeof window.hetuDesktop.fullscreen, typeof window.hetuDesktop.windowLayout])).toEqual(["undefined", "undefined", "undefined"]);
    await view.locator("#root").evaluate(async (_element, appearance) => {const state = await window.hetuDesktop.settings("preferences"); await window.hetuDesktop.settings("update", {expected_revision: state.revision, patch: {appearance}});}, appearance);
    await expect(view.locator("html")).toHaveAttribute("data-appearance", appearance);
    for (const width of [480, 320]) await measure("library", width);
    await page.setViewportSize({width: 1280, height: 900}); await view.getByRole("button", {name: "打开作品 默认小说", exact: true}).click();
    await navigate(view, "小说"); await expect(view.getByRole("textbox", {name: "文稿编辑", exact: true})).toContainText(before.data.content.split(/\r?\n/)[0]);
    for (const width of [480, 320]) await measure("reader", width);
    await page.setViewportSize({width: 1280, height: 900});
    if (!await view.getByRole("complementary", {name: "项目导航", exact: true}).isVisible()) await view.getByRole("button", {name: "项目导航", exact: true}).click();
    await navigate(view, "返回创作库");
    await view.getByRole("button", {name: "本机设置", exact: true}).first().click();
    const settings = view.getByRole("region", {name: "本机设置", exact: true}); await expect(settings).toBeVisible();
    for (const width of [480, 320]) {
      await measure("settings-general", width);
      expect.soft(await settings.getByRole("tablist", {name: "设置分类", exact: true}).getAttribute("aria-orientation")).toBe(width <= 440 ? "horizontal" : "vertical");
    }
    const generalTab = settings.getByRole("tab", {name: "通用", exact: true});
    await generalTab.focus(); await generalTab.press("ArrowRight");
    await expect(settings.getByRole("tab", {name: "写作", exact: true})).toBeFocused();
    await settings.getByRole("tab", {name: "写作", exact: true}).press("Home"); await expect(generalTab).toBeFocused();
    const visualTabs = ["通用", "写作", "存储空间", "模型服务", "AI 协作", "版本", "关于"];
    for (const width of [1280, 320]) {
      await page.setViewportSize({width, height: 900});
      const tabList = settings.getByRole("tablist", {name: "设置分类", exact: true});
      await expect(tabList.getByRole("tab")).toHaveText(visualTabs);
      for (const [index, label] of visualTabs.entries()) {
        const currentTab = tabList.getByRole("tab", {name: label, exact: true}); await currentTab.focus();
        await currentTab.press(width <= 440 ? "ArrowRight" : "ArrowDown");
        await expect.soft(tabList.getByRole("tab", {name: visualTabs[(index + 1) % visualTabs.length], exact: true}), `${width}: ${label} next visual tab`).toBeFocused();
      }
      await generalTab.press("End"); await expect(tabList.getByRole("tab", {name: "关于", exact: true})).toBeFocused();
      await tabList.getByRole("tab", {name: "关于", exact: true}).press("Home"); await expect(generalTab).toBeFocused();
    }
    for (const [label, id] of [["写作", "writing"], ["存储空间", "storage"], ["AI 协作", "agents"], ["版本", "versions"], ["关于", "about"]]) {
      await settings.getByRole("tab", {name: label, exact: true}).click();
      for (const width of [480, 320]) await measure("settings-" + id, width);
    }
    await settings.getByRole("tab", {name: "AI 协作", exact: true}).click();
    await settings.getByText("外部客户端、MCP App与Skills接入", {exact: true}).click();
    const integration = settings.getByRole("region", {name: "默认AI协作", exact: true});
    await expect(integration).toHaveAttribute("aria-busy", "false");
    await expect(integration.getByRole("combobox", {name: "题材 Skills 套件", exact: true})).toBeVisible();
    for (const summary of ["按分类查找或由外部 Agent 引导", "套件包含的 Skills", "安装状态"]) {
      const trigger = integration.locator("summary").filter({hasText: summary});
      await expect(trigger).toHaveCount(1);
      if (!await trigger.evaluate(node => (node.parentElement as HTMLDetailsElement).open)) await trigger.click();
    }
    for (const width of [480, 320]) {
      await measure("settings-agents-expanded", width);
      for (const label of ["搜索题材套件", "题材平台", "题材频道", "套件选择目标", "Agent 套件建议"]) {
        const control = integration.getByRole(label.includes("平台") || label.includes("频道") ? "combobox" : "textbox", {name: label, exact: true});
        await control.scrollIntoViewIfNeeded();
        const rect = await control.boundingBox(); expect.soft(rect?.x, label).toBeGreaterThanOrEqual(0); expect.soft(rect && rect.x + rect.width, label).toBeLessThanOrEqual(width + 1);
      }
    }
    const guide = integration.getByRole("button", {name: "安装与接入说明", exact: true}); await guide.click();
    await expect(integration.getByRole("dialog")).toBeVisible(); await measure("settings-agents-guide", 320);
    await page.keyboard.press("Escape"); await expect(integration.getByRole("dialog")).toHaveCount(0); await expect(settings).toBeVisible(); await expect.soft(guide).toBeFocused();
    await guide.press("Enter"); await expect(integration.getByRole("dialog", {name: "安装与接入说明", exact: true})).toBeVisible();
    await integration.getByRole("button", {name: "关闭接入窗口", exact: true}).click(); await expect(integration.getByRole("dialog")).toHaveCount(0); await expect(guide).toBeFocused();
    await settings.getByRole("tab", {name: "模型服务", exact: true}).click(); await settings.getByRole("button", {name: "添加渠道", exact: true}).click();
    await expect(settings.getByRole("dialog", {name: "添加渠道", exact: true})).toBeVisible(); await measure("settings-model-dialog", 320);
    await page.keyboard.press("Escape"); await expect(settings.getByRole("dialog", {name: "添加渠道", exact: true})).toHaveCount(0);
    await expect(settings).toBeVisible(); await expect(settings.getByRole("button", {name: "添加渠道", exact: true})).toBeFocused();
    await settings.getByRole("button", {name: "关闭设置", exact: true}).click(); await expect(settings).toHaveCount(0);
    const after = await core.request("workspace/request", {action: "hetu.documents.get", input: {document_id: refs.document.document.document_id}, contract_revision: "1"});
    expect(after.status).toBe("succeeded"); expect(after.data).toEqual(before.data);
    expect(failures).toEqual([]);
  } finally {
    await writeFile(info.outputPath("reflow-metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
    await writeFile(info.outputPath("failed-calls.json"), JSON.stringify(failures, null, 2) + "\n");
    await host.close(); await core.close();
  }
});
