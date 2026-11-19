import {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  protocol,
  session,
  clipboard,
  nativeTheme,
  Menu,
  shell,
  type IpcMainInvokeEvent,
  type Session,
} from "electron";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { RecoveryStore } from "./recovery.ts";
import { pluginResultHandoff } from "./plugin-results.ts";
import { pluginService } from "./plugin-services.ts";
import { exportPluginFile } from "./plugin-export.ts";
import { savePluginArtifact } from "./plugin-artifact.ts";
import { SettingsReview } from "./settings.ts";
import { AgentConnectionInstall } from "./agent-connection-install.ts";
import { SettingsWindow } from "./settings-window.ts";
import { workAssociation, workAgentRequest } from "./work-agent.ts";
import { CoverReview } from "./covers.ts";
import { NovelDetails } from "./novel-details.ts";
import { CanonReview } from "./canon.ts";
import { TaskReview, type TaskRef } from "./task-review.ts";
import { Authoring } from "./authoring.ts";
import { ManagementReview } from "./management.ts";
import { VersionReview } from "./versions.ts";
import { PluginMigrationReview } from "./plugin-migrations.ts";
import { ResourceReview } from "./resources.ts";
import { MediaAccess } from "./media.ts";
import { VideoReview } from "./video-review.ts";
import { OutlineReview } from "./outlines.ts";
import { scopedCli } from "./cli.ts";
import { CreativeLibrary } from "./library.ts";
import {
  PluginHost,
  PluginInstallations,
  type InstallationState,
  PluginPackage,
  resourcePath,
  BackendSupervisor,
} from "@hetu/plugin-host";
import {
  sameWork,
  supportsWork,
  type WorkRef,
  type Result,
  type PluginManifest,
} from "@hetu/plugin-sdk";
import { AppServer } from "./rpc.ts";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "hetu-app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "hetu-plugin",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "hetu-media",
    privileges: { standard: true, secure: true, stream: true },
  },
]);
const dist = __dirname,
  root = path.resolve(dist, "../../..");
let host = new PluginHost();
let window: BrowserWindow,
  server: AppServer | undefined,
  work: WorkRef | undefined,
  epoch = 0,
  dirty = false,
  workspaceRoot = "";
let surface: WebContentsView | undefined,
  backend: BackendSupervisor | undefined;
let taskReview: TaskReview | undefined;
let authoring: Authoring | undefined;
let management: ManagementReview | undefined;
let versions: VersionReview | undefined;
let resources: ResourceReview | undefined;
let media: MediaAccess | undefined;
let videoReview: VideoReview | undefined;
let outlineReview: OutlineReview | undefined;
let pluginMedia: MediaAccess | undefined;
const pluginMediaUrls = new Set<string>();
let library: CreativeLibrary;
let settingsServer: AppServer;
let settings: SettingsReview;
let agentConnectionInstall: AgentConnectionInstall;
let covers: CoverReview | undefined;
let novelDetails: NovelDetails | undefined;
let canon: CanonReview | undefined;
let localState: any;
function agentClient() {
  const selected = localState ? workAssociation(localState, work).client : "codex";
  return ({ claudeCode: "claude-code", other: "generic", none: "generic" } as Record<string, string>)[selected] ?? selected;
}
async function refreshSettings() {
  localState = await settings.get();
  nativeTheme.themeSource = localState.preferences.appearance;
  if (window && !window.isDestroyed()) window.webContents.send("desktop:preferences", localState.preferences);
  settingsWindow.preferences(localState.preferences);
  if (surface && !surface.webContents.isDestroyed()) surface.webContents.send("plugin:preferences", {theme:localState.preferences.appearance,language:localState.preferences.language??"zh-CN"});
  return localState;
}
async function selectClient(client: string) {
  if (!["codex", "claude-code", "workbuddy", "generic"].includes(client)) throw new Error("请选择支持的外部 Agent 客户端。");
  const state = await refreshSettings();
  const value = ({ "claude-code": "claudeCode", generic: "other" } as Record<string, string>)[client] ?? client;
  if (work) {
    await settings.selection("associate", { expected_revision: state.revision, work_ref: structuredClone(work), agent_client: value, suite_id: workAssociation(state, work).suite });
    await settings.acknowledge();
    await refreshSettings();
    return;
  }
  const preview = await settings.manual(state.revision, { agent_client: value });
  await settings.commit(preview.token);
  await settings.acknowledge();
  await refreshSettings();
}
let bounds = { x: 248, y: 148, width: 800, height: 600 };
let binding:
  | {
      sender: number;
      token: string;
      owner: string;
      view: string;
      work: WorkRef;
      epoch: number;
      package_sha256: string;
    }
  | undefined;
let prefs: InstallationState = { packages: [], grants: {} };
let installations: PluginInstallations, installationSha = "", pluginTransition = false;
let pluginStateError = "";
async function reloadPlugins(force = false) {
  let loaded: Awaited<ReturnType<PluginInstallations["read"]>>;
  try { loaded = await installations.read(); }
  catch (error) {
    // 可选扩展状态损坏不能阻断随包基础作品；原文件保留，写入仍失败关闭。
    const message = error instanceof Error ? error.message : "插件状态无法读取。";
    if (pluginStateError === message && !force) return;
    await closeSurface();
    for (const state of host.states()) await host.disable(state.id);
    host = new PluginHost(); prefs = { packages: [], grants: {} }; installationSha = "";
    pluginStateError = message;
    if (window && !window.isDestroyed()) window.webContents.send("desktop:plugins-changed", overview());
    return;
  }
  if (!force && loaded.sha256 === installationSha) return;
  const next = await installations.host(loaded.state);
  await closeSurface();
  for (const state of host.states()) await host.disable(state.id);
  host = next; prefs = loaded.state; installationSha = loaded.sha256; pluginStateError = "";
  if (window && !window.isDestroyed()) window.webContents.send("desktop:plugins-changed", overview());
}
async function applyPlugin(input: Record<string, unknown>) {
  if (pluginStateError) throw new Error(pluginStateError + " 请保留插件状态文件并修复，基础创作仍可使用。");
  pluginTransition = true;
  try {
    await closeSurface();
    await installations.apply({ ...input, expected_sha256: installationSha, client_adapter: "desktop", operation_key: randomUUID() }, revokePackage);
    await reloadPlugins(true);
    return overview();
  } finally { pluginTransition = false; }
}
const mime = (name: string) =>
  ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
  })[path.extname(name)] ?? "application/octet-stream";
const policy = (text: string) =>
  text.replace(
    /\[(.*?)\]/g,
    (_, key) => String.fromCharCode(39) + key + String.fromCharCode(39),
  );
const recovery = new RecoveryStore();
let flushedClose = false;
const appUrl = "hetu-app://shell/index.html";
const settingsWindow = new SettingsWindow(path.join(dist, "shell-preload.cjs"), appUrl);
function denyPermissions(s: Session) {
  s.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  s.setPermissionCheckHandler(() => false);
  s.on("will-download", (event) => event.preventDefault());
}
function harden(view: WebContentsView) {
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (event) => event.preventDefault());
  view.webContents.on("will-redirect", (event) => event.preventDefault());
}
function trusted(event: IpcMainInvokeEvent, channel: string) {
  if (settingsWindow.accepts(event, channel)) return;
  if (
    event.sender !== window.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame.url !== appUrl
  )
    throw new Error("此通道只供可信工作台使用。");
}
function pluginCaller(event: IpcMainInvokeEvent) {
  if (
    !binding ||
    event.sender.id !== binding.sender ||
    event.senderFrame !== event.sender.mainFrame ||
    !event.senderFrame?.url.startsWith(
      "hetu-plugin://" + binding.token + "/",
    ) ||
    binding.epoch !== epoch ||
    !host.active(binding.owner)
  )
    throw new Error("插件会话已关闭或过期。");
  return binding;
}
function unwrap(result: any) {
  if (result.status !== "succeeded")
    throw new Error(result.error?.message ?? "操作未完成。");
  return result.data;
}
async function persist() {
  installationSha = await installations.save(prefs, installationSha);
}
async function core(action: string, input: unknown = {}) {
  if (!server) throw new Error("请先打开作品。");
  return server.request("workspace/request", {
    action,
    contract_revision: "1",
    input,
  });
}
async function flushSurface() {
  if (!surface || surface.webContents.isDestroyed() || !binding) return;
  const sender = surface.webContents.id, token = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: string) => {
      clearTimeout(timer);
      ipcMain.removeListener("plugin:flush-result", listener);
      error ? reject(new Error(error)) : resolve();
    };
    const listener = (event: Electron.IpcMainEvent, received: string, error: string | null) => {
      if (event.sender.id === sender && received === token) finish(error ?? undefined);
    };
    const timer = setTimeout(() => finish("插件恢复稿未完成，请保留当前视图后重试。"), 5000);
    ipcMain.on("plugin:flush-result", listener);
    surface!.webContents.send("plugin:flush", token);
  });
}
async function closeSurface() {
  await flushSurface();
  await pluginMedia?.dispose();
  pluginMedia = undefined;
  pluginMediaUrls.clear();
  binding = undefined;
  if (surface) {
    window.contentView.removeChildView(surface);
    surface.webContents.close();
    surface = undefined;
  }
  const oldBackend = backend;
  backend = undefined;
  await oldBackend?.dispose().catch(() => {});
}
function requestPluginReturn() {
  if (binding && !window.isDestroyed())
    window.webContents.send("desktop:close-plugin", { owner: binding.owner, view: binding.view, epoch: binding.epoch });
}
function layout() {
  if (!surface) return;
  const [width, height] = window.getContentSize();
  surface.setBounds({
    x: Math.min(bounds.x, width),
    y: Math.min(bounds.y, height),
    width: Math.max(0, Math.min(bounds.width, width - bounds.x)),
    height: Math.max(0, Math.min(bounds.height, height - bounds.y)),
  });
}
async function pluginContext(owner: string) {
  if (!server || !work || !host.active(owner)) throw new Error("请选择作品并启用对应插件。");
  const selectedServer = server, selectedWork = work, selectedEpoch = epoch, pkg = host.package(owner);
  const check = () => {
    if (server !== selectedServer || epoch !== selectedEpoch || !work || !sameWork(work, selectedWork)
      || !host.active(owner) || host.package(owner).sha256 !== pkg.sha256)
      throw new Error("作品或插件包已变化，请重新读取。");
  };
  check();
  return { work: selectedWork, context: {plugin_id:owner,package_sha256:pkg.sha256,work_ref:selectedWork,types:pkg.manifest.contributions.data}, packageSha: pkg.sha256, call: (method: string, params: Record<string, unknown>) => selectedServer.request(method, params), check };
}
const pluginMigrations = new PluginMigrationReview(pluginContext);
function pluginMachineConnection(owner: string, selectedWork: WorkRef) {
  const pkg = host.package(owner);
  return { plugin_id: owner, package_sha256: pkg.sha256, access_mode: "open", work_ref: selectedWork,
    workspace_path: workspaceRoot, package_path: pkg.source, state_directory: installations.directory, access_directory: process.env.HETU_PLUGIN_ACCESS_DIR ?? null,
    core_cli: process.env.HETU_PLUGIN_CLI ?? path.join(app.isPackaged ? process.resourcesPath : root,
      app.isPackaged ? "bin" : "target/debug", process.platform === "win32" ? "hetu-plugin.exe" : "hetu-plugin"),
    runtime: path.join(dist, "plugin-runtime.mjs"), node_executable: pluginNodeBinary() };
}
async function pluginRequest(
  current: NonNullable<typeof binding>,
  action: string,
  input: Record<string, unknown>,
): Promise<Result<any>> {
  if (
    current !== binding ||
    current.epoch !== epoch ||
    !host.active(current.owner) ||
    !server
  )
    throw new Error("插件上下文已变化。");
  const pkg = host.package(current.owner);
  if (pkg.sha256 !== current.package_sha256) throw new Error("插件包已变化，请重新发现。");
  return server.request("plugins/request", {
    context: { plugin_id: current.owner, package_sha256: current.package_sha256,
      work_ref: current.work, types: pkg.manifest.contributions.data },
    request: { action, contract_revision: "1", input },
  });
}
function serverBinary() {
  return (
    process.env.HETU_APP_SERVER ??
    path.join(
      app.isPackaged ? process.resourcesPath : root,
      app.isPackaged ? "bin" : "target/debug",
      process.platform === "win32" ? "hetu-app-server.exe" : "hetu-app-server",
    )
  );
}
function coreCliBinary() {
  return (
    process.env.HETU_CLI ??
    path.join(
      app.isPackaged ? process.resourcesPath : root,
      app.isPackaged ? "bin" : "target/debug",
      process.platform === "win32" ? "hetu.exe" : "hetu",
    )
  );
}
function pluginNodeBinary() {
  return (
    process.env.HETU_PLUGIN_NODE ??
    (app.isPackaged
      ? path.join(
          process.resourcesPath,
          "bin",
          process.platform === "win32" ? "node.exe" : "node",
        )
      : (process.env.npm_node_execpath ?? "node"))
  );
}
async function scopedReview(action: string, input: Record<string, unknown>) {
  const context = collaborationContext(agentClient());
  const status = await context.status();
  if (!status.authorized)
    throw new Error(
      "请先在 Agent 协作中授权当前作品，再读取该客户端准备的方案。",
    );
  const result = await scopedCli(
    coreCliBinary(),
    context.client,
    process.env.HETU_COLLABORATION_DIR,
    action,
    { ...input, management_ref: status.management_ref },
  );
  context.check();
  return result;
}
async function revokePackage(pkg: Pick<PluginPackage, "manifest" | "sha256">) {
  const local = server ?? (await AppServer.open(serverBinary()));
  try {
    await local.request("extensions/disable", {
      plugin_id: pkg.manifest.id,
      package_sha256: pkg.sha256,
    });
    for (const key of Object.keys(prefs.grants))
      if (JSON.parse(key)[0] === pkg.manifest.id) delete prefs.grants[key];
  } finally {
    if (local !== server) await local.close();
  }
}
function overview() {
  return {
    plugin_state_error: pluginStateError || undefined,
    works: library?.rows() ?? [],
    work,
    epoch,
    agentClient: agentClient(),
    preferences: localState?.preferences,
    plugins: [
      ...host.states().map((state) => ({
        ...state,
        display: host.package(state.id).manifest.display,
        description: host.package(state.id).manifest.description,
        version: host.package(state.id).manifest.version,
        work_kinds: host.package(state.id).manifest.work_kinds,
      })),
      ...prefs.packages
        .filter((p) => p.manifest && !host.has(p.manifest.id))
        .map((p) => ({
          id: p.manifest!.id,
          installed: false,
          selected: false,
          state: p.removed ? "uninstalled" : "unavailable",
          reason: host.loadErrors.get(p.manifest!.id),
          display: p.manifest!.display,
          description: p.manifest!.description,
          version: p.manifest!.version,
          work_kinds: p.manifest!.work_kinds,
        })),
    ],
    views: host.views
      .list()
      .filter((v) => work && supportsWork(host.package(v.owner).manifest, work))
      .map((v) => ({ key: v.id, owner: v.owner, ...v.value })),
  };
}
async function listWorks(connection: AppServer) {
  const works: any[] = [];
  let cursor: string | undefined;
  do {
    const page = unwrap(
      await connection.request("workspace/request", {
        action: "hetu.works.list",
        contract_revision: "1",
        input: { limit: 100, include_archived: true, ...(cursor ? { cursor } : {}) },
      }),
    );
    works.push(...page.works);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  for (const item of works) {
    if (item.work_ref.kind !== "novel") continue;
    const result = unwrap(await connection.request("workspace/request", {
      action: "hetu.works.get", contract_revision: "1", input: { work_ref: item.work_ref },
    }));
    Object.assign(item, {
      author_name: result.record.metadata.author_name, genre: result.record.metadata.genre,
      status: result.record.metadata.status, chapter_count: result.record.chapters.length,
    });
    try {
      const cover = unwrap(await connection.request("workspace/request", { action: "hetu.covers.get", contract_revision: "1", input: {} }));
      item.cover_preview = cover.preview;
    } catch { item.cover_error = "封面读取失败"; }
  }
  return works;
}
async function openWorkspace(directory: string, expected?: WorkRef) {
  const next = await AppServer.open(serverBinary(), directory);
  let works: any[];
  try {
    works = await listWorks(next);
    if (expected && !works.some((item) => sameWork(item.work_ref, expected)))
      throw new Error("登记位置没有对应创作对象，请刷新并检查工作区身份。");
    await library.register(directory, works);
  } catch (error) {
    await next.close();
    throw error;
  }
  const previous = server;
  server = next;
  workspaceRoot = directory;
  epoch++;
  await media?.dispose();
  media = undefined;
  work = undefined;
  taskReview = undefined;
  authoring = undefined;
  management = undefined;
  versions = undefined;
  resources = undefined;
  videoReview = undefined;
  outlineReview = undefined;
  covers = undefined;
  novelDetails = undefined;
  canon = undefined;
  dirty = false;
  await closeSurface();
  await previous?.close();
  return overview();
}
function collaborationContext(client: string) {
  if (!["codex", "claude-code", "workbuddy", "generic"].includes(client))
    throw new Error("请选择支持的外部 Agent 客户端。");
  if (!server || !work) throw new Error("请先选择作品。");
  const selectedServer = server,
    selectedWork = work,
    selectedEpoch = epoch;
  const check = () => {
    if (
      server !== selectedServer ||
      epoch !== selectedEpoch ||
      !work ||
      !sameWork(work, selectedWork)
    )
      throw new Error("作品已切换，请重新执行协作操作。");
  };
  const call = async (action: string, input: any) => {
    check();
    const result = await selectedServer.request("workspace/request", {
      action,
      input,
      contract_revision: "1",
    });
    check();
    return unwrap(result);
  };
  const base = {
    client_adapter: client,
    ...(process.env.HETU_COLLABORATION_DIR
      ? { collaboration_path: process.env.HETU_COLLABORATION_DIR }
      : {}),
  };
  const status = () =>
    call("hetu.collaboration.workspace_access", {
      ...base,
      work_ref: selectedWork,
    });
  return { client, work: selectedWork, call, check, base, status };
}
async function ensureConnection(client: string) {
  const context = collaborationContext(client);
  const status = await context.status();
  if (status.authorized) return status;
  const answer = await dialog.showMessageBox(window, {
    type: "question",
    buttons: ["取消", "授权当前作品"],
    defaultId: 0,
    cancelId: 0,
    message: "允许 " + client + " 协作当前作品？",
    detail:
      "仅所选创作对象：读取已保存成果并准备固定管理方案、创作任务。正文采纳、定稿和费用批准仍由作者决定；其他作品需要单独授权。",
  });
  if (answer.response !== 1) throw new Error("未授权外部 Agent 访问当前作品。");
  context.check();
  try {
    await context.call("hetu.collaboration.authorize_workspace", {
      ...context.base,
      work_ref: context.work,
      operation_key: randomUUID(),
    });
  } catch (error) {
    // 未知时查询真实状态，不能把旧回执当成当前授权。
    const actual = await context.status();
    if (!actual.authorized) throw error;
  }
  return context.status();
}
function shellHandler(name: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(name, (event, ...args) => {
    trusted(event, name);
    return fn(...args);
  });
}
app
  .whenReady()
  .then(async () => {
    if (process.env.HETU_DESKTOP_PROFILE)
      app.setPath("userData", process.env.HETU_DESKTOP_PROFILE);
    if (process.env.HETU_DESKTOP_PROFILE && !process.env.HETU_LOCAL_SETTINGS_DIR)
      process.env.HETU_LOCAL_SETTINGS_DIR = path.join(app.getPath("userData"), "local-settings");
    if (process.env.HETU_DESKTOP_PROFILE && !process.env.HETU_MODEL_SERVICE_DIR)
      process.env.HETU_MODEL_SERVICE_DIR = path.join(app.getPath("userData"), "model-service");
    if (process.env.HETU_DESKTOP_PROFILE && !process.env.HETU_PLUGIN_STATE_DIR)
      process.env.HETU_PLUGIN_STATE_DIR = app.getPath("userData");
    settingsServer = await AppServer.open(serverBinary());
    settings = new SettingsReview(
      (method, input) => settingsServer.request("local_settings/host", { method, input }),
      recovery, path.join(app.getPath("userData"), "local-settings-journal.json"),
    );
    agentConnectionInstall = new AgentConnectionInstall(
      async (action, input) => unwrap(await scopedCli(coreCliBinary(), "codex", process.env.HETU_COLLABORATION_DIR, action, input)),
      async plan => {
        const preview = await settings.prepare(plan.operation_id, plan.sha256, plan.revision, true);
        const answer = await dialog.showMessageBox(settingsWindow.window ?? window, {
          type: "question", buttons: ["取消", "接入 Codex"], defaultId: 0, cancelId: 0,
          message: "将河图 MCP App 接入 Codex？",
          detail: "通过 Codex 官方入口安装河图机器连接包，不修改账号或授予作品权限。\n机器入口：" + plan.fixed.suite.mcp_binary + "\n安装位置：" + plan.fixed.install_target.package_directory + "\n完成后可能需要刷新或重启 Codex Desktop。",
        });
        if (answer.response !== 1) throw new Error("已取消 Codex 接入。");
        await settings.commit(preview.token); await settings.acknowledge();
      }, recovery, path.join(app.getPath("userData"), "codex-connection-journal.json"),
    );
    await refreshSettings();
    library = new CreativeLibrary(
      path.join(app.getPath("userData"), "creative-library.json"),
      recovery,
      async (directory) => {
        const connection = await AppServer.open(serverBinary(), directory);
        try {
          return await listWorks(connection);
        } finally {
          await connection.close();
        }
      },
    );
    await library.load();
    session.defaultSession.protocol.handle("hetu-app", async (request) => {
      try {
        const url = new URL(request.url);
        if (url.host !== "shell") return new Response(null, { status: 403 });
        const relative = resourcePath(
          decodeURIComponent(url.pathname.slice(1)),
        );
        const bytes = await readFile(path.join(dist, "renderer", relative));
        return new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": mime(relative),
            "Content-Security-Policy": policy(
              relative === "task-view.html"
                ? "default-src [none]; script-src [unsafe-inline]; style-src [unsafe-inline]; img-src data:; connect-src [none]; frame-src [none]; object-src [none]; base-uri [none]; form-action [none]"
                : "default-src [self]; script-src [self]; style-src [self] [unsafe-inline]; img-src [self] data: hetu-media:; media-src hetu-media:; connect-src [none]; frame-src [self]; object-src [none]; base-uri [none]; form-action [none]",
            ),
          },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    session.defaultSession.protocol.handle("hetu-media", request =>
      media?.handle(request) ?? new Response(null, { status: 410 }),
    );
    denyPermissions(session.defaultSession);
    const pluginDirectory = await settingsServer.request("plugins/directory", {});
    installations = new PluginInstallations(pluginDirectory.directory);
    // 仅在共享Owner尚无状态时接纳旧桌面登记；包路径和历史保留原义。
    try {
      await readFile(installations.file);
    } catch (error: any) {
      if (error.code !== "ENOENT") { pluginStateError = "插件状态无法读取。"; }
      else {
      try {
        const saved = JSON.parse(await readFile(path.join(app.getPath("userData"), "plugin-state.json"), "utf8"));
        const empty = await installations.read();
        await installations.save(saved, empty.sha256);
      } catch (error: any) { if (error.code !== "ENOENT") pluginStateError = "旧插件状态无法读取，已保留原文件。"; }
      }
    }
    await reloadPlugins(true);
    const pluginWatcher = setInterval(async () => {
      if (pluginTransition) return;
      pluginTransition = true;
      try { await reloadPlugins(); }
      catch (error) { console.error("插件状态同步失败：", error instanceof Error ? error.message : "未知结果"); }
      finally { pluginTransition = false; }
    }, 1500);
    pluginWatcher.unref();
    window = new BrowserWindow({
      width: 1360,
      height: 900,
      minWidth: 940,
      minHeight: 640,
      title: "河图洛书",
      webPreferences: {
        preload: path.join(dist, "shell-preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const settingsMenu = {
      label: "设置…",
      accelerator: "CmdOrCtrl+,",
      click: () => { void settingsWindow.open(window); },
    };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ label: "河图洛书", submenu: [
        { role: "about" as const, label: "关于河图洛书" },
        { type: "separator" as const }, settingsMenu,
        { type: "separator" as const }, { role: "services" as const },
        { type: "separator" as const }, { role: "hide" as const }, { role: "hideOthers" as const }, { role: "unhide" as const },
        { type: "separator" as const }, { role: "quit" as const },
      ] }] : [{ label: "文件", submenu: [settingsMenu, { type: "separator" as const }, { role: "quit" as const }] }]),
      { role: "editMenu", label: "编辑" },
      { label: "显示", submenu: [
        { label: "返回工作台", accelerator: "Alt+Left", click: requestPluginReturn },
        { role: "togglefullscreen", label: "切换全屏" },
      ] },
      { role: "windowMenu", label: "窗口" },
    ]));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("resize", layout);
    window.on("focus", () => {
      void refreshSettings().then(() => {
        if (!window.isDestroyed()) window.webContents.send("desktop:preferences", localState.preferences);
      }).catch(() => {});
    });
    window.on("close", (event) => {
      if (flushedClose) return;
      event.preventDefault();
      if (
        dirty &&
        dialog.showMessageBoxSync(window, {
          type: "warning",
          buttons: ["取消", "保留恢复稿并退出"],
          defaultId: 0,
          cancelId: 0,
          message: "修改尚未保存到作品。",
        }) === 0
      )
        return;
      void flushSurface()
        .then(() => recovery.flush())
        .then(() => {
          flushedClose = true;
          window.close();
        })
        .catch(() => {
          dialog.showErrorBox(
            "恢复稿未完成",
            "请保留当前窗口，检查本机存储后重试。",
          );
        });
    });
    window.on("closed", () => {
      settingsWindow.close();
      backend?.close();
      if (surface && !surface.webContents.isDestroyed()) surface.webContents.close();
      surface = undefined;
      void media?.dispose().catch(() => {});
      void server?.close();
      void settingsServer?.close();
    });
    shellHandler("desktop:zoom", () => {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    });
    shellHandler("desktop:open", async () => {
      if (
        dirty &&
        (
          await dialog.showMessageBox(window, {
            type: "warning",
            buttons: ["取消", "保留恢复稿并打开"],
            defaultId: 0,
            cancelId: 0,
            message: "当前修改尚未保存。",
          })
        ).response !== 1
      )
        return null;
      const selected = await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
        title: "打开河图作品目录",
      });
      if (selected.canceled) return null;
      return openWorkspace(selected.filePaths[0]);
    });
    shellHandler("desktop:library", async (method: string, input: any = {}) => {
      if (method === "client") {
        if (
          !["codex", "claude-code", "workbuddy", "generic"].includes(
            input.client,
          )
        )
          throw new Error("请选择支持的外部 Agent 客户端。");
        await selectClient(input.client);
        return overview();
      }
      if (method === "refresh") {
        const discovered: any[] = [];
        let cursor: string | undefined;
        do {
          const result = unwrap(
            await scopedCli(
              coreCliBinary(),
              agentClient(),
              process.env.HETU_COLLABORATION_DIR,
              "hetu.collaboration.created_works",
              { limit: 100, ...(cursor ? { cursor } : {}) },
            ),
          );
          discovered.push(...result.works);
          cursor = result.next_cursor ?? undefined;
        } while (cursor);
        await library.refresh(discovered);
        return overview();
      }
      if (method === "open") {
        const directory = library.resolve(input.work_ref);
        if (dirty) throw new Error("请先保存当前修改，再打开另一作品。");
        return openWorkspace(directory, input.work_ref);
      }
      if (method === "bootstrap") {
        const name = { novel: "小说", drama: "原创剧本", video: "独立视频" }[
          input.kind as "novel" | "drama" | "video"
        ];
        if (!name) throw new Error("请选择要创建的作品类型。");
        clipboard.writeText(
          "请使用河图的独立机器入口与我筹备" +
            name +
            "。先发现实际能力，再根据对话固定创作目标、建立独立作品及首任务。不要创建无关的上游作品，不要直接写 .hetu，不通过 GUI 填表；正文、候选和作者决定遵循 Core 合同。\n" +
            JSON.stringify(
              {
                work_type: input.kind,
                client_adapter: agentClient(),
                core_cli: coreCliBinary(),
                ...(process.env.HETU_COLLABORATION_DIR
                  ? {
                      collaboration_directory:
                        process.env.HETU_COLLABORATION_DIR,
                    }
                  : {}),
                first_action: "hetu.collaboration.inspect",
                creation_action: "hetu.creation_projects.create",
              },
              null,
              2,
            ),
        );
        return { copied: true };
      }
      throw new Error("未知创作库用例。");
    });
    shellHandler("desktop:state", async () => { await refreshSettings(); return overview(); });
    shellHandler("desktop:settings-window", (method: string) => {
      if (method === "open") return settingsWindow.open(window);
      if (method === "close") return settingsWindow.close();
      throw new Error("未知设置窗口操作。");
    });
    shellHandler("desktop:models", async (action: string, input: any = {}) => {
      if (action === "account" || action === "verify") {
        const connection = unwrap(await settingsServer.request("model_service/host", { action: "inspect", input: {} }));
        const address = action === "account" ? "https://hetu.limeai.run/console/" : connection.pending?.verification_uri;
        const url = new URL(address);
        if (url.origin !== "https://hetu.limeai.run" || url.pathname !== "/console/" || url.username || url.password)
          throw new Error("模型账号确认地址无效。");
        await shell.openExternal(url.href);
        return { opened: true };
      }
      if (!["inspect", "connect", "poll", "disconnect", "catalog", "custom_save", "channel_select", "select"].includes(action))
        throw new Error("未知模型设置用例。");
      // 密钥仅经可信私有stdio传给Core，不进入通用偏好、提示词或恢复日志。
      return unwrap(await settingsServer.request("model_service/host", { action, input }));
    });
    shellHandler("desktop:work-agent", async (method: string, input: any = {}) => {
      if (!work) throw new Error("请先打开作品。");
      const selected = structuredClone(work), selectedEpoch = epoch;
      const check = () => { if (epoch !== selectedEpoch || !work || !sameWork(work, selected)) throw new Error("作品已切换，请重新读取协作设置。"); };
      return workAgentRequest(method, input, {
        work: selected, directory: workspaceRoot, settings, check, refresh: refreshSettings,
        inspect: params => settingsServer.request("local_settings/host", { method: "inspect_suite", input: params }),
        prepare: async params => unwrap(await scopedCli(coreCliBinary(), agentClient(), process.env.HETU_COLLABORATION_DIR, "hetu.local_settings.prepare", params)),
        choose: async () => { const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"], title: "选择已安装的创作套件" }); return result.canceled ? undefined : result.filePaths[0]; },
        reveal: directory => shell.showItemInFolder(directory),
      });
    });
    shellHandler("desktop:settings-agent", (method: string, input: any = {}) => workAgentRequest(method, input, {
      directory: "", settings, check: () => {}, refresh: refreshSettings,
      inspect: params => settingsServer.request("local_settings/host", { method: "inspect_suite", input: params }),
      prepare: async params => unwrap(await scopedCli(coreCliBinary(), agentClient(), process.env.HETU_COLLABORATION_DIR, "hetu.local_settings.prepare", params)),
      choose: async () => { const result = await dialog.showOpenDialog(settingsWindow.window ?? window, { properties: ["openDirectory"], title: "选择已安装的创作套件" }); return result.canceled ? undefined : result.filePaths[0]; },
      reveal: directory => shell.showItemInFolder(directory),
    }));
    shellHandler("desktop:settings", async (method: string, input: any = {}) => {
      if (method === "get") return { ...(await refreshSettings()), journal: await settings.journal() };
      if (method === "list") return settings.list(input.cursor);
      if (method === "operation") return settings.operation(input.operation_id);
      if (method === "prepare") return settings.prepare(input.operation_id, input.sha256, input.revision, input.approve);
      if (method === "manual") return settings.manual(input.expected_revision, input.patch);
      if (method === "update") {
        const preview = await settings.manual(input.expected_revision, input.patch);
        const result = await settings.commit(preview.token);
        await settings.acknowledge();
        await refreshSettings();
        return result;
      }
      if (method === "recover") { const result = await settings.recover(); await refreshSettings(); return result; }
      if (method === "acknowledge") return settings.acknowledge();
      if (method === "select_suite") {
        return unwrap(await scopedCli(coreCliBinary(), agentClient(), process.env.HETU_COLLABORATION_DIR,
          "hetu.local_settings.prepare", { kind: "agent_suite", suite_id: input.suite_id,
            agent_client: input.agent_client, install: input.install === true,
            summary: "选择创作方法套件" + (input.install === true ? "并安装到所选客户端" : ""), operation_key: randomUUID() }));
      }
      if (method === "commit") {
        const preview = settings.prepared(input.token);
        const answer = await dialog.showMessageBox(settingsWindow.window ?? window, {
          type: "question", buttons: ["取消", "确认"], defaultId: 0, cancelId: 0,
          message: preview.title + "？", detail: "只提交刚才审阅的固定变化。批准方案后，由外部 Agent 执行；不会在此安装或执行生成。",
        });
        if (answer.response !== 1) throw new Error("已取消本机设置决定。");
        const result = await settings.commit(input.token);
        await refreshSettings();
        return result;
      }
      if (method === "handoff" || method === "continue") {
        if (input.work_ref && (!work || !sameWork(work, input.work_ref))) throw new Error("作品已切换，请重新交接。");
        const operation = method === "continue" ? await settings.operation(input.operation_id) : undefined;
        if (operation && (operation.state !== "approved" || operation.is_expired || !operation.is_current))
          throw new Error("请选择当前仍有效的已批准方案。");
        const client = operation?.fixed.client_adapter ?? agentClient();
        clipboard.writeText("请通过河图的独立机器入口处理本机设置。先读取实际偏好与套件目录，再按我的目标准备完整固定方案；我审阅后由你执行原方案。不要读密钥、改账号或声称安装代表本会话已加载。结果未知保留原操作及原键回读。\n" + JSON.stringify({
          client_adapter: client, core_cli: coreCliBinary(), local_settings_directory: process.env.HETU_LOCAL_SETTINGS_DIR,
          ...(process.env.HETU_COLLABORATION_DIR ? { collaboration_directory: process.env.HETU_COLLABORATION_DIR } : {}),
          ...(operation ? { action: "hetu.local_settings.execute", input: { operation_id: operation.operation_id, sha256: operation.sha256,
            operation_key: "execute-" + operation.operation_id } } : { action: "hetu.local_settings.get", input: input.work_ref ? { work_ref: input.work_ref } : {}, section: input.section ?? "preferences" }),
        }, null, 2));
        return { copied: true };
      }
      throw new Error("未知本机设置用例。");
    });
    shellHandler(
      "desktop:connection",
      async (method: string, client: string) => {
        if (method === "install") {
          if (client !== "codex") throw new Error("当前只提供 Codex 受管连接安装。");
          const result = await agentConnectionInstall.run(); await refreshSettings(); return result;
        }
        const context = collaborationContext(client);
        if (method === "select") {
          await selectClient(client);
          return overview();
        }
        if (method === "status") return context.status();
        if (method === "authorize") return ensureConnection(client);
        if (method === "revoke") {
          const status = await context.status();
          if (!status.authorized) return status;
          const decision = await dialog.showMessageBox(window, {
            type: "warning",
            buttons: ["取消", "撤销协作授权"],
            defaultId: 0,
            cancelId: 0,
            message: "撤销 " + client + " 对当前作品的协作授权？",
            detail:
              "旧管理连接及其派生任务将失效，已保存成果和作者意见保留。重新授权不会复活旧任务。",
          });
          if (decision.response !== 1) return status;
          context.check();
          await context.call("hetu.collaboration.revoke_management", {
            ...context.base,
            grant_id: status.management_ref.grant_id,
            operation_key: randomUUID(),
          });
          return context.status();
        }
        throw new Error("未知协作连接能力。");
      },
    );
    shellHandler("desktop:select", async (ref: WorkRef) => {
      if (dirty) throw new Error("请先保存或明确放弃当前修改。");
      unwrap(await core("hetu.works.get", { work_ref: ref }));
      epoch++;
      await media?.dispose();
      media = undefined;
      await closeSurface();
      work = ref;
      const selectedEpoch = epoch,
        selectedServer = server!;
      media = new MediaAccess(ref, selectedServer,
        () => epoch === selectedEpoch && server === selectedServer && !!work && sameWork(work, ref));
      taskReview = new TaskReview(
        ref,
        path.join(app.getPath("userData"), "task-buffers"),
        recovery,
        (action, input) =>
          selectedServer.request("workspace/request", {
            action,
            input,
            contract_revision: "1",
          }),
        () =>
          epoch === selectedEpoch &&
          server === selectedServer &&
          !!work &&
          sameWork(work, ref),
      );
      authoring = new Authoring(
        ref,
        path.join(app.getPath("userData"), "author-buffers"),
        recovery,
        (action, input) =>
          selectedServer.request("workspace/request", {
            action,
            input,
            contract_revision: "1",
          }),
        () =>
          epoch === selectedEpoch &&
          server === selectedServer &&
          !!work &&
          sameWork(work, ref),
      );
      outlineReview = ref.kind === "novel" ? new OutlineReview(ref, path.join(app.getPath("userData"), "outline-review"), recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => epoch === selectedEpoch && server === selectedServer && !!work && sameWork(work, ref)) : undefined;
      videoReview = ref.kind === "video" ? new VideoReview(ref, path.join(app.getPath("userData"), "video-review"), recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => epoch === selectedEpoch && server === selectedServer && !!work && sameWork(work, ref),
        (method, input) => selectedServer.request(method, input)) : undefined;
      resources = new ResourceReview(
        ref,
        path.join(app.getPath("userData"), "resource-buffers"),
        recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => epoch === selectedEpoch && server === selectedServer && !!work && sameWork(work, ref),
      );
      canon = new CanonReview(
        ref, path.join(app.getPath("userData"), "canon-decisions"), recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => epoch === selectedEpoch && server === selectedServer && !!work && sameWork(work, ref),
      );
      novelDetails = ref.kind === "novel" ? new NovelDetails(
        ref, path.join(app.getPath("userData"), "novel-decisions"), recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => epoch === selectedEpoch && server === selectedServer && !!work && sameWork(work, ref),
      ) : undefined;
      covers = ref.kind === "novel" ? new CoverReview(
        ref, path.join(app.getPath("userData"), "cover-decisions"), recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => epoch === selectedEpoch && server === selectedServer && !!work && sameWork(work, ref),
      ) : undefined;
      versions = new VersionReview(
        ref, path.join(app.getPath("userData"), "version-decisions"), recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => epoch === selectedEpoch && server === selectedServer && !!work && sameWork(work, ref),
      );
      management = new ManagementReview(
        ref,
        path.join(app.getPath("userData"), "management-buffers"),
        recovery,
        scopedReview,
        (action, input) =>
          selectedServer.request("workspace/request", {
            action,
            input,
            contract_revision: "1",
          }),
        () =>
          epoch === selectedEpoch &&
          server === selectedServer &&
          !!work &&
          sameWork(work, ref),
      );
      return overview();
    });
    shellHandler(
      "desktop:tasks",
      (method: string, ref?: TaskRef, params?: any) => {
        if (!taskReview) throw new Error("请先选择当前作品。");
        if (method === "list") return taskReview.list(params?.cursor);
        if (!ref) throw new Error("缺少确切任务引用。");
        if (method === "journal") return taskReview.journal(ref);
        if (method === "recover") return taskReview.recover(ref);
        if (method === "call")
          return taskReview.call(ref, params.name, params.arguments);
        if (method === "resource") return taskReview.resource(ref, params.uri);
        throw new Error("未知任务审阅能力。");
      },
    );
    shellHandler(
      "desktop:read",
      async (action: string, input: Record<string, unknown>) => {
        if (!authoring) throw new Error("请选择当前作品。");
        return authoring.read(action, input);
      },
    );
    shellHandler("desktop:canon", async (method: string, input: any = {}) => {
      const current = canon;
      if (!current) throw new Error("请选择当前作品。");
      if (method === "get") return current.get(input.revision);
      if (method === "preview") return current.preview(input);
      if (method === "save") return current.save(input);
      if (method === "lock") return current.lock(input);
      if (method === "recover") return current.recover();
      if (method === "acknowledge") return current.acknowledge();
      throw new Error("未知设定用例。");
    });
    shellHandler("desktop:novel", async (method: string, input: any = {}) => {
      const current = novelDetails;
      if (!current) throw new Error("请选择当前小说。");
      if (method === "get") return current.get();
      if (method === "save") return current.save(input);
      if (method === "recover") return current.recover();
      if (method === "acknowledge") return current.acknowledge();
      throw new Error("未知小说编辑用例。");
    });
    shellHandler("desktop:covers", async (method: string, input: any = {}) => {
      const current = covers;
      if (!current) throw new Error("请选择当前小说。");
      if (method === "get") return current.get(input.revision);
      if (method === "requests") return current.requests(input.cursor);
      if (method === "candidates") return current.candidates(input.request_id);
      if (method === "prepare") return current.prepare(input);
      if (method === "commit") return current.commit(input.token);
      if (method === "recover") return current.recover();
      if (method === "acknowledge") return current.acknowledge();
      if (method === "choose_file") {
        const selected = await dialog.showOpenDialog(window, { title: "选择封面图片", properties: ["openFile"], filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }] });
        if (selected.canceled || !selected.filePaths[0]) return null;
        return current.chooseFile(selected.filePaths[0]);
      }
      throw new Error("未知封面用例。");
    });
    shellHandler("desktop:outlines", async (method: string, input: any = {}) => {
      const current = outlineReview;
      if (!current) throw new Error("请选择当前小说。");
      if (method === "get") return current.get();
      if (method === "save") return current.save(input);
      if (method === "draft") return current.draft(input.value);
      if (method === "recover") return current.recover();
      throw new Error("未知大纲用例。");
    });
    shellHandler("desktop:video", async (method: string, input: any = {}) => {
      const current = videoReview;
      if (!current) throw new Error("请选择当前视频作品。");
      if (["list", "media", "feedback", "delivery"].includes(method)) return current.read(method, input);
      if (method === "save_feedback") return current.saveFeedback(input);
      if (method === "journal") return current.journal();
      if (method === "recover") return current.recover();
      if (method === "draft") return current.draft(input.media_ref, input.value);
      if (method === "export") return current.exportFile(input.media_ref, async name => {
        const selected = await dialog.showSaveDialog(window, { title: "导出本版视频", defaultPath: name });
        return selected.canceled ? undefined : selected.filePath;
      });
      throw new Error("未知视频审阅用例。");
    });
    shellHandler("desktop:media", async (method: string, input: any = {}) => {
      if (!media) throw new Error("请选择当前作品。");
      if (method === "open") return media.open(input);
      if (method === "release") return media.release(input.url);
      throw new Error("未知媒体预览用例。");
    });
    shellHandler("desktop:resources", async (method: string, input: any = {}) => {
      const current = resources;
      if (!current) throw new Error("请选择当前作品。");
      if (method === "list") return current.list(input);
      if (method === "get") return current.get(input.resource_id, input.revision);
      if (method === "draft") return current.draft(input.resource_id, input.value);
      if (method === "usages") return current.usages(input.resource_id, input.cursor);
      if (method === "prepare") return current.prepare(input.resource_id, input.revision, input.sha256, input.kind, input.edits);
      if (method === "recover") return current.recover(input.resource_id);
      if (method === "acknowledge") return current.acknowledge(input.resource_id, input.operation_key);
      if (method === "commit") {
        const prepared = current.prepared(input.token);
        const answer = await dialog.showMessageBox(window, {
          type: "question", buttons: ["取消", "确认资料决定"], defaultId: 0, cancelId: 0,
          message: prepared.decision.title + "？",
          detail: "仅提交已审阅的资料版本。历史与使用位置保留，后来的修改将阻止覆盖。",
        });
        if (answer.response !== 1) throw new Error("已取消资料决定。");
        return current.commit(input.token);
      }
      throw new Error("未知资料用例。");
    });
    shellHandler("desktop:versions", async (method: string, input: any = {}) => {
      const current = versions;
      if (!current) throw new Error("请选择当前作品。");
      if (method === "journal") return current.journal();
      if (method === "prepare") return current.prepare(input.snapshot_id, input.snapshot_sha256);
      if (method === "recover") return current.recover();
      if (method === "acknowledge") return current.acknowledge(input.operation_key);
      if (method === "commit") {
        const preview = current.prepared(input.token);
        const answer = await dialog.showMessageBox(window, {
          type: "question", buttons: ["取消", "批准此版本"], defaultId: 0, cancelId: 0,
          message: "批准「" + preview.view.snapshot.message + "」？",
          detail: "仅批准已审阅的固定文稿差异。由 Agent 执行提交；当前正文、未保存稿和工作区分支保持。",
        });
        if (answer.response !== 1) throw new Error("已取消版本批准。");
        return current.commit(input.token);
      }
      if (method === "continue") {
        const view = await current.read("snapshot", { snapshot_id: input.snapshot_id });
        if (view.snapshot_sha256 !== input.snapshot_sha256) throw new Error("快照摘要已变化。");
        const context = collaborationContext(agentClient()), access = await context.status();
        if (!access.authorized) throw new Error("请先授权当前作品的 Agent 连接。");
        context.check();
        clipboard.writeText("请接续当前作品的固定文稿版本。先回读快照与执行状态；批准不等于执行。若已有执行键，必须沿原键恢复，不重复提交。\n" + JSON.stringify({
          core_cli: coreCliBinary(), client_adapter: context.client,
          ...(process.env.HETU_COLLABORATION_DIR ? { collaboration_directory: process.env.HETU_COLLABORATION_DIR } : {}),
          management_ref: access.management_ref, work_ref: view.snapshot.work_ref,
          snapshot_id: view.snapshot.snapshot_id, snapshot_sha256: view.snapshot_sha256,
          execute_action: "hetu.git.snapshot", phase: "execute",
          suggested_first_execution_key: "execute-" + view.snapshot.snapshot_id,
        }, null, 2));
        return { copied: true };
      }
      return current.read(method, input);
    });
    shellHandler("desktop:author", async (method: string, input: any) => {
      const current = authoring,
        tasks = taskReview;
      if (!current || !tasks) throw new Error("请选择当前作品。");
      if (method === "adoption_options")
        return current.adoptionOptions(
          await tasks.candidate(input.task_ref, input.candidate_id),
          input.task_ref,
        );
      if (method === "adoption")
        return current.adoption(
          await tasks.candidate(input.task_ref, input.candidate_id),
          input.task_ref,
          input.new_target,
        );
      if (method === "adoption_context")
        return current.adoptionContext(
          await tasks.candidate(input.task_ref, input.candidate_id),
          input.task_ref,
        );
      if (method === "adoption_partial")
        return current.adoptionPartial(input.token, input.source, input.target);
      if (method === "check") return current.check(input.document_id);
      if (method === "finalization")
        return current.finalization(
          input.document_id,
          input.report_ref,
          input.comments,
          input.coverage,
        );
      if (method === "withdrawal")
        return current.withdrawal(input.document_id, input.reason);
      if (method === "journal") return current.journal(input.document_id);
      if (method === "acknowledge")
        return current.acknowledge(input.document_id, input.operation_key);
      if (method === "recover") return current.recover(input.document_id);
      if (method === "new_adoption_journal")
        return current.journal(input.task_ref);
      if (method === "new_adoption_recover")
        return current.recover(input.task_ref);
      if (method === "new_adoption_acknowledge")
        return current.acknowledge(input.task_ref, input.operation_key);
      if (method === "commit") {
        const prepared = current.prepared(input.token);
        const decision = await dialog.showMessageBox(window, {
          type: "question",
          buttons: ["取消", "确认"],
          defaultId: 0,
          cancelId: 0,
          message: prepared.title + "？",
          detail:
            "仅提交刚才审阅的固定预览。并发变化将阻止提交，历史修订与来源继续保留。",
        });
        if (decision.response !== 1)
          throw new Error("已取消，作品保持原状态。");
        return current.commit(input.token);
      }
      throw new Error("未知作者用例。");
    });
    shellHandler(
      "desktop:management",
      async (method: string, input: any = {}) => {
        const current = management;
        if (!current) throw new Error("请选择当前作品。");
        if (method === "list") return current.list(input.cursor);
        if (method === "get")
          return current.get(input.proposal_id, input.proposal_sha256);
        if (method === "verify")
          return current.verify(input.proposal_id, input.proposal_sha256);
        if (method === "prepare")
          return current.prepare(
            input.proposal_id,
            input.proposal_sha256,
            input.state_revision,
            input.decision,
          );
        if (method === "recover") return current.recover(input.proposal_id);
        if (method === "acknowledge")
          return current.acknowledge(input.proposal_id, input.operation_key);
        if (method === "commit") {
          const prepared = current.prepared(input.token);
          const answer = await dialog.showMessageBox(window, {
            type: "question",
            buttons: ["取消", "确认决定"],
            defaultId: 0,
            cancelId: 0,
            message: prepared.decision.title + "？",
            detail:
              "仅确认刚才审阅的固定方案。批准后由外部 Agent 执行；作品或审核状态变化将阻止提交。",
          });
          if (answer.response !== 1) throw new Error("已取消审核决定。");
          return current.commit(input.token);
        }
        if (method === "continue") {
          const view = await current.get(
            input.proposal_id,
            input.proposal_sha256,
          );
          if (view.state !== "approved" || !view.is_current || view.is_expired)
            throw new Error(
              "当前方案尚未获批、已过期或基线已变化，请刷新核对。",
            );
          const context = collaborationContext(agentClient()),
            status = await context.status();
          if (!status.authorized) throw new Error("当前作品授权已撤销。");
          const request = {
            client_adapter: context.client,
            management_ref: status.management_ref,
            work_ref: context.work,
            core_cli: coreCliBinary(),
            ...(process.env.HETU_COLLABORATION_DIR
              ? { collaboration_directory: process.env.HETU_COLLABORATION_DIR }
              : {}),
            action: "hetu.agent_operations.execute",
            input: {
              proposal_id: view.proposal_id,
              proposal_sha256: view.proposal_sha256,
              operation_key:
                "execute-" + view.proposal_id + "-" + view.proposal_sha256,
            },
          };
          context.check();
          clipboard.writeText(
            "请以当前客户端的精确管理授权执行已批准的固定方案；保留此原键，未知结果先回读，不重新准备或更换输入。执行后回读作品并告诉我结果。\n" +
              JSON.stringify(request, null, 2),
          );
          return { copied: true };
        }
        throw new Error("未知管理方案用例。");
      },
    );
    shellHandler("desktop:dirty", (value: boolean) => {
      dirty = value === true;
    });
    shellHandler(
      "desktop:buffer",
      async (document_id: string, value: unknown, kind = "document") => {
        if (!work || !/^doc_[a-f0-9-]{36}$/.test(document_id))
          throw new Error("编辑对象无效。");
        if (!["document", "annotations"].includes(kind))
          throw new Error("恢复稿类型无效。");
        const name = path.join(
          app.getPath("userData"),
          "buffers",
          work.workspace_id,
          work.object_id,
          document_id +
            (kind === "annotations" ? ".annotations" : "") +
            ".json",
        );
        if (value === undefined) return recovery.read(name);
        // 正文恢复同时含编辑稿、原基线和固定待提交输入，覆盖三份合法长文。
        await recovery.write(
          name,
          value,
          (kind === "document" ? 16 : 4) * 1024 * 1024,
        );
        return true;
      },
    );
    shellHandler(
      "desktop:handoff",
      async (pageId: string, object: Record<string, unknown> = {}) => {
        if (pageId.startsWith("fallback:")) {
          const owner = pageId.slice(9), context = await pluginContext(owner);
          const fixed = await pluginResultHandoff(context, owner, object);
          context.check();
          clipboard.writeText("请通过河图的精确插件连接接续当前成果。先inspect或capabilities发现实际能力，再读取固定修订；按我的目标处理。范围仅此作品的插件对象，不含正文采纳、定稿或外部副作用。保留原操作键，未知结果先回读。\n" + JSON.stringify({
            ...fixed, page: "plugin.results", client_adapter: agentClient(),
            plugin_connection: pluginMachineConnection(owner, context.work), limitations: ["plugin_objects_only"],
          }, null, 2));
          return { copied: true };
        }
        if (!work || !authoring) throw new Error("请选择当前作品。");
        const selectedEpoch = epoch,
          selectedWork = work,
          currentAuthoring = authoring;
        const client = agentClient();
        const connection = await ensureConnection(client);
        if (selectedEpoch !== epoch)
          throw new Error("作品已变化，请重新交接。");
        const summary = unwrap(
          await core("hetu.works.get", { work_ref: work }),
        ).summary;
        const context: Record<string, unknown> = {
          work_ref: selectedWork,
          fixed_ref: summary.fixed_ref,
          page: pageId,
          management_ref: connection.management_ref,
          client_adapter: client,
          core_cli: coreCliBinary(),
          ...(process.env.HETU_COLLABORATION_DIR
            ? { collaboration_directory: process.env.HETU_COLLABORATION_DIR }
            : {}),
        };
        const pageKind =
          pageId === "work.versions" ? "git" :
          pageId === "work.import"
            ? "import"
            : pageId === "work.delivery"
              ? "delivery"
            : pageId === "work.links"
            ? "related_works"
            : pageId === "work.resources"
              ? "resources"
            : pageId === "novel.outlines" ? "structure"
            : pageId === "work.media"
              ? "media"
            : pageId === "work.images"
              ? "artwork"
              : pageId === "work.canon"
                ? "bible"
                : selectedWork.kind === "drama"
                  ? "drama"
                  : selectedWork.kind === "video"
                    ? "video"
                    : "novel";
        const handoff = unwrap(
          await currentAuthoring.handoff(pageKind, object),
        );
        context.fixed_refs = handoff.fixed_refs;
        context.direct_actions = handoff.direct_actions.map((a: any) => a.name);
        context.proposal_actions = handoff.proposal_actions.map(
          (a: any) => a.name,
        );
        context.limitations = handoff.limitations;
        if (binding) {
          context.plugin_connection = pluginMachineConnection(binding.owner, binding.work);
        }
        const text =
          "请通过河图的机器入口接续当前创作对象。使用所选客户端与确切 management_ref，先发现实际能力、读取固定修订与现有成果，再按我的目标处理本页。插件数据仅限以下精确范围；正文采纳、定稿及外部副作用须另行决定。保留原操作键，未知结果先回读。\n" +
          JSON.stringify(context, null, 2);
        if (selectedEpoch !== epoch)
          throw new Error("作品已变化，请重新交接。");
        clipboard.writeText(text);
        return { copied: true };
      },
    );
    shellHandler("desktop:copy", (text: string) => {
      if (typeof text !== "string" || text.length > 100000)
        throw new Error("复制内容无效。");
      clipboard.writeText(text);
    });
    shellHandler("desktop:install", async () => {
      const selected = await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
        title: "安装预构建插件包",
      });
      if (selected.canceled) return overview();
      const pkg = await PluginPackage.inspect(selected.filePaths[0]);
      const confirm = await dialog.showMessageBox(window, {
        type: "question",
        buttons: ["取消", "安装"],
        defaultId: 0,
        cancelId: 0,
        message:
          (host.has(pkg.manifest.id) ? "替换" : "安装") +
          pkg.manifest.display["zh-CN"] +
          " " +
          pkg.manifest.version +
          "？",
        detail:
          pkg.manifest.description["zh-CN"] +
          "\n许可：" +
          pkg.manifest.license +
          "\n" +
          (pkg.manifest.runtime
            ? "包含Node后端代码，仅安装可信来源。"
            : "使用隔离Web界面。") +
          "\n启用后可使用宿主核心能力；现有成果和历史继续保留。",
      });
      if (confirm.response !== 1) return overview();
      return applyPlugin({ action: "install", package_directory: selected.filePaths[0], package_sha256: pkg.sha256,
        authorization_note: "作者在桌面确认安装确切插件包：" + pkg.manifest.id + " " + pkg.manifest.version });
    });
    shellHandler("desktop:toggle", async (id: string, enabled: boolean) => {
      return applyPlugin({ action: enabled ? "enable" : "disable", plugin_id: id, package_sha256: host.package(id).sha256,
        authorization_note: "作者在桌面选择" + (enabled ? "启用" : "停用") + id });
    });
    shellHandler("desktop:uninstall", async (id: string) => {
      const pkg = host.package(id);
      const decision = await dialog.showMessageBox(window, {
        type: "question",
        buttons: ["取消", "卸载插件"],
        defaultId: 0,
        cancelId: 0,
        message: "卸载" + pkg.manifest.display["zh-CN"] + "？",
        detail:
          "作品成果、历史修订和通用导出将继续保留。插件运行将停止，依赖插件会停用。",
      });
      if (decision.response !== 1) return overview();
      return applyPlugin({ action: "uninstall", plugin_id: id, package_sha256: pkg.sha256,
        authorization_note: "作者在桌面确认卸载" + id + "；保留作品成果和历史。" });
    });
    shellHandler("desktop:surface-bounds", (rect: typeof bounds) => {
      if (
        ![rect.x, rect.y, rect.width, rect.height].every(
          (n) => Number.isFinite(n) && n >= 0 && n < 20000,
        )
      )
        throw new Error("工作面尺寸无效。");
      bounds = Object.fromEntries(
        Object.entries(rect).map(([key, value]) => [key, Math.round(value)]),
      ) as typeof bounds;
      layout();
    });
    shellHandler("desktop:close-surface", async () => {
      if (dirty) {
        const result = await dialog.showMessageBox(window, {
          type: "warning",
          buttons: ["继续编辑", "保留恢复稿并离开"],
          defaultId: 0,
          cancelId: 0,
          message: "修改尚未保存到作品。",
        });
        if (result.response !== 1) throw new Error("已保留当前编辑。");
        dirty = false;
      }
      await closeSurface();
    });
    shellHandler("desktop:view", async (owner: string, viewId: string) => {
      if (!work || !host.active(owner))
        throw new Error("请选择作品并启用插件。");
      const pkg = host.package(owner),
        view = pkg.manifest.contributions.views.find((v) => v.id === viewId);
      if (!view) throw new Error("视图未注册。");
      if (!supportsWork(pkg.manifest, work))
        throw new Error("此插件不适用于当前作品。");
      await closeSurface();
      const token = randomUUID(),
        partition = "plugin-" + token,
        s = session.fromPartition(partition, { cache: false });
      denyPermissions(s);
      s.webRequest.onBeforeRequest((details, callback) =>
        callback({
          cancel: !details.url.startsWith("hetu-plugin://" + token + "/") && !pluginMediaUrls.has(details.url),
        }),
      );
      s.protocol.handle("hetu-plugin", (request) => {
        try {
          const url = new URL(request.url);
          if (url.host !== token) return new Response(null, { status: 403 });
          const relative = resourcePath(
            decodeURIComponent(url.pathname.slice(1)),
          );
          return new Response(new Uint8Array(pkg.file(relative)), {
            headers: {
              "Content-Type": mime(relative),
              "Content-Security-Policy": policy(
                "default-src [none]; script-src [self]; style-src [self] [unsafe-inline]; img-src [self] data: hetu-media:; media-src hetu-media: blob:; font-src [self]; connect-src [none]; frame-src [none]; object-src [none]; base-uri [none]; form-action [none]",
              ),
            },
          });
        } catch {
          return new Response(null, { status: 404 });
        }
      });
      s.protocol.handle("hetu-media", request => pluginMedia?.handle(request) ?? new Response(null,{status:410}));
      surface = new WebContentsView({
        webPreferences: {
          partition,
          preload: path.join(dist, "plugin-preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      harden(surface);
      window.contentView.addChildView(surface);
      layout();
      binding = {
        sender: surface.webContents.id,
        token,
        owner,
        view: viewId,
        work,
        epoch,
        package_sha256: pkg.sha256,
      };
      await surface.webContents.loadURL(
        "hetu-plugin://" + token + "/" + view.entry,
      );
      return { opened: true };
    });
    ipcMain.handle("plugin:buffer", async (event, value) => {
      const current = pluginCaller(event);
      const key = createHash("sha256")
        .update(JSON.stringify([current.work, current.owner, current.view]))
        .digest("hex");
      const file = path.join(
        app.getPath("userData"),
        "plugin-buffers",
        key + ".json",
      );
      if (value === undefined) return recovery.read(file);
      await recovery.write(file, value, 1024 * 1024);
      return true;
    });
    ipcMain.handle("plugin:context", (event) => {
      const b = pluginCaller(event);
      return {
        plugin_id: b.owner,
        work_ref: b.work,
        package_sha256: b.package_sha256,
        view_id: b.view,
        navigation: host.package(b.owner).manifest.contributions.views.find(view => view.id === b.view)?.navigation ?? "host",
      };
    });
    ipcMain.handle("plugin:request", (event, action, input) =>
      pluginRequest(pluginCaller(event), action, input),
    );
    const invokePlugin = async (event:IpcMainInvokeEvent, action:string, input:Record<string,unknown>) => {
      const current = pluginCaller(event),
        pkg = host.package(current.owner);
      if (!server) throw new Error("作品连接已关闭。");
      if (pluginCaller(event) !== current || pkg.sha256 !== current.package_sha256)
        throw new Error("插件包或作品上下文已变化。");
      if (!backend) {
        const directory = await installations.snapshot(pkg);
        backend = new BackendSupervisor({
          node: pluginNodeBinary(),
          bootstrap: path.join(dist, "plugin-worker.mjs"),
          snapshot: directory,
          pkg,
          work_ref: current.work,
          request: (action, input) => pluginRequest(current, action, input),
          core_actions: unwrap(await pluginRequest(current, "hetu.capabilities.get", {})).actions,
        });
        await backend.initialize();
      }
      return backend.invoke(action, input);
    };
    ipcMain.handle("plugin:invoke", invokePlugin);
    ipcMain.handle("plugin:host", async (event, action, input) => {
      const current = pluginCaller(event);
      const check = () => { if(pluginCaller(event)!==current) throw new Error("插件上下文已变化。"); };
      return pluginService(action,input,{
        work:current.work,check,request:(action,input)=>pluginRequest(current,action,input),
        preferences:()=>({theme:localState.preferences.appearance,language:localState.preferences.language??"zh-CN"}),
        closeView:()=>{check();requestPluginReturn();},
        mediaOpen:async(input)=>{
          check();if(!server)throw new Error("作品连接已关闭。");
          if(!pluginMedia){const selected=current,selectedServer=server;pluginMedia=new MediaAccess(current.work,server,()=>binding===selected&&server===selectedServer&&host.active(selected.owner));}
          const result=await pluginMedia.open(input);check();pluginMediaUrls.add(result.url);return result;
        },
        mediaRelease:async(url)=>{check();pluginMediaUrls.delete(url);await pluginMedia?.release(url);return {released:true};},
        openWork:async(target)=>{check();window.webContents.send("desktop:open-work",{work_ref:current.work,epoch:current.epoch,target});},
        handoff:async(input)=>{
          const connection=await ensureConnection(agentClient());check();
          const fixed=input.object_ref?[{kind:"plugin_object",work_ref:current.work,owner_plugin_id:current.owner,...input.object_ref as object}]:[];
          clipboard.writeText("请通过河图的机器入口接续当前创作工程。先发现实际能力、读取固定成果，再按目标处理；保留原键，未知先回读。正文采纳、定稿、成片认可与外部副作用另行决定。\n"+JSON.stringify({
            goal:input.goal,work_ref:current.work,fixed_refs:fixed,node_id:input.node_id,run_ref:input.run_ref,
            client_adapter:agentClient(),management_ref:connection.management_ref,
            plugin_connection:pluginMachineConnection(current.owner,current.work),
          },null,2));
        },
        openDocument:async(document_id)=>{check();window.webContents.send("desktop:open-document",{work_ref:current.work,document_id});},
        exportFile:async(input)=>{
          const declared=host.package(current.owner).manifest.contributions.actions.find(a=>a.id===input.action);
          if(declared?.effect!=="read")throw new Error("只能导出声明的只读动作。");
          return exportPluginFile(input as any,{check,invoke:(action,input)=>invokePlugin(event,action,input),choose:async(name)=>{
            const chosen=await dialog.showSaveDialog(window,{title:"导出插件成果",defaultPath:name});return chosen.canceled?undefined:chosen.filePath;
          }});
        },
        saveArtifact:async(input)=>savePluginArtifact(input as any,{check,choose:async(name)=>{
          const chosen=await dialog.showSaveDialog(window,{title:"导出插件成果",defaultPath:name});return chosen.canceled?undefined:chosen.filePath;
        }}),
      });
    });
    shellHandler("desktop:migrations", async (method: string, input: any) => {
      if (method === "preview") return pluginMigrations.preview(input.owner, input.migration_id, input.plan_sha256);
      if (method === "approve") return pluginMigrations.approve(input.token);
      if (method === "continue") {
        const selectedEpoch = epoch;
        const fixed = await pluginMigrations.handoff(input.owner, input.migration_id, input.plan_sha256);
        const connection = { ...pluginMachineConnection(input.owner, fixed.work_ref), ...fixed };
        if (selectedEpoch !== epoch) throw new Error("作品已变化，请重新交接。");
        clipboard.writeText("请接续河图的固定插件数据升级。先使用精确插件连接发现实际能力，读取 migrations.get 和原键 operations.get；固定差异与 CAS 核验通过后执行 migrations.execute。保留迁移ID、方案摘要与原操作键，未知结果先回读。范围仅当前作品的插件对象，不包含正文采纳、定稿或其他副作用。\n" + JSON.stringify({ page: "plugin.migration", client_adapter: agentClient(), plugin_connection: connection }, null, 2));
        return { copied: true };
      }
      throw new Error("未知插件数据升级操作。");
    });
    shellHandler(
      "desktop:fallback",
      async (owner: string, action: string, input: Record<string, unknown>) => {
        if (!server || !work) throw new Error("请选择作品。");
        return server.request("extensions/host", {
          method: "read",
          params: {
            plugin_id: owner,
            work_ref: work,
            request: {
              action,
              contract_revision: "1",
              input: { ...input, work_ref: work },
            },
          },
        });
      },
    );
    await window.loadURL(appUrl);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "桌面启动失败。");
    app.quit();
  });
// 恢复稿flush会取消首次quit；等该轮退出状态清理后再请求退出。
app.on("window-all-closed", () => { setImmediate(() => app.quit()); });
