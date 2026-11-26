import { storageRequest, storageAction } from "./storage-review.ts";
import {localFontCatalog} from "./font-catalog.ts";
import {interfaceScales, nextInterfaceScale} from "../interface-scale.ts";
import { pluginPreferences } from "./plugin-preferences.ts";
import { ensureWorkConnection } from "./work-connection.ts";
import { archiveWork } from "./work-archive.ts";
import { creationHandoff, workHandoff, pluginResultText, pluginWorkText, migrationText, settingsHandoff } from "./workbench-handoff.ts";
import { validateWritingPrompt, writingPrompt } from "./writing-prompt.ts";
import type { WritingPromptRequest } from "../writing-prompts.ts";
import { readLibraryWorks as listWorks } from "./library-works.ts";
import { runDialogUtility } from "./dialog-utility.ts";
import { createWorkSession, type WorkSession } from "./work-session.ts";
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
import {ReadingStateStore} from "./reading-state.ts";
import { RecoveryStore } from "./recovery.ts";
import { pluginResultHandoff } from "./plugin-results.ts";
import { pluginService } from "./plugin-services.ts";
import { exportPluginFile } from "./plugin-export.ts";
import { savePluginArtifact } from "./plugin-artifact.ts";
import { SettingsReview } from "./settings.ts";
import { AgentConnectionInstall } from "./agent-connection-install.ts";
import { SettingsWindow } from "./settings-window.ts";
import {windowChromeOptions, trackWindowChrome, updateWindowChrome, isWindowFullscreen,setWindowFullscreen,setWindowTitlebarHeight} from "./window-chrome.ts";
import { workAssociation, workAgentRequest } from "./work-agent.ts";
import { CoverReview } from "./covers.ts";
import { NovelDetails } from "./novel-details.ts";
import { CanonReview } from "./canon.ts";
import { TaskReview, type TaskRef } from "./task-review.ts";
import { Authoring } from "./authoring.ts";
import {copyText, pasteText} from "./text-clipboard.ts";
import { ManagementReview } from "./management.ts";
import { VersionReview } from "./versions.ts";
import { PluginMigrationReview } from "./plugin-migrations.ts";
import { ResourceReview } from "./resources.ts";
import { MediaAccess } from "./media.ts";
import { VideoReview } from "./video-review.ts";
import { OutlineReview } from "./outlines.ts";
import { scopedCli } from "./cli.ts";
import {readSessionResults,readLibrarySessionResults} from "./agent/session-results.ts";
import {prepareAgentContext,verifyAgentContexts} from "./agent/fixed-context.ts";
import {taskSourceContext,pluginSourceContext,sceneSourceContext,videoSourceContext} from "./agent/source-context.ts";
import { CreativeLibrary } from "./library.ts";
import {
  PluginHost,
  PluginInstallations,
  pluginSummaries,
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
import { AgentSessions } from "./agent/session-manager.ts";
import {EngineCatalog,discoverEngines,machineClient} from "./agent/engines.ts";
import { CodexSession } from "./agent/codex-session.ts";
import { agentSessionSandbox, buildAgentSessionPrompt, createAgentSession, type AgentSessionAdapter, type AgentSessionContext, type AgentSessionEvent } from "./agent-session.ts";
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
let workSession: WorkSession | undefined;
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
let agentSession: AgentSessionAdapter | undefined;
let agentSessions: AgentSessions | undefined;
let engineCatalog:EngineCatalog|undefined;
let localState: any;
async function agentSettings(action: string, input: unknown, client = agentClient()) {
  return unwrap(await settingsServer.request("local_settings/request", {
    client_adapter: client, request: { action, contract_revision: "1", input },
  }));
}
function agentClient() {
  const selected = localState ? workAssociation(localState, work).client : "codex";
  return ({ claudeCode: "claude-code", other: "generic", none: "generic" } as Record<string, string>)[selected] ?? selected;
}
async function managedClient(){return machineClient((await agentSessions?.get(work,localState?.preferences?.agent_session?.default_surface??"tui"))?.snapshot(false).client??"codex");}
function handoffEnvironment() { return {client:agentClient(),coreCli:coreCliBinary(),collaborationDirectory:process.env.HETU_COLLABORATION_DIR,localSettingsDirectory:process.env.HETU_LOCAL_SETTINGS_DIR}; }
async function refreshSettings(committed?: any) {
  localState = committed ? {...localState, ...committed} : await settings.get();
  nativeTheme.themeSource = localState.preferences.appearance;
  if (window && !window.isDestroyed()) window.webContents.send("desktop:preferences", { ...localState.preferences, settings_revision: localState.revision });
  settingsWindow.preferences({ ...localState.preferences, settings_revision: localState.revision });
  if (surface && !surface.webContents.isDestroyed()) surface.webContents.send("plugin:preferences", pluginPreferences(localState, nativeTheme.shouldUseDarkColors ? "dark" : "light"));
  return localState;
}
async function selectClient(client: string) {
  if (!["codex", "claude-code", "workbuddy", "generic"].includes(client)) throw new Error("请选择支持的外部 Agent 客户端。");
  await agentSession?.stop(); agentSession = undefined;
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
let quitRequested = false;
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
  const [width, height] = window.getContentSize(), scale = window.webContents.getZoomFactor();
  const scaled = Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Math.round(value * scale)])) as typeof bounds;
  surface.setBounds({
    x: Math.min(scaled.x, width),
    y: Math.min(scaled.y, height),
    width: Math.max(0, Math.min(scaled.width, width - scaled.x)),
    height: Math.max(0, Math.min(scaled.height, height - scaled.y)),
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
function mcpBinary() {
  return (
    process.env.HETU_MCP ??
    path.join(
      app.isPackaged ? process.resourcesPath : root,
      app.isPackaged ? "bin" : "target/debug",
      process.platform === "win32" ? "hetu-mcp.exe" : "hetu-mcp",
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
  let status = await context.status();
  if (!status.authorized && !status.management_ref) status = await ensureConnection(context.client);
  if (!status.authorized) throw new Error("当前作品的 Agent 连接已断开，请重新连接或发起协作。");
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
    preferences: localState ? { ...localState.preferences, settings_revision: localState.revision } : undefined,
    plugins: pluginSummaries(host, prefs),
    views: host.views
      .list()
      .filter((v) => work && supportsWork(host.package(v.owner).manifest, work))
      .map((v) => ({ key: v.id, owner: v.owner, ...v.value })),
  };
}
async function openWorkspace(directory: string, expected?: WorkRef) {
  const next = await AppServer.open(serverBinary(), directory, path.join(app.getPath("userData"), "git-authorizations"));
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
async function ensureConnection(client:string){return ensureWorkConnection(collaborationContext(client));}
function applyInterfaceScale(target: Electron.WebContents, value: number) {
  if (!interfaceScales.includes(value as any)) throw new Error("界面大小不在可用范围内。");
  target.setZoomFactor(value / 100);
  const owner = BrowserWindow.fromWebContents(target);
  if (owner) updateWindowChrome(owner);
  if (target === window.webContents && surface && !surface.webContents.isDestroyed()) {surface.webContents.setZoomFactor(value / 100); layout();}
  target.send("desktop:interface-scale", value);
  return value;
}
function shellHandler(name: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(name, (event, ...args) => {
    trusted(event, name);
    return fn(...args);
  });
}
if (process.argv.includes("--hetu-dialog")) { void runDialogUtility(); } else {
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
      (action, input) => agentSettings(action, input, "codex"),
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
        const connection = await AppServer.open(serverBinary(), directory, path.join(app.getPath("userData"), "git-authorizations"));
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
        if (!["shell", "settings"].includes(url.host)) return new Response(null, { status: 403 });
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
                : "default-src [self]; script-src [self]; worker-src blob:; style-src [self] [unsafe-inline]; img-src [self] data: hetu-media:; media-src hetu-media: blob:; connect-src [none]; frame-src [self]; object-src [none]; base-uri [none]; form-action [none]",
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
      ...windowChromeOptions,
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
    trackWindowChrome(window);
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
        { label: "切换全屏", accelerator:process.platform==="darwin"?"Ctrl+Command+F":"F11",click: () => {
          const target = BrowserWindow.getFocusedWindow() ?? window;
          void setWindowFullscreen(target,!isWindowFullscreen(target)).catch(error=>console.error("窗口全屏切换失败：",error.message));
        } },
        { type: "separator" as const },
        ...[["放大界面", "CmdOrCtrl+Plus", 1], ["缩小界面", "CmdOrCtrl+-", -1], ["恢复界面大小", "CmdOrCtrl+0", 0]].map(([label, accelerator, direction]) => ({label: String(label), accelerator: String(accelerator), click: () => {
          const target = BrowserWindow.getFocusedWindow()?.webContents ?? window.webContents;
          const current = target.getZoomFactor() * 100;
          applyInterfaceScale(target, direction === 0 ? 100 : nextInterfaceScale(current, Number(direction)));
        }})),
      ] },
      { role: "windowMenu", label: "窗口" },
    ]));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("resize", layout);
    const updatePluginAppearance = () => { if (surface && !surface.webContents.isDestroyed()) surface.webContents.send("plugin:preferences", pluginPreferences(localState, nativeTheme.shouldUseDarkColors ? "dark" : "light")); };
    nativeTheme.on("updated", updatePluginAppearance);
    window.once("closed", () => nativeTheme.off("updated", updatePluginAppearance));
    window.on("focus", () => {
      void refreshSettings().then(() => {
        if (!window.isDestroyed()) window.webContents.send("desktop:preferences", { ...localState.preferences, settings_revision: localState.revision });
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
          // 先完成首次被取消的quit，再关闭窗口，避免微任务重入吞掉退出事件。
          setImmediate(() => { if (quitRequested) app.quit(); else window.close(); });
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
    shellHandler("desktop:fonts", (refresh = false) => {
      if (typeof refresh !== "boolean") throw new Error("字体目录请求无效。");
      return localFontCatalog(refresh);
    });
    ipcMain.handle("desktop:interface-scale", (event, method: string, input: any = {}) => {
      trusted(event, "desktop:interface-scale");
      if (method === "get") return Math.round(event.sender.getZoomFactor() * 100);
      if (method === "set") return applyInterfaceScale(event.sender, input.value);
      throw new Error("未知界面大小操作。");
    });
    shellHandler("desktop:zoom", () => {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    });
    shellHandler("desktop:maximize", () => {if (!window.isMaximized()) window.maximize();});
    shellHandler("desktop:fullscreen",(method:string,value?:boolean)=>{
      if(method==="get")return isWindowFullscreen(window);
      if(method!=="set"||typeof value!=="boolean")throw new Error("全屏窗口请求无效。");
      return setWindowFullscreen(window,value);
    });
    shellHandler("desktop:window-layout",(layout:string)=>{
      if(!["terminal","default"].includes(layout))throw new Error("窗口布局请求无效。");
      setWindowTitlebarHeight(window,layout==="terminal"?36:52);
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
    shellHandler("desktop:reading-state", async (method: string, input: any = {}) => {
      if (!work || !sameWork(input.work_ref, work)) throw new Error("阅读位置不属于当前作品。");
      const store = new ReadingStateStore(path.join(app.getPath("userData"), "reading-state"), recovery);
      if (method === "get") return store.get(work);
      if (method === "save") return store.save(work, input.patch);
      throw new Error("未知阅读位置操作。");
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
        if (input.work_ref) {
          const selectedWork = work, selectedEpoch = epoch;
          if (!selectedWork || !sameWork(input.work_ref, selectedWork)) throw new Error("作品已切换，请重新读取当前作品。");
          await library.refresh([], selectedWork);
          if (epoch !== selectedEpoch || !work || !sameWork(work, selectedWork)) throw new Error("作品已切换，请重新读取当前作品。");
          return overview();
        }
        const discovered: any[] = [];
        for(const client of new Set([agentClient(),"codex"])){
        let cursor: string | undefined;
        do {
          const result = unwrap(
            await scopedCli(
              coreCliBinary(),
              client,
              process.env.HETU_COLLABORATION_DIR,
              "hetu.collaboration.created_works",
              { limit: 100, ...(cursor ? { cursor } : {}) },
            ),
          );
          discovered.push(...result.works);
          cursor = result.next_cursor ?? undefined;
        } while (cursor);
        }
        await library.refresh(discovered);
        return overview();
      }
      if (method === "open") {
        const directory = library.resolve(input.work_ref);
        if (dirty) throw new Error("请先保存当前修改，再打开另一作品。");
        return openWorkspace(directory, input.work_ref);
      }
      if (method === "archive") {
        const reference = input.work_ref as WorkRef, directory = library.resolve(reference);
        const next = await AppServer.open(serverBinary(), directory, path.join(app.getPath("userData"), "git-authorizations"));
        try {
          await archiveWork(next, reference, input.archived === true, async ({message, detail, accept}) =>
            (await dialog.showMessageBox(window, {type: "warning", buttons: ["取消", accept], defaultId: 0, cancelId: 0, message, detail})).response === 1);
          return overview();
        } finally { await next.close(); }
      }
      if (method === "bootstrap") { const prompt=creationHandoff(input.kind,{...handoffEnvironment(),client:input.delivery==="draft"?machineClient((await agentSessions?.get(undefined))?.snapshot(false).client??"codex"):agentClient()},input.delivery==="draft");if(input.delivery==="draft")return {prompt};clipboard.writeText(prompt);return {copied:true}; }
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
        prepare: params => agentSettings("hetu.local_settings.prepare", params),
        choose: async () => { const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"], title: "选择已安装的创作套件" }); return result.canceled ? undefined : result.filePaths[0]; },
        reveal: directory => shell.showItemInFolder(directory),
      });
    });
    shellHandler("desktop:agent-session", async (method: string, input: any = {}) => {
      if (method === "open_link") { if(typeof input.url!=="string"||input.url.length>8192)throw new Error("网页链接无效或超过预算。");const url = new URL(input.url); if (!["https:", "http:"].includes(url.protocol)) throw new Error("仅支持打开网页链接。"); await shell.openExternal(url.href); return; }
      const selected = input.scope === "library" ? undefined : work && structuredClone(work), selectedEpoch = epoch;
      if(input.work_ref&&(!selected||!sameWork(selected,input.work_ref)))throw new Error("作品已切换，请重新准备会话请求。");
      const check = () => { if (selectedEpoch !== epoch || selected && (!work || !sameWork(work, selected))) throw new Error("作品已切换，请重新读取Codex会话。"); };
      if (!agentSessions) {
        const location = await settingsServer.request("collaboration/directory", {});
        agentSessions ??= new AgentSessions({ profile: app.getPath("userData"), machineDirectory: location.directory, machineMcpBinary: mcpBinary(), machineNodeBinary:pluginNodeBinary(),machineRelay:path.join(dist,"agent-mcp-relay.mjs"),engineGuard:path.join(dist,"agent-engine-guard.mjs"), emit: event => { if (window && !window.isDestroyed()) window.webContents.send("desktop:agent-session", event); } });
      }
      const defaultSurface = localState?.preferences?.agent_session?.default_surface ?? "tui";
      engineCatalog??=new EngineCatalog({directory:path.join(app.getPath("userData"),"agent-sessions","catalog"),runtimeDirectory:path.dirname(mcpBinary())});
      if(method==="catalog")return discoverEngines(path.dirname(mcpBinary()));
      if(method==="model_options")return engineCatalog.models(input.client);
      if (method === "list") return agentSessions.list(selected);
      if (method === "new") { const launch=input.launch?await engineCatalog.validate(input.launch):undefined;check();const created = await agentSessions.create(selected, launch?.surface??defaultSurface,launch); check();if(agentSessions.isSelected(created,selected))agentSession=created;if(launch){if(selected&&launch.client!=="shell")await ensureConnection(machineClient(launch.client));check();return created.start();}return created.snapshot(); }
      const activeSession = await agentSessions.get(selected, defaultSurface);
      if (input.session_id && input.session_id !== activeSession.snapshot().session_id && !["select", "get", "rename"].includes(method)) throw new Error("会话已经切换，旧输入未发送。");
      const session = await agentSessions.get(selected, defaultSurface, input.session_id, method === "select");
      check();
      if(agentSessions.isSelected(session,selected))agentSession=session;
      if (method === "get" || method === "select") return session.snapshot();
      if (method === "rename") return session.rename(input.title);
      const checkSession=()=>{check();if(!agentSessions!.isSelected(session,selected))throw new Error("会话已经切换，旧输入未发送。");if(input.generation!==undefined&&input.generation!==session.snapshot(false).generation)throw new Error("终端已重新连接，请重新准备输入。");};
      checkSession();
      const contextHandoff=async(kind:string,object:Record<string,unknown>)=>{
        checkSession();
        if(!selected||!server||!authoring)throw Error("请先打开当前作品。");
        const currentServer=server;
        const read=async(action:string,input:Record<string,unknown>)=>{
          checkSession();
          const value=unwrap(await currentServer.request("workspace/request",{action,input,contract_revision:"1"}));
          checkSession();return value;
        };
        if(kind==="reviews")return taskSourceContext(selected,object,read);
        if(kind==="plugin.results")return pluginSourceContext(selected,object,read);
        if(kind==="drama.scenes")return sceneSourceContext(selected,object,read);
        if(kind==="video.sources")return videoSourceContext(selected,object,read);
        const value=unwrap(await authoring.handoff(kind,object));checkSession();return value;
      };
      if (method === "remove") { const created=await agentSessions.remove(selected, session.snapshot().session_id!, defaultSurface);check();if(agentSessions.isSelected(created,selected))agentSession=created;return created.snapshot(); }
      if (method === "start") { if (selected&&session.snapshot().client!=="shell") await ensureConnection(machineClient(session.snapshot().client)); checkSession(); return session.start(); }
      if(method==="login"){
        if(!(session instanceof CodexSession))throw new Error("请在对应客户端完成登录。");
        const login=await session.login();checkSession();await shell.openExternal(login.url);return session.snapshot();
      }
      if (method === "surface") { checkSession(); return session.switchSurface!(input.surface); }
      if (method === "terminal_input") { session.terminalInput!(input.data, input.generation); return; }
      if (method === "terminal_resize") { session.terminalResize!(input.cols, input.rows, input.generation); return; }
      if (method === "draft") return session.updateDraft(input.text, input.context_refs,{surface:input.surface,generation:input.generation});
      if(method==="attach_context"){
        if(!selected||!authoring||!(session instanceof CodexSession))throw Error("请在当前作品的聊天界面附加上下文。");
        const reference=await prepareAgentContext(input,selected,contextHandoff);
        checkSession();return session.attachContext(reference,{generation:input.generation},checkSession);
      }
      if(method==="remove_context"){
        if(!(session instanceof CodexSession))throw Error("当前引擎使用终端输入。");
        return session.removeContext(input.reference,{generation:input.generation});
      }
      if (method === "recover") return session.recover!();
      if (method === "models") return session.models!();
      if (method === "results") {
        const client=machineClient(session.snapshot(false).client);
        const tools="readTools" in session?await session.readTools():session.snapshot(false).tools??[];
        if(!selected){
          const discovered:any[]=[];let cursor:string|undefined;
          do{const result=unwrap(await scopedCli(coreCliBinary(),client,process.env.HETU_COLLABORATION_DIR,"hetu.collaboration.created_works",{limit:100,...(cursor?{cursor}:{})}));discovered.push(...result.works);cursor=result.next_cursor??undefined;}while(cursor);
          await library.refresh(discovered);check();
          checkSession();window?.webContents.send("desktop:agent-session",{type:"notification",method:"results/verified",params:{},session_id:session.snapshot(false).session_id});
          return readLibrarySessionResults(tools,library.rows(),new Set(discovered.map(item=>item.workspace_id)));
        }
        const context=collaborationContext(client),access=await context.status();
        if(!access.authorized||!access.management_ref)throw new Error("当前作品的机器连接已断开，成果尚未回读。");
        const results=await readSessionResults(tools,selected,async(action,input)=>{
          context.check();
          const fixed=action==="hetu.execution.get_plan"?input:{...input,management_ref:access.management_ref};
          const data=unwrap(await scopedCli(coreCliBinary(),client,process.env.HETU_COLLABORATION_DIR,action,fixed));
          context.check();return data;
        });
        checkSession();
        window?.webContents.send("desktop:agent-session",{type:"notification",method:"results/verified",params:{},session_id:session.snapshot(false).session_id,work_ref:selected});
        return results;
      }
      if (method === "insert") { if (selected ? !input.work_ref || !sameWork(selected,input.work_ref) : input.scope!=="library" || input.work_ref) throw new Error("作品已切换，请重新准备请求。");if(selected)await ensureConnection(machineClient(session.snapshot().client));checkSession();return session.insertDraft(input.text,checkSession); }
      if(method==="paste_draft"){if(!("pasteDraft" in session))throw new Error("此引擎请使用原生请求入口。");return session.pasteDraft(input.draft_version);}
      if (method === "send") {
        const text = typeof input.text === "string" ? input.text : "";
        if (selected) { const access = await ensureConnection("codex"); if (!access.management_ref || typeof access.management_ref !== "object") throw new Error("当前作品的机器连接不可用。"); }
        checkSession();
        const fixed=session.snapshot(false),draftVersion=fixed.draft_version??0;
        if(input.draft_version!==undefined&&input.draft_version!==draftVersion)throw Error("草稿或附加上下文已变化，请核对后重新发送。");
        const references=await verifyAgentContexts(fixed.context_refs??[],selected,contextHandoff);
        checkSession();
        if((session.snapshot(false).draft_version??0)!==draftVersion)throw Error("核对期间草稿已变化，未发送旧请求。");
        const context: AgentSessionContext = {
          schema_version: "1",
          work_ref: selected,
          scope: selected ? "current_work_only" : "creation_preparation",
          machine_entrypoint: "hetu CLI/MCP",
          first_action: "先通过河图稳定CLI/MCP发现实际能力，再按当前作品范围执行",
          ...(references.length?{fixed_context:references}:{}),
        };
        return session.send(buildAgentSessionPrompt(context, text), text, { attempt_id: input.attempt_id, model: input.model, reasoning_effort: input.reasoning_effort,draft_version:draftVersion,context_refs:references });
      }
      if (method === "interrupt") return session.interrupt();
      if (method === "respond") { await session.respond(input.id, input.result, input.generation); return session.snapshot(); }
      if (method === "stop") { await session.stop(); return session.snapshot(); }
      throw new Error("未知 Agent 会话操作。");
    });
    shellHandler("desktop:settings-agent", (method: string, input: any = {}) => workAgentRequest(method, input, {
      directory: "", settings, check: () => {}, refresh: refreshSettings,
      inspect: params => settingsServer.request("local_settings/host", { method: "inspect_suite", input: params }),
      prepare: params => agentSettings("hetu.local_settings.prepare", params),
      choose: async () => { const result = await dialog.showOpenDialog(settingsWindow.window ?? window, { properties: ["openDirectory"], title: "选择已安装的创作套件" }); return result.canceled ? undefined : result.filePaths[0]; },
      reveal: directory => shell.showItemInFolder(directory),
    }));
    shellHandler("desktop:settings", async (method: string, input: any = {}) => {
      if (method.startsWith("storage_")) return storageRequest(method, input, (action, params) => storageAction(params => settingsServer.request("local_settings/request", params), action, params), async (message, detail) => (await dialog.showMessageBox(settingsWindow.window ?? window, { type: "warning", buttons: ["取消", "确认清理"], defaultId: 0, cancelId: 0, message, detail })).response === 1);
      if (method === "preferences") {
        const snapshot = await settings.preferences();
        if (snapshot.revision !== localState.revision) await refreshSettings();
        return snapshot;
      }
      if (method === "get") return { ...(await refreshSettings()), journal: await settings.journal() };
      if (method === "list") return settings.list(input.cursor);
      if (method === "operation") return settings.operation(input.operation_id);
      if (method === "prepare") return settings.prepare(input.operation_id, input.sha256, input.revision, input.approve);
      if (method === "manual") return settings.manual(input.expected_revision, input.patch);
      if (method === "update") {
        const preview = await settings.manual(input.expected_revision, input.patch);
        const result = await settings.commit(preview.token);
        await settings.acknowledge();
        await refreshSettings(result);
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
        const ticket=epoch;
        clipboard.writeText(await settingsHandoff(method,input,{work,settings,environment:handoffEnvironment(),check:()=>{if(epoch!==ticket)throw new Error("作品已切换，请重新交接。");}}));
        return {copied:true};
      }
      throw new Error("未知本机设置用例。");
    });
    shellHandler("desktop:install-suite", async (input: any = {}) => {
      const selected = input.work_ref;
      if (selected && (!work || !sameWork(selected, work))) throw new Error("作品已切换，请重新安装。");
      const state = await settings.get(), association = workAssociation(state, selected);
      if (!state.installable_clients.includes(association.client)) throw new Error("当前客户端请按接入说明安装。");
      const client = ({claudeCode:"claude-code"} as Record<string,string>)[association.client] ?? association.client;
      const target = {kind:"agent_suite" as const,agent_client:association.client,suite_id:association.suite,...(selected?{work_ref:selected}:{})};
      const key = createHash("sha256").update(JSON.stringify(target)).digest("hex");
      const installer = new AgentConnectionInstall((action,input) => agentSettings(action,input,client), async plan => {
        const preview = await settings.prepare(plan.operation_id,plan.sha256,plan.revision,true);
        const answer = await dialog.showMessageBox(settingsWindow.window ?? window,{type:"question",buttons:["取消","安装 Skills"],defaultId:0,cancelId:0,
          message:"安装当前 Skills 套件？",detail:association.client + "\n" + plan.fixed.suite.name + " " + plan.fixed.suite.version + "\n只安装当前所选套件，不改变作品内容。"});
        if(answer.response!==1)throw new Error("已取消 Skills 安装。");
        if(selected && (!work || !sameWork(selected,work)))throw new Error("作品已切换，请重新安装。");
        await settings.commit(preview.token);await settings.acknowledge();
      },recovery,path.join(app.getPath("userData"),"suite-install-"+key+".json"));
      const result=await installer.run(target);await refreshSettings();return result;
    });
    shellHandler("desktop:install-connection", async (client: string) => {
      if (client !== "codex") throw new Error("当前只提供 Codex 受管连接安装。");
      const result = await agentConnectionInstall.run(); await refreshSettings(); return result;
    });
    shellHandler(
      "desktop:connection",
      async (method: string, client: string) => {
        const context = collaborationContext(client);
        if (method === "select") {
          await agentSession?.stop(); agentSession = undefined;
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
          await agentSessions?.stopWork(work); agentSession = undefined;
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
      agentSession = undefined;
      unwrap(await core("hetu.works.get", { work_ref: ref }));
      epoch++;
      await media?.dispose();
      media = undefined;
      await closeSurface();
      work = ref;
      const selectedEpoch = epoch,
        selectedServer = server!;
      workSession = createWorkSession(ref, selectedServer, {
        profile: app.getPath("userData"), recovery,
        workspacePath: library.resolve(ref),
        active: () => epoch === selectedEpoch && server === selectedServer && !!work && sameWork(work, ref),
        scopedReview, agentClient, collaborationContext, coreCliBinary,
        executionPolicy: () => settings.preferences(),
        professionalPlugins:async()=>{await reloadPlugins();return {plugins:pluginSummaries(host,prefs),plugin_state_error:pluginStateError||undefined};},
        confirm: async (message, detail, accept = "确认") => (await dialog.showMessageBox(window, {
          type: "question", buttons: ["取消", accept], defaultId: 0, cancelId: 0, message, detail,
        })).response === 1,
        chooseFile: async options => { const value = await dialog.showOpenDialog(window, options); return value.canceled ? undefined : value.filePaths[0]; },
        saveFile: async options => { const value = await dialog.showSaveDialog(window, options); return value.canceled ? undefined : value.filePath; },
        copy: text => clipboard.writeText(text),
      });
      ({ taskReview, authoring, management, versions, resources, media, videoReview, outlineReview, covers, novelDetails, canon } = workSession);
      return overview();
    });
    for (const method of ["tasks", "read", "execution", "professional", "canon", "novel", "covers", "outlines", "video", "media", "resources", "versions", "author", "management", "buffer"]) {
      shellHandler("desktop:" + method, (...args: any[]) => {
        if (!workSession) throw new Error("请选择当前作品。");
        return workSession.call(method, args);
      });
    }
    shellHandler("desktop:dirty", (value: boolean) => {
      dirty = value === true;
    });
    shellHandler(
      "desktop:handoff",
      async (pageId: string, object: Record<string, unknown> = {}, delivery?: string) => {
        if (delivery !== undefined && delivery !== "draft") throw new Error("不支持的协作交接方式。");
        const managed = delivery === "draft";
        if (pageId.startsWith("fallback:")) {
          const owner = pageId.slice(9), context = await pluginContext(owner);
          const fixed = await pluginResultHandoff(context, owner, object);
          context.check();
          if (managed) {
            await ensureConnection(await managedClient()); context.check();
            return {work_ref:context.work,prompt:"请通过河图公开机器入口发现当前插件能力，读取固定成果后按我的目标准备和执行；保留CAS与原操作，未知先回读。采纳、定稿及费用决定独立处理。\n"+JSON.stringify({...fixed,page:"plugin.results",plugin_id:owner,package_sha256:context.packageSha,first_action:"hetu.plugins.capabilities",machine_entrypoint:"hetu CLI/MCP"},null,2)};
          }
          clipboard.writeText(pluginResultText(fixed,pluginMachineConnection(owner,context.work),agentClient()));
          return { copied: true };
        }
        if (!work || !authoring) throw new Error("请选择当前作品。");
        const selectedEpoch=epoch, selectedWork=work, currentAuthoring=authoring;
        // 交接是作者明确发起的协作入口；沿现有连接或自动建立当前作品连接，
        // 让 CLI、MCP 与桌面拿到同一精确 management_ref。
        const client=managed?await managedClient():agentClient();
        const access = await ensureConnection(client);
        const prompt = await workHandoff(pageId,object,{work:selectedWork,managedSession:managed,authoring:currentAuthoring,environment:{...handoffEnvironment(),client},
          workspacePath:library.resolve(selectedWork),executionPolicy:()=>settings.get(),summary:async()=>unwrap(await core("hetu.works.get",{work_ref:selectedWork})).summary,
          check:()=>{if(selectedEpoch!==epoch)throw new Error("作品已变化，请重新交接。");},
          managementRef: access.management_ref,
          pluginConnection:binding?pluginMachineConnection(binding.owner,binding.work):undefined,
        });
        if (managed) return {prompt,work_ref:selectedWork};
        clipboard.writeText(prompt);
        return { copied: true };
      },
    );
    shellHandler("desktop:writing-prompt", async (input: WritingPromptRequest) => {
      if (!work || !authoring) throw new Error("请选择当前作品。");
      const selectedEpoch = epoch, selectedWork = work, currentAuthoring = authoring;
      validateWritingPrompt(input, selectedWork);
      const client=await managedClient(),access=await ensureConnection(client);
      return writingPrompt(input, {work: selectedWork, managedSession:true, authoring: currentAuthoring, environment: {...handoffEnvironment(),client},
        workspacePath: library.resolve(selectedWork), executionPolicy: () => settings.get(),
        summary: async () => unwrap(await core("hetu.works.get", {work_ref: selectedWork})).summary,
        check: () => {if (selectedEpoch !== epoch) throw new Error("作品已变化，请重新生成提示词。");},
        managementRef: access.management_ref,
      });
    });
    shellHandler("desktop:copy", copyText);
    shellHandler("desktop:paste", pasteText);
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
          zoomFactor: window.webContents.getZoomFactor(),
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
        preferences:()=>(pluginPreferences(localState, nativeTheme.shouldUseDarkColors ? "dark" : "light")),
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
          clipboard.writeText(pluginWorkText(input,current.work,current.owner,connection.management_ref,pluginMachineConnection(current.owner,current.work),agentClient()));
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
        if (selectedEpoch !== epoch) throw new Error("作品已变化，请重新交接。");
        clipboard.writeText(migrationText(fixed,pluginMachineConnection(input.owner,fixed.work_ref),agentClient()));
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
// 由正常close事件等待落盘；before-quit内再次关窗会重入原退出流程。
let enginesClosed = false, enginesClosing = false;
app.on("before-quit", event => {
  quitRequested = true;
  if (enginesClosed || !agentSessions) return;
  event.preventDefault();
  if (enginesClosing) return;
  enginesClosing = true;
  void agentSessions.stopAll().then(() => { enginesClosed = true; app.quit(); }).catch(error => { enginesClosing = false; dialog.showErrorBox("Codex进程退出待核对", error.message); });
});
// 普通关闭最后一个窗口时也在本轮事件结束后退出。
app.on("window-all-closed", () => { setImmediate(() => app.quit()); });

}
