import {test, expect, _electron as electron, type ElectronApplication} from "@playwright/test";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {execFileSync, spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import {AppServer} from "../src/main/rpc.ts";
import {navigate, closeApplication, observeApplicationShutdown} from "./navigation.ts";
import {fixtureBinary, machineBinary} from "./acceptance-paths.ts";
import {selectedKeyboardSources, nativeImeInput, inspectImeCandidate, selectImeCandidate} from "./fixtures/native-ime.ts";

test("macOS Sogou 拼音真实组合输入写入隔离作品", async ({}, info) => {
  test.skip(process.env.HETU_LIVE_IME !== "1" || process.platform !== "darwin", "需显式启用macOS系统输入法验收");
  const sources = selectedKeyboardSources();
  test.skip(!sources.some(source => source["Bundle ID"] === "com.sogou.inputmethod.sogou"), "当前未选择Sogou，不改系统输入法设置");
  expect(process.env.HETU_NATIVE_IME_HELPER).toBeTruthy(); test.setTimeout(180000);
  const root = path.resolve(import.meta.dirname, "../../.."), directory = await mkdtemp(path.join(tmpdir(), "hetu-native-ime-"));
  const workspace = path.join(directory, "work"), profile = path.join(directory, "profile"), collaboration = path.join(directory, "collaboration");
  await mkdir(profile);
  const fixture = spawnSync(fixtureBinary("baseline_fixture"), [workspace, collaboration], {encoding: "utf8"});
  expect(fixture.status, fixture.error?.message ?? fixture.stderr).toBe(0); const refs = JSON.parse(fixture.stdout);
  const core = await AppServer.open(machineBinary("hetu-app-server"), workspace);
  try {
    const saved = await core.request("workspace/request", {action: "hetu.documents.save", input: {document_id: refs.document.document.document_id, base_revision_id: refs.document.revision.revision_id, content: "段首。\n", source_format: "markdown", operation_key: "native-ime-fixture"}, contract_revision: "1"});
    expect(saved.status).toBe("succeeded");
  } finally {await core.close();}
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: refs.novel.workspace_id, works: [{work_ref: refs.novel, title: "系统输入验收"}]}]}));
  const executable = process.env.HETU_PACKAGED_APP;
  const env = {...process.env, HETU_DESKTOP_PROFILE: profile, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "LocalSettings"), HETU_PLUGIN_STATE_DIR: profile, HETU_COLLABORATION_DIR: collaboration,
    ...(!executable ? {HETU_APP_SERVER: machineBinary("hetu-app-server"), HETU_CLI: machineBinary("hetu"), HETU_MCP: machineBinary("hetu-mcp")} : {})};
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch({...executable ? {executablePath: executable, args: []} : {args: [path.join(root, "apps/desktop")]}, env});
  let app: ElectronApplication | undefined = await launch(), failed = false;
  const candidateChecks: unknown[] = []; let events: unknown[] = [];
  try {
    await observeApplicationShutdown(app, info.outputPath("shutdown.jsonl"));
    const page = await app.firstWindow(); await page.setViewportSize({width: 1440, height: 940});
    await page.getByRole("button", {name: "打开作品 默认小说", exact: true}).click(); await navigate(page, "小说");
    const editor = page.getByRole("textbox", {name: "文稿编辑", exact: true}); await expect(editor).toBeVisible();
    await page.evaluate(async () => {const state = await window.hetuDesktop.settings("preferences"); await window.hetuDesktop.settings("update", {expected_revision: state.revision, patch: {autosave: false}});});
    await editor.press("ControlOrMeta+End");
    await page.evaluate(() => {
      (window as any).__documentImeEvents = [];
      for (const type of ["compositionstart", "compositionupdate", "compositionend"]) document.addEventListener(type, event => {
        if (!(event.target as Element).closest('.cm-content[role="textbox"]')) return;
        (window as any).__documentImeEvents.push({type, data: (event as CompositionEvent).data});
      }, true);
    });
    const pid = app.process().pid!;
    await app.evaluate(({app, BrowserWindow}) => {app.focus({steal: true}); BrowserWindow.getAllWindows()[0]?.focus();}); await editor.focus();
    await expect.poll(() => Number(execFileSync("osascript", ["-e", 'tell application "System Events" to get unix id of first application process whose frontmost is true'], {encoding: "utf8"}).trim())).toBe(pid);
    nativeImeInput(pid, 'keystroke "zhongwen"');
    await expect.poll(() => page.evaluate(() => (window as any).__documentImeEvents.some((event: any) => event.type === "compositionstart"))).toBe(true);
    let candidateIndex: number | null = null;
    await expect.poll(() => {const result = inspectImeCandidate(pid, "中文"); candidateChecks.push(result); expect(result.frontmost_matches).toBe(true); candidateIndex = result.candidate_index; return result.candidate_ready;}, {timeout: 15000}).toBe(true);
    await page.screenshot({path: info.outputPath("candidate-ready.png")}); selectImeCandidate(pid, candidateIndex!);
    await expect.poll(() => page.evaluate(() => (window as any).__documentImeEvents.filter((event: any) => event.type === "compositionend").at(-1)?.data)).toBe("中文");
    events = await page.evaluate(() => (window as any).__documentImeEvents);
    await expect(editor.locator(".cm-line").last()).toHaveText("中文");
    const read = () => page.evaluate(async id => (await window.hetuDesktop.read("hetu.documents.get", {document_id: id})).data, refs.document.document.document_id);
    const before = await read(); expect(before.content).toBe("段首。\n");
    await editor.press("ControlOrMeta+z"); await expect(editor).not.toContainText("中文");
    await editor.press("ControlOrMeta+Shift+z"); await expect(editor.locator(".cm-line").last()).toHaveText("中文");
    await editor.press("ControlOrMeta+s"); await expect.poll(async () => (await read()).content).toBe("段首。\n中文");
    const saved = await read(); expect(saved.revision.revision_id).not.toBe(before.revision.revision_id);
    await page.screenshot({path: info.outputPath("saved-chinese.png")});
    await closeApplication(app); app = undefined; app = await launch();
    const reopened = await app.firstWindow(); await reopened.getByRole("button", {name: "打开作品 默认小说", exact: true}).click(); await navigate(reopened, "小说");
    await expect(reopened.getByRole("textbox", {name: "文稿编辑", exact: true}).locator(".cm-line").last()).toHaveText("中文");
    const restored = await reopened.evaluate(async id => (await window.hetuDesktop.read("hetu.documents.get", {document_id: id})).data, refs.document.document.document_id);
    expect(restored.content).toBe(saved.content); expect(restored.revision.revision_id).toBe(saved.revision.revision_id);
    await writeFile(info.outputPath("result.json"), JSON.stringify({packaged: !!executable, runtime: await app.evaluate(({app}) => ({version: app.getVersion(), executable: process.execPath})), committed: "中文", undo_redo_preserved: true, saved_and_reopened: true, model_requests: 0, settings_changed: false, candidateChecks, events}, null, 2) + "\n");
  } catch (error) {
    failed = true;
    const page = app?.windows()[0]; events = await page?.evaluate(() => (window as any).__documentImeEvents).catch(() => events) ?? events;
    await page?.screenshot({path: info.outputPath("failure.png")}).catch(() => {});
    await writeFile(info.outputPath("failure.json"), JSON.stringify({error: String(error), candidateChecks, events}, null, 2) + "\n"); throw error;
  } finally {
    try {expect(selectedKeyboardSources()).toEqual(sources); await writeFile(info.outputPath("input-source-preserved.json"), JSON.stringify({keyboard_source_unchanged: true, temporary_language_toggle: false}) + "\n");}
    finally {if (app) try {await closeApplication(app);} catch (error) {if (!failed) throw error; await writeFile(info.outputPath("shutdown-failure.json"), JSON.stringify({error: String(error)}, null, 2) + "\n");}}
  }
});
