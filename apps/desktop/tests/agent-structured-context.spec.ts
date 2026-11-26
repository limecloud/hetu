import {test, expect, _electron as electron} from "@playwright/test";
import {mkdtemp, mkdir, writeFile, readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import {fixtureBinary, machineBinary} from "./acceptance-paths.ts";
import {AppServer} from "../src/main/rpc.ts";
import {defaultSessionId, recordPath} from "../src/main/agent/session-storage.ts";
import {agentSessionSandbox} from "../src/main/agent/context.ts";
import {navigate, closeApplication} from "./navigation.ts";

const root = path.resolve(import.meta.dirname, "../../..");
for (const kind of ["drama", "video"] as const) test(`${kind} GUI选择固定来源、关闭迟到读取及原修订发送`, async ({}, info) => {
  test.skip(process.platform === "win32", "当前隔离协议引擎使用Unix启动脚本"); test.setTimeout(180000);
  const folder = await mkdtemp(path.join(os.tmpdir(), "hetu-structured-context-")), profile = path.join(folder, "profile"), workspace = path.join(folder, "work"), collaboration = path.join(folder, "collaboration"), engine = path.join(folder, "codex");
  const seed = spawnSync(fixtureBinary("baseline_fixture"), [workspace, collaboration], {encoding: "utf8"});
  expect(seed.status, seed.error?.message ?? seed.stderr).toBe(0); const refs = JSON.parse(seed.stdout), work = refs[kind];
  const core = await AppServer.open(machineBinary("hetu-app-server"), workspace);
  const call = async (action: string, input: any) => {const value = await core.request("workspace/request", {action, input, contract_revision: "1"}); expect(value.status, JSON.stringify(value)).toBe("succeeded"); return value.data;};
  const projectRef = (value: any) => ({video_project_id: value.project.video_project_id, revision: value.project.revision, sha256: value.sha256});
  let originalDocument: any, source: string, oldEpisode: any;
  if (kind === "drama") {
    const documents = await call("hetu.documents.list", {work_ref: work}); originalDocument = documents.documents[0];
    source = Array.from({length: 21}, (_, i) => `.同名场次\n\n${i === 0 ? "雨夜🌿。".repeat(20000) : `第${i + 1}场原文。`}\n\n`).join("");
    await call("hetu.documents.save", {document_id: originalDocument.document_id, base_revision_id: originalDocument.current_revision_id, source_format: "fountain", content: source, operation_key: "long-scenes"});
    const project = await call("hetu.drama.projects.get", {project_id: work.object_id});
    const episode = await call("hetu.drama.episodes.create", {project_ref: {project_id: work.object_id, revision: project.project.revision, sha256: project.sha256}, title: "同名分集", language_tag: "zh-CN", operation_key: "second-scene-episode"});
    await call("hetu.documents.save", {document_id: episode.document.document_id, base_revision_id: episode.document.current_revision_id, source_format: "fountain", content: ".同名场次\n\n第二集原文。", operation_key: "second-scene"});
  } else {
    oldEpisode = await call("hetu.video.episodes.get", {video_episode_id: refs.episode_id});
    const project = await call("hetu.video.projects.get", {video_project_id: work.object_id});
    await call("hetu.video.episodes.create", {project_ref: projectRef(project), title: oldEpisode.episode.title, brief: "同名第二集", operation_key: "second-video-episode"});
  }
  const workTitle = (await call("hetu.works.get", {work_ref: work})).summary.title;
  await mkdir(profile, {recursive: true});
  await writeFile(path.join(profile, "creative-library.json"), JSON.stringify({schema_version: 1, roots: [{path: workspace, workspace_id: work.workspace_id, works: [{work_ref: work, title: workTitle}]}]}));
  await mkdir(path.dirname(recordPath(profile, work)), {recursive: true});
  await writeFile(recordPath(profile, work), JSON.stringify({schema_version: 1, session_id: defaultSessionId(work), title: "固定来源会话", cwd: agentSessionSandbox(profile, work), work_ref: work, surface: "gui", thread_id: kind + "-source-thread", messages: [], updated_at: "2026-11-26T00:00:00Z"}));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(engine, "#!/bin/sh\nexec " + [process.execPath, path.join(root, "apps/desktop/tests/fixtures/context-engine.mjs"), folder].map(quote).join(" ") + " \"$@\"\n", {mode: 0o755});
  const executable = process.env.HETU_PACKAGED_APP;
  const launch = () => electron.launch({...(executable ? {executablePath: executable, args: []} : {args: [path.join(root, "apps/desktop")]}), env: {...process.env, HETU_DESKTOP_PROFILE: profile, HETU_COLLABORATION_DIR: collaboration, HETU_LOCAL_SETTINGS_DIR: path.join(profile, "settings"), HETU_PLUGIN_STATE_DIR: profile, HETU_CODEX_BIN: engine, ...(!executable ? {HETU_APP_SERVER: machineBinary("hetu-app-server"), HETU_CLI: machineBinary("hetu"), HETU_MCP: machineBinary("hetu-mcp"), HETU_PLUGIN_NODE: process.execPath} : {})}});
  let app = await launch();
  const enter = async () => {const page = await app.firstWindow(); await page.setViewportSize({width: 1440, height: 960}); await page.getByRole("button", {name: "打开作品 " + workTitle, exact: true}).click(); await navigate(page, "Agent 协作"); await expect(page.locator(".agent-chat")).toBeVisible(); return page;};
  try {
    let page = await enter(); const get = () => page.evaluate(() => window.hetuDesktop.agentSession("get"));
    const title = kind === "drama" ? "剧本场次" : "视频分集与成果";
    const open = async () => {await page.getByLabel("附加上下文", {exact: true}).click(); await page.getByRole("button", {name: title, exact: true}).click();};
    await page.getByRole("textbox", {name: "发送给 Agent", exact: true}).fill("保留当前草稿🌿");
    await app.evaluate(({ipcMain}, kind) => {
      const handlers = (ipcMain as any)._invokeHandlers, original = handlers.get("desktop:read"), state = globalThis as any;
      state.contextReads = 0; state.holdSource = true;
      handlers.set("desktop:read", async (...args: any[]) => {
        if (args[1] !== (kind === "drama" ? "hetu.documents.scene_index" : "hetu.video.projects.get")) return original(...args);
        state.contextReads++; const value = await original(...args);
        if (state.failSource) {state.failSource = false; throw Error("隔离来源目录暂时不可读");}
        if (state.holdSource) {state.holdSource = false; await new Promise<void>(resolve => {state.releaseSource = resolve;});}
        return value;
      });
      const video = handlers.get("desktop:video"); state.mediaReads = 0;
      handlers.set("desktop:video", (...args: any[]) => {if (args[1] === "list") state.mediaReads++; return video(...args);});
    }, kind);
    await open(); const picker = page.getByRole("dialog", {name: title, exact: true});
    await expect.poll(() => app.evaluate(() => typeof (globalThis as any).releaseSource)).toBe("function");
    await picker.getByRole("button", {name: "关闭上下文选择", exact: true}).click();
    await app.evaluate(() => (globalThis as any).releaseSource());
    await expect(picker).toHaveCount(0); await expect(page.getByLabel("附加上下文", {exact: true})).toBeFocused();
    if (kind === "video") expect(await app.evaluate(() => (globalThis as any).mediaReads)).toBe(0);
    await app.evaluate(() => { (globalThis as any).failSource = true; });
    await open();
    await expect(picker.getByRole("alert")).toHaveText("隔离来源目录暂时不可读");
    await expect(picker.getByText("没有匹配的剧本场次。", {exact: true})).toHaveCount(0);
    await expect(picker.getByText("没有匹配的视频内容。", {exact: true})).toHaveCount(0);
    await picker.getByRole("button", {name: "重新读取", exact: true}).click();
    await expect(picker.getByRole("status")).toHaveCount(0);
    const search = picker.getByRole("searchbox", {name: kind === "drama" ? "查找剧本场次" : "查找视频内容", exact: true});
    await search.fill("没有出现的来源名称"); await picker.getByRole("button", {name: "查找", exact: true}).click();
    await expect(picker).toContainText(kind === "drama" ? "没有匹配的剧本场次。" : "没有匹配的视频内容。");
    await search.fill(""); await picker.getByRole("button", {name: "查找", exact: true}).click();
    if (kind === "drama") {
      await expect(picker.locator(".agent-context-picker-items > button")).toHaveCount(20);
      await picker.getByRole("button", {name: "更多场次", exact: true}).click();
      await expect(picker.locator(".agent-context-picker-items > button")).toHaveCount(22);
      await expect(picker).toContainText("第2集 同名分集");
      await expect(search).toBeInViewport();
      await page.screenshot({path: info.outputPath("scene-picker-wide.png")});
      await page.setViewportSize({width: 760, height: 800});
      expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({path: info.outputPath("scene-picker-narrow.png")});
      await picker.locator(".agent-context-picker-items > button").first().click();
    } else {
      await expect(picker).toContainText("雨夜第一版");
      await picker.getByRole("button", {name: /雨夜第一版/}).click();
      await open(); await picker.getByRole("combobox", {name: "视频内容类型", exact: true}).selectOption("episodes");
      await expect(picker.locator(".agent-context-picker-items > button")).toHaveCount(2);
      await expect(picker).toContainText("第1集"); await expect(picker).toContainText("第2集");
      await page.screenshot({path: info.outputPath("video-episode-picker-wide.png")});
      const preferences = await page.evaluate(() => window.hetuDesktop.settings("preferences"));
      await page.evaluate(revision => window.hetuDesktop.settings("update", {expected_revision: revision, patch: {appearance: "dark"}}), preferences.revision);
      await page.setViewportSize({width: 760, height: 800});
      expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({path: info.outputPath("video-episode-picker-dark-narrow.png")});
      await picker.locator(".agent-context-picker-items > button").first().click();
    }
    await expect(picker).toHaveCount(0);
    await expect.poll(async () => (await get()).context_refs?.length).toBe(kind === "drama" ? 1 : 2);
    const fixed = (await get()).context_refs;
    expect(fixed).toHaveLength(kind === "drama" ? 1 : 2); expect(JSON.stringify(fixed).length).toBeLessThan(5000);
    await expect(page.getByRole("textbox", {name: "发送给 Agent", exact: true})).toHaveValue("保留当前草稿🌿");
    if (kind === "drama") {
      const ref = fixed[0].reference.object_ref;
      const view = await call("hetu.documents.scene_index", {work_ref: work, ...ref});
      expect(view.complete).toBe(false); expect(view.content).toContain("雨夜🌿");
      await call("hetu.documents.save", {document_id: originalDocument.document_id, base_revision_id: ref.revision_id, source_format: "fountain", content: ".新场次\n\n新版正文。", operation_key: "advance-scene-source"});
    } else {
      const episode = fixed.find((item: any) => item.reference.object_ref.video_episode_id).reference.object_ref;
      const project = await call("hetu.video.projects.get", {video_project_id: work.object_id});
      await call("hetu.video.episodes.update", {project_ref: projectRef(project), video_episode_id: episode.video_episode_id, expected: {revision: episode.revision, sha256: episode.sha256}, title: "新版分集名", brief: "保留旧来源", archived: false, operation_key: "advance-video-source"});
    }
    await page.setViewportSize({width: 760, height: 800}); await page.screenshot({path: info.outputPath(kind + "-fixed-context.png")});
    await closeApplication(app); app = await launch(); page = await enter();
    expect((await get()).context_refs).toEqual(fixed);
    const damaged = structuredClone(fixed);
    if (kind === "drama") damaged[0].reference.object_ref.sha256 = "f".repeat(64);
    else damaged[0].reference.object_ref.media_ref.sha256 = "f".repeat(64);
    await page.evaluate(async refs => {const current = await window.hetuDesktop.agentSession("get"); await window.hetuDesktop.agentSession("draft", {session_id: current.session_id, generation: current.generation, surface: "gui", text: "请保留原草稿", context_refs: refs});}, damaged);
    await page.getByRole("button", {name: "发送", exact: true}).click();
    await expect(page.locator(".agent-chat-send-error")).toContainText("暂时无法核对");
    await expect(page.getByRole("textbox", {name: "发送给 Agent", exact: true})).toHaveValue("请保留原草稿");
    expect(await readFile(path.join(folder, "sent.jsonl"), "utf8").catch(() => "")).toBe("");
    await page.evaluate(async refs => {const current = await window.hetuDesktop.agentSession("get"); await window.hetuDesktop.agentSession("draft", {session_id: current.session_id, generation: current.generation, surface: "gui", text: "请保留原草稿", context_refs: refs});}, fixed);
    await page.getByRole("textbox", {name: "发送给 Agent", exact: true}).fill("只读核对原固定来源");
    await page.getByRole("button", {name: "发送", exact: true}).click();
    await expect.poll(async () => (await get()).messages.some((item: any) => item.role === "user" && item.text === "只读核对原固定来源")).toBe(true);
    expect((await get()).messages.find((item: any) => item.role === "user").context_refs).toEqual(fixed);
    expect((await readFile(path.join(folder, "sent.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
    await info.attach("fixed-context-result", {contentType: "application/json", body: JSON.stringify({kind, fixed_refs: fixed, old_revision_kept: true, close_stops_late_read: true, model_turns: 0, isolated_protocol_rounds: 1})});
  } finally {await closeApplication(app); await core.close();}
});
