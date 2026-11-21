import {
  test,
  expect as baseExpect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { SettingsReview } from "../src/main/settings.ts";
import { RecoveryStore } from "../src/main/recovery.ts";
import { AppServer } from "../src/main/rpc.ts";
import { openSettings } from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const expect = baseExpect.configure({ timeout: 30000 });
test("Core异常退出及重复关闭不阻塞桌面清理", async () => {
  const binary = path.join(root, "target/debug/hetu-app-server" + (process.platform === "win32" ? ".exe" : ""));
  const normal = await AppServer.open(binary);
  await Promise.all([normal.close(), normal.close()]);
  const failed = await AppServer.open(binary);
  failed.fail();
  await Promise.all([failed.close(), failed.close()]);
});
test("本机决定发送前及提交后中断保留原键，确定冲突不冒充未知", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-local-journal-"));
  let current = { revision: 1, preferences: { font_size: 18 } },
    fail = true;
  const inputs: any[] = [],
    receipts = new Map<string, any>();
  const service = new SettingsReview(
    async (method, input: any) => {
      if (method === "get" || method === "preferences") return structuredClone(current);
      inputs.push(structuredClone(input));
      if (fail) throw new Error("发送前连接中断");
      if (receipts.has(input.operation_key))
        return receipts.get(input.operation_key);
      if (input.expected_revision !== current.revision)
        throw Object.assign(new Error("基线变化"), {
          code: "revision_conflict",
        });
      current = { revision: current.revision + 1, preferences: input.patch };
      receipts.set(input.operation_key, structuredClone(current));
      throw new Error("提交后回执丢失");
    },
    new RecoveryStore(),
    path.join(folder, "journal.json"),
  );
  const preview = await service.manual(1, { font_size: 24 });
  await expect(service.commit(preview.token)).rejects.toThrow("发送前");
  expect((await service.journal())!.status).toBe("pending");
  fail = false;
  await expect(service.recover()).rejects.toThrow("回执丢失");
  await service.recover();
  expect(new Set(inputs.map((i) => i.operation_key)).size).toBe(1);
  expect(current.revision).toBe(2);
  await service.acknowledge();
  const next = await service.manual(2, { font_size: 25 });
  current.revision = 3;
  await expect(service.commit(next.token)).rejects.toThrow("基线变化");
  expect((await service.journal())!.status).toBe("blocked");
  await service.acknowledge();
  expect(await service.journal()).toBeNull();
});

test("CLI准备本机方案、Electron固定审阅与恢复、无窗口执行和真实MCP回读", async () => {
  test.setTimeout(300000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-settings-e2e-")),
    profile = path.join(folder, "desktop"),
    settings = path.join(profile, "local-settings"),
    collaboration = path.join(folder, "collaboration");
  const executable = process.env.HETU_PACKAGED_APP;
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        ![
          "HETU_APP_SERVER",
          "HETU_CLI",
          "HETU_PLUGIN_CLI",
          "HETU_PLUGIN_NODE",
          "ELECTRON_RUN_AS_NODE",
          "HETU_INTEGRATIONS_DIR",
        ].includes(key),
    ),
  ) as Record<string, string>;
  Object.assign(env, {
    HETU_DESKTOP_PROFILE: profile,
    HETU_LOCAL_SETTINGS_DIR: settings,
    HETU_COLLABORATION_DIR: collaboration,
  });
  const rendererErrors: string[] = [];
  let app: ElectronApplication | undefined,
    machineBin = path.join(root, "target/debug");
  const binary = (name: string) =>
    path.join(machineBin, name + (process.platform === "win32" ? ".exe" : ""));
  async function launch() {
    app = await electron.launch({
      ...(executable
        ? { executablePath: executable, args: [] }
        : { args: [path.join(root, "apps/desktop")] }),
      env,
    });
    if (executable)
      machineBin = path.join(
        await app.evaluate(() => process.resourcesPath),
        "bin",
      );
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
      dialog.showMessageBoxSync = () => 1;
    });
    const main = await app.firstWindow();
    const page = await openSettings(app, main);
    page.on("pageerror", error => rendererErrors.push(error.message));
    await page.emulateMedia({ colorScheme: null });
    await page.getByRole("button", { name: "让 AI 处理与审阅", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "刷新本机设置", exact: true }),
    ).toBeVisible();
    return page;
  }
  function cli(action: string, input: any) {
    const result = spawnSync(
      binary("hetu"),
      [
        "--client",
        "codex",
        "--collaboration-dir",
        collaboration,
        "call",
        action,
        "--input",
        "-",
      ],
      { env, encoding: "utf8", input: JSON.stringify(input), timeout: 30000 },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    return JSON.parse(result.stdout).data;
  }
  try {
    let page = await launch();
    await page
      .getByRole("button", { name: "让 AI 调整设置", exact: true })
      .click();
    await expect(page.locator(".settings-window-notice[role='status']")).toContainText(
      "已复制本机设置协作请求",
    );
    const handoff = await app!.evaluate(({ clipboard }) =>
      JSON.parse(clipboard.readText().split("\n").slice(1).join("\n")),
    );
    expect(handoff.local_settings_directory).toBe(settings);
    const plan = cli("hetu.local_settings.prepare", {
      kind: "preferences",
      patch: { font_size: 24, appearance: "dark", autosave: false },
      summary: "调整连贯阅读偏好",
      operation_key: "prepare",
    });
    await page
      .getByRole("button", { name: "刷新本机设置", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "当前本机方案" })
      .selectOption(plan.operation_id);
    await expect(
      page.getByRole("region", { name: "本机方案内容" }),
    ).toContainText("24");
    await page.screenshot({ path: path.join(root, "output/settings-native-20261116", executable ? "plan-review-packaged.png" : "plan-review.png"), scale: "css" });
    await page
      .getByRole("button", { name: "批准本机方案", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "本机设置决定预览" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "确认本机决定", exact: true })
      .click();
    await expect(page.locator(".settings-window-notice[role='status']")).toContainText("批准本身不会执行");
    expect(cli("hetu.local_settings.get", {}).preferences.font_size).toBe(16);
    await app!.close();
    app = undefined;
    const file = path.join(profile, "local-settings-journal.json"),
      record = JSON.parse(await readFile(file, "utf8"));
    record.status = "pending";
    delete record.result;
    await writeFile(file, JSON.stringify(record));
    page = await launch();
    await expect(page.getByRole("button", { name: "恢复原本机操作", exact: true })).toBeEnabled();
    await page.screenshot({ path: path.join(root, "output/settings-native-20261116", executable ? "recovery-packaged.png" : "recovery.png"), scale: "css" });
    await page
      .getByRole("button", { name: "恢复原本机操作", exact: true })
      .click();
    await expect(page.locator(".settings-window-notice[role='status']")).toContainText("原本机操作已确认");
    await page
      .getByRole("button", { name: "让 AI 执行此方案", exact: true })
      .click();
    await expect(page.locator(".settings-window-notice[role='status']")).toContainText(
      "已复制原方案执行请求",
    );
    const execute = await app!.evaluate(({ clipboard }) =>
      JSON.parse(clipboard.readText().split("\n").slice(1).join("\n")),
    );
    expect(execute.input.operation_id).toBe(plan.operation_id);
    await app!.close();
    app = undefined;
    expect(cli(execute.action, execute.input).result.font_size).toBe(24);
    const mcp = new Client(
      { name: "hetu-local-settings-e2e", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await mcp.connect(
        new StdioClientTransport({
          command: binary("hetu-mcp"),
          args: ["--client", "codex", "--collaboration-dir", collaboration],
          env,
          stderr: "pipe",
        }),
      );
      expect(
        (await mcp.listTools()).tools.some(
          (t) => t.name === "hetu_call_action",
        ),
      ).toBe(true);
      const read = (
        await mcp.callTool({ name: "hetu_call_action", arguments: { action: "hetu.local_settings.get", input: {} } })
      ).structuredContent as any;
      expect(read.data.preferences).toMatchObject({
        font_size: 24,
        appearance: "dark",
        autosave: false,
      });
    } finally {
      await mcp.close();
    }
    page = await launch();
    await expect(
      page.getByRole("region", { name: "本机方案内容" }),
    ).toContainText("已执行");
    expect(
      await app!.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors),
    ).toBe(true);
    await expect(page.locator("html")).toHaveCSS("background-color", "rgb(34, 34, 34)");
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--reader-font-size")
          .trim(),
      ),
    ).toBe("24px");
    await page.screenshot({
      path: path.join(
        root,
        "output/plugin-doc-qa/" +
          (executable ? "settings-packaged.png" : "settings.png"),
      ),
    });
    await page.getByRole("button", { name: "返回设置", exact: true }).click();
    await page.getByRole("tab", { name: "AI 协作", exact: true }).click();
    const before = await page.evaluate(() => window.hetuDesktop.settings("get"));
    await page.getByRole("combobox", { name: "题材 Skills 套件" }).selectOption("military");
    await expect(page.getByRole("region", { name: "默认AI协作", exact: true })).toHaveAttribute("aria-busy", "false");
    await expect.poll(() => page.evaluate(async () => (await window.hetuDesktop.settingsAgent("get")).association.suite)).toBe("military");
    await page.getByRole("tab", { name: "写作", exact: true }).click();
    await page.getByRole("switch", { name: "自动保存正文", exact: true }).check();
    await expect.poll(() => page.evaluate(async () => (await window.hetuDesktop.settings("get")).preferences.autosave)).toBe(true);
    await expect(page.getByRole("switch", { name: "自动保存正文", exact: true })).toBeEnabled();
    await expect(app!.windows().find(window => !window.url().endsWith("?view=settings"))!.locator("html")).toHaveAttribute("data-appearance", "dark");
    // 设置窗口只能访问本机设置，不能扩大到作品和作者操作。
    await expect(page.evaluate(() => window.hetuDesktop.read("hetu.works.list", {}))).rejects.toThrow();
    await expect(page.evaluate(() => window.hetuDesktop.author("journal", {}))).rejects.toThrow();
    const main = app!.windows().find(window => !window.url().endsWith("?view=settings"))!;
    expect(await openSettings(app!, main)).toBe(page);
    expect(app!.windows().filter(window => window.url().endsWith("?view=settings"))).toHaveLength(1);
    // 关窗后再由独立CLI核验落盘，避免与桌面尚在执行的设置事务争锁。
    await app!.close();
    app = undefined;
    const after = cli("hetu.local_settings.get", {});
    expect(after.association.suite).toBe("military");
    expect(after.preferences.autosave).toBe(true);
    expect(after.installations).toEqual(before.installations);
    expect(rendererErrors).toEqual([]);
  } finally {
    await test.info().attach("renderer-errors", { body: JSON.stringify(rendererErrors, null, 2), contentType: "application/json" });
    await app?.close();
  }
});
