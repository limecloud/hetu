import {test, expect, _electron as electron, type Locator} from "@playwright/test";
import {mkdtemp, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {closeApplication} from "./navigation.ts";
import {renderedContrast} from "./fixtures/rendered-contrast.ts";

const root = path.resolve(import.meta.dirname, "../../..");
for (const appearance of ["light", "dark"] as const) test(`${appearance}会话创建的读取错误、操作和快捷键可读，重试不启动引擎`, async ({}, info) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "hetu-launch-contrast-")), executable = process.env.HETU_PACKAGED_APP;
  const env = {...process.env, HETU_DESKTOP_PROFILE: profile, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "LocalSettings"), HETU_COLLABORATION_DIR: path.join(profile, "collaboration"), HETU_PLUGIN_STATE_DIR: profile};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({...(executable ? {executablePath: executable, args: []} : {args: [path.join(root, "apps/desktop")]}), env});
  const samples: unknown[] = [];
  let failed = false;
  try {
    const page = await app.firstWindow(); await page.setViewportSize({width: 1280, height: 900});
    await expect(page.getByRole("button", {name: "刷新创作库", exact: true})).toBeEnabled();
    await page.evaluate(async appearance => {const state = await window.hetuDesktop.settings("preferences"); await window.hetuDesktop.settings("update", {expected_revision: state.revision, patch: {appearance}});}, appearance);
    await expect(page.locator("html")).toHaveAttribute("data-appearance", appearance);
    await app.evaluate(({ipcMain}) => {
      const handlers = (ipcMain as any)._invokeHandlers, original = handlers.get("desktop:agent-session"); let failed = false;
      (globalThis as any).__contrastCreates = 0;
      handlers.set("desktop:agent-session", (event: unknown, method: string, input: any) => {
        if (method === "catalog") return [{id: "codex", name: "Codex", available: true, models: true, chat: true}];
        if (method === "model_options") {if (!failed) {failed = true; throw Error("模型列表读取失败，请重试。");} return [{id: "test-model", name: "测试模型", efforts: ["high"], default_effort: "high"}];}
        if (method === "create") {(globalThis as any).__contrastCreates++; throw Error("本专项不启动引擎。");}
        return original(event, method, input);
      });
    });
    const before = await page.evaluate(() => window.hetuDesktop.agentSession("get", {scope: "library"}));
    await page.getByLabel("更多操作", {exact: true}).click(); await page.getByRole("button", {name: "打开终端工作区", exact: true}).click();
    const dialog = page.getByRole("dialog", {name: "创建会话", exact: true}), alert = dialog.getByRole("alert");
    await expect(alert).toContainText("模型列表读取失败，请重试。");
    const sample = async (state: string, node: Locator) => {const value = await node.evaluate(renderedContrast); samples.push({appearance, state, text: (await node.innerText()).trim(), ...value}); return value;};
    const error = await sample("model-read-error", alert);
    await page.screenshot({path: info.outputPath("model-read-error.png")});
    expect(error.unresolved).toEqual([]); expect(error.background[3]).toBe(255); expect(error.foreground[3]).toBe(255);
    expect.soft(error.contrast, "读取错误文字对比度").toBeGreaterThanOrEqual(4.5);
    await dialog.getByRole("button", {name: "重新读取模型", exact: true}).click(); await expect(alert).toHaveCount(0);
    for (const node of [dialog.getByText("作品", {exact: true}), dialog.getByText("运行于", {exact: true}), dialog.locator(".agent-launch-name > span")]) {
      const value = await sample("create-dialog", node); expect(value.unresolved).toEqual([]); expect.soft(value.contrast).toBeGreaterThanOrEqual(4.5);
    }
    const checkButton = async (button: Locator) => {
      for (const state of ["normal", "hover", "pressed"] as const) {
        if (state !== "normal") await button.hover();
        if (state === "pressed") await page.mouse.down();
        try {
          for (const [part, node] of [["label", button], ["shortcut", button.locator("kbd")]] as const) {
            const value = await sample(state + "-" + part, node); expect(value.unresolved).toEqual([]); expect.soft(value.contrast).toBeGreaterThanOrEqual(4.5);
          }
        } finally {if (state === "pressed") {await page.mouse.move(0, 0); await page.mouse.up();}}
      }
    };
    await checkButton(dialog.getByRole("button", {name: "创建", exact: true}));
    const trigger = dialog.getByRole("button", {name: /^引擎(?: |$)/}); await trigger.click();
    const picker = dialog.getByRole("dialog", {name: "选择引擎与模型", exact: true}); await expect(picker.getByRole("option", {name: "测试模型", exact: true})).toBeVisible();
    await checkButton(picker.getByRole("button", {name: /打开聊天/})); await checkButton(picker.getByRole("button", {name: /打开终端/}));
    await page.screenshot({path: info.outputPath("model-read-recovered.png")});
    await page.keyboard.press("Escape"); await expect(trigger).toBeFocused(); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
    const after = await page.evaluate(() => window.hetuDesktop.agentSession("get", {scope: "library"}));
    expect(after.session_id).toBe(before.session_id); expect(after.state).toBe("idle"); expect(after.thread_id).toBeUndefined(); expect(after.messages).toHaveLength(0);
    expect(await app.evaluate(() => (globalThis as any).__contrastCreates)).toBe(0);
    await writeFile(info.outputPath("result.json"), JSON.stringify({appearance, packaged: !!executable, model_read_recovered: true, focus_restored: true, engine_creations: 0, model_messages: 0}, null, 2) + "\n");
  } catch (error) {
    failed = true; await writeFile(info.outputPath("failure.json"), JSON.stringify({error: String(error)}, null, 2) + "\n"); throw error;
  } finally {
    await writeFile(info.outputPath("rendered-contrast.json"), JSON.stringify({appearance, packaged: !!executable, samples}, null, 2) + "\n");
    try {await closeApplication(app);} catch (error) {if (!failed) throw error; await writeFile(info.outputPath("shutdown-failure.json"), JSON.stringify({error: String(error)}, null, 2) + "\n");}
  }
});
