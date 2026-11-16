import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { navigate } from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");
test("CLI安装启停卸载插件后桌面同步同一状态，无需界面执行", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-machine-plugins-"));
  const executable = process.env.HETU_PACKAGED_APP;
  const machine = executable ? path.resolve(executable, "../../Resources/bin")
    : path.resolve(process.env.HETU_MACHINE_BIN_DIR ?? path.join(root, "target/debug"));
  const env = { ...process.env, HETU_DESKTOP_PROFILE: path.join(folder,"profile"),
    HETU_COLLABORATION_DIR: path.join(folder,"collaboration"),
    HETU_PLUGIN_STATE_DIR: path.join(folder,"plugins"),
    HETU_PLUGIN_ACCESS_DIR: path.join(folder,"access"),
    ...(!executable ? { HETU_APP_SERVER: path.join(machine,"hetu-app-server"),
      HETU_PLUGIN_NODE: process.execPath, HETU_PLUGIN_CLI: path.join(machine,"hetu-plugin") } : {}) };
  function call(action: string, input: unknown) {
    const result = spawnSync(path.join(machine,"hetu"),["--client","codex","call",`hetu.plugins.${action}`,"--input","-"],
      { env, input:JSON.stringify(input),encoding:"utf8",timeout:60000 });
    const response = JSON.parse(result.stdout);
    expect(response.status, result.stderr + result.stdout).toBe("succeeded");
    return response.data;
  }
  const app = await electron.launch({ ...(executable ? { executablePath:executable,args:[] }
    : { args:[path.join(root,"apps/desktop")] }), env });
  try {
    const page = await app.firstWindow();
    await navigate(page,"创作插件");
    await expect(page.getByText("还没有安装插件",{exact:true})).toBeVisible();
    const pkg = call("inspect_package",{package_directory:path.join(root,"plugins/relationships/dist")});
    let index = 0;
    const apply = (action: string) => call("apply",{action,plugin_id:pkg.manifest.id,
      package_directory:path.join(root,"plugins/relationships/dist"),package_sha256:pkg.package_sha256,
      expected_sha256:call("inspect",{}).state_sha256,
      authorization_note:`测试用户明确要求${action}人物关系图插件。`,operation_key:`operation-${++index}`});
    apply("install");
    await expect(page.getByText("人物关系图",{exact:true}).first()).toBeVisible();
    const row = page.locator(".plugin-content .row").filter({hasText:"人物关系图"});
    await expect(row.getByRole("button",{name:"停用",exact:true})).toBeVisible();
    apply("disable");
    await expect(row.getByRole("button",{name:"启用",exact:true})).toBeVisible();
    apply("enable");
    await expect(row.getByRole("button",{name:"停用",exact:true})).toBeVisible();
    apply("uninstall");
    await expect(row.getByText(`已卸载 ${pkg.manifest.version}`,{exact:true})).toBeVisible();
    await expect(row.getByRole("button",{name:"启用",exact:true})).toHaveCount(0);
    await expect(row.getByRole("button",{name:"停用",exact:true})).toHaveCount(0);
    expect(call("get_operation",{operation_key:"operation-4"}).action).toBe("uninstall");
  } finally { await app.close(); }
});
