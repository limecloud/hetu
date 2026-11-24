import {test, expect, _electron as electron} from "@playwright/test";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {execFileSync, spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import {AppServer} from "../src/main/rpc.ts";
import {documentAction} from "./navigation.ts";

test("macOS Sogou 拼音真实组合输入写入隔离作品", async () => {
  test.skip(process.platform !== "darwin", "仅在 macOS 验收系统输入法");
  const sources = execFileSync("defaults", ["read", "com.apple.HIToolbox", "AppleSelectedInputSources"], {encoding:"utf8"});
  test.skip(!sources.includes("com.sogou.inputmethod.sogou"), "当前没有选择 Sogou 输入法");
  test.setTimeout(120000);
  const root = path.resolve("../.."), directory = await mkdtemp(path.join(tmpdir(), "hetu-native-ime-"));
  const workspace = path.join(directory, "work"), profile = path.join(directory, "profile");
  await mkdir(profile);
  const fixture = spawnSync(path.join(root, "target/debug/examples/baseline_fixture"), [workspace, path.join(directory, "collaboration")], {encoding:"utf8"});
  expect(fixture.status, fixture.stderr).toBe(0);
  const refs = JSON.parse(fixture.stdout);
  const core = await AppServer.open(path.join(root, "target/debug/hetu-app-server"), workspace);
  try {
    const saved = await core.request("workspace/request", {action:"hetu.documents.save", input:{document_id:refs.document.document.document_id, base_revision_id:refs.document.revision.revision_id, content:"段首。\n", source_format:"markdown", operation_key:"native-ime-fixture"}, contract_revision:"1"});
    expect(saved.status).toBe("succeeded");
  } finally { await core.close(); }
  const executable = process.env.HETU_PACKAGED_APP;
  const app = await electron.launch({...executable ? {executablePath:executable} : {args:[path.join(root, "apps/desktop")]}, env:{...process.env, HETU_DESKTOP_PROFILE:profile, HETU_PLUGIN_STATE_DIR:profile, HETU_COLLABORATION_DIR:path.join(directory, "collaboration"), HETU_APP_SERVER:executable ? undefined : path.join(root, "target/debug/hetu-app-server")}});
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({width:1440,height:940});
    await app.evaluate(({dialog}, directory) => {dialog.showOpenDialog = async () => ({canceled:false, filePaths:[directory]});}, workspace);
    await page.getByRole("button", {name:"打开作品", exact:true}).first().click();
    const novel = page.getByRole("button", {name:/打开作品 .*小说/}).first();
    await expect(novel).toBeVisible({timeout:30000});
    await novel.click();
    await expect(page.getByRole("textbox", {name:"文稿编辑", exact:true})).toBeVisible({timeout:30000});
    await documentAction(page, "编辑");
    const editor = page.getByRole("textbox", {name:"文稿编辑", exact:true});
    await editor.focus();
    await editor.press("ControlOrMeta+End");
    execFileSync("osascript", ["-e", 'tell application "System Events" to keystroke "zhongwen"']);
    execFileSync("osascript", ["-e", 'tell application "System Events" to key code 49']);
    await expect(editor.locator(".cm-line").last()).toContainText("中文");
    await editor.press("ControlOrMeta+s");
    await expect.poll(async () => (await page.evaluate(async id => (window as any).hetuDesktop.read("hetu.documents.get", {document_id:id}), refs.document.document.document_id)).data.content).toContain("中文");
  } finally { await app.close(); }
});
