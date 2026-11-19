import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, copyFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSettings, closeSettings } from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");

test("无作品的设置窗口确认Codex连接安装，回读登记且重复点击不重装或授予作品权限", async () => {
  test.skip(process.platform === "win32", "此隔离CLI夹具使用Unix可执行脚本。");
  const folder = await mkdtemp(path.join(tmpdir(), "hetu-desktop-connection-"));
  const codexHome = path.join(folder, "codex"), binary = path.join(folder, "codex-fixture");
  await mkdir(codexHome);
  await copyFile(path.join(root, "core/tests/fixtures/codex-settings.py"), binary); await chmod(binary, 0o700);
  const profile = path.join(folder, "profile"), settingsDirectory = path.join(folder, "settings");
  const application = await electron.launch({ args: [path.join(root, "apps/desktop")], env: {
    ...process.env, HETU_DESKTOP_PROFILE: profile, HETU_LOCAL_SETTINGS_DIR: settingsDirectory,
    HETU_COLLABORATION_DIR: path.join(folder, "collaboration"), CODEX_HOME: codexHome,
    HETU_CODEX_BINARY: binary, HETU_APP_SERVER: path.join(root, "target/debug/hetu-app-server"),
    HETU_CLI: path.join(root, "target/debug/hetu"),
  } });
  try {
    await application.evaluate(({ dialog }) => {
      (globalThis as any).installChoice = 0;
      (globalThis as any).installPrompts = [];
      dialog.showMessageBox = async (_window: any, options: any) => {
        (globalThis as any).installPrompts.push(options.message);
        return { response: (globalThis as any).installChoice, checkboxChecked: false };
      };
      dialog.showMessageBoxSync = () => 1;
    });
    const page = await application.firstWindow();
    const settings = await openSettings(application, page);
    await settings.getByRole("tab", { name: "AI 协作", exact: true }).click();
    const install = settings.getByRole("button", { name: "安装 MCP App", exact: true });
    await install.click();
    await expect(settings.getByRole("status")).toContainText("已取消 Codex 接入");
    expect(await readFile(path.join(codexHome, "calls.log"), "utf8").catch(() => "")).not.toContain("plugin add ");
    await application.evaluate(() => { (globalThis as any).installChoice = 1; });
    await install.click();
    await expect(settings.getByRole("status")).toContainText("连接包已登记", { timeout: 30000 });
    await install.click();
    await expect(settings.getByRole("status")).toContainText("当前会话加载尚待核对");
    await expect(install).toBeEnabled();
    const log = await readFile(path.join(codexHome, "calls.log"), "utf8");
    expect(log.split("\n").filter(line => line.startsWith("plugin add "))).toHaveLength(1);
    const state = JSON.parse(await readFile(path.join(settingsDirectory, "settings.json"), "utf8"));
    expect(state.installations["codex:machine-connection"].version).toBe(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version);
    const skills=settings.getByRole("button",{name:"安装 Skills 套件",exact:true});
    await skills.click();
    await expect(settings.getByText("Skills 套件已安装。请在所选客户端刷新或新建会话后验证。",{exact:true})).toBeVisible({timeout:30000});
    await skills.click();
    await expect(skills).toBeEnabled();
    const installedLog=await readFile(path.join(codexHome,"calls.log"),"utf8");
    expect(installedLog.split("\n").filter(line=>line.startsWith("plugin add "))).toHaveLength(2);
    expect(await settings.evaluate(async () => {
      try { await window.hetuDesktop.connection("authorize", "codex"); return "unexpectedly allowed"; }
      catch (error) { return (error as Error).message; }
    })).toContain("此通道只供可信工作台使用");
    expect(await application.evaluate(() => (globalThis as any).installPrompts.length)).toBe(3);
    await closeSettings(settings);
  } finally { await application.close(); }
});
