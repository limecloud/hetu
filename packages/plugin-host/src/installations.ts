/** 桌面与机器入口共用插件安装状态、依赖解析和包快照。 */
import { mkdir, readFile, writeFile, rename, unlink, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { PluginPackage } from "./package.ts";
import { PluginHost } from "./registry.ts";
import Ajv from "ajv";
import installationSchema from "../../../contracts/schemas/plugin-installation.schema.json" with { type: "json" };
import manifestSchema from "../../../contracts/schemas/plugin-manifest.schema.json" with { type: "json" };
import { skillSummaries } from "./skills.ts";
import { PluginInvocationRejected } from "./rejection.ts";
export type InstalledPackageIdentity = Pick<PluginPackage, "manifest" | "sha256">;
const validateState = new Ajv({ strict: false }).addSchema(manifestSchema, "urn:hetu:plugin-manifest:1").compile(installationSchema);

export interface InstallationState {
  format_version?: 1;
  packages: { path: string; sha256: string; enabled: boolean; removed?: boolean; manifest?: PluginPackage["manifest"] }[];
  grants: Record<string, string>;
  operations?: Record<string, { input_sha256: string; result: unknown; authorization_note: string; client_adapter: string }>;
}

/** 展示目录保留已卸载及不可用包，读取既有成果不需要加载其代码。 */
export function pluginSummaries(host: PluginHost, state: InstallationState) {
  const describe = (manifest: PluginPackage["manifest"]) => ({
    display: manifest.display, description: manifest.description,
    version: manifest.version, work_kinds: manifest.work_kinds,
  });
  return [
    ...host.states().map(status => ({...status, package_sha256:host.package(status.id).sha256, ...describe(host.package(status.id).manifest)})),
    ...state.packages.flatMap(entry => {
      const manifest = entry.manifest;
      return !manifest || host.has(manifest.id) ? [] : [{
        id: manifest.id, installed: false, selected: false, package_sha256:entry.sha256,
        state: entry.removed ? "uninstalled" : "unavailable",
        reason: host.loadErrors.get(manifest.id), ...describe(manifest),
      }];
    }),
  ];
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class PluginInstallations {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    if (!path.isAbsolute(directory)) throw new Error("插件状态目录须为绝对路径。");
  }
  get file() { return path.join(this.directory, "plugin-state.json"); }
  async read(): Promise<{ state: InstallationState; sha256: string }> {
    let state: InstallationState;
    try { state = JSON.parse(await readFile(this.file, "utf8")); }
    catch (error: any) {
      if (error.code !== "ENOENT") throw new Error("插件状态无法读取，已停止写入。");
      state = { packages: [], grants: {} };
    }
    if (!validateState(state))
      throw new Error("插件状态无效。");
    return { state, sha256: digest(state) };
  }
  async #locked<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lock = this.file + ".lock", token = randomUUID();
    const acquire = () => writeFile(lock, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
    try { await acquire(); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const previous = await readFile(lock, "utf8");
      const owner = JSON.parse(previous);
      let dead = false;
      try { process.kill(owner.pid, 0); } catch (e: any) { dead = e.code === "ESRCH"; }
      if (!dead || await readFile(lock, "utf8") !== previous) throw new Error("插件状态忙，请按原操作回读。");
      await unlink(lock);
      await acquire();
    }
    try { return await fn(); }
    finally {
      if (JSON.parse(await readFile(lock, "utf8")).token === token) await unlink(lock);
    }
  }
  async #write(state: InstallationState) {
    state.format_version = 1;
    if (!validateState(state)) throw new Error("插件状态不符合当前格式。");
    const temp = this.file + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, this.file);
    return digest(state);
  }
  async save(state: InstallationState, expected: string) {
    return this.#locked(async () => {
      if ((await this.read()).sha256 !== expected) throw new Error("插件状态已由另一入口修改，请刷新后继续。");
      return this.#write(state);
    });
  }
  async host(state: InstallationState, target?: string) {
    const host = new PluginHost();
    let packages=state.packages;
    if(target && state.packages.every(item=>item.removed||item.manifest)){
      const needed=new Set<string>(),pending=[target];
      while(pending.length){
        const id=pending.pop()!;if(needed.has(id))continue;needed.add(id);
        const entry=state.packages.find(item=>!item.removed&&item.manifest?.id===id);
        if(entry)pending.push(...entry.manifest!.dependencies.map(dep=>dep.id));
      }
      packages=state.packages.filter(item=>item.manifest&&needed.has(item.manifest.id));
    }
    // 仅并发读取与核验；贡献注册和依赖生命周期保持原顺序。
    for (let offset = 0; offset < packages.length; offset += 4) {
      const batch = packages.slice(offset, offset + 4).filter(item => !item.removed);
      const results = await Promise.allSettled(batch.map(item => PluginPackage.inspect(item.path, item.sha256)));
      for (const [index, result] of results.entries()) {
        const item = batch[index];
        try {
          if (result.status === "rejected") throw result.reason;
          const pkg = result.value;
          if (pkg.sha256 !== item.sha256 || item.manifest && pkg.manifest.id !== item.manifest.id)
            throw new Error("已安装插件的固定包摘要不一致。");
          host.add(pkg);
        } catch (error) {
          host.loadErrors.set(item.manifest?.id ?? item.sha256, error instanceof Error ? error.message : "插件包无法读取。");
        }
      }
    }
    for (const item of packages)
      if (!item.removed && item.manifest && item.enabled && host.has(item.manifest.id))
        await host.enable(item.manifest.id);
    // 最后应用显式停用，防止后遍历的上层包重新激活已停用依赖。
    for (const item of packages)
      if (!item.removed && item.manifest && !item.enabled && host.has(item.manifest.id))
        await host.disable(item.manifest.id);
    return host;
  }
  async snapshot(pkg: PluginPackage) {
    const directory = path.join(this.directory, "plugin-packages", pkg.sha256);
    let existing: string | undefined;
    try { existing = await realpath(directory); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    // 已安装包就是运行快照；重验固定字节，不在打开工作面时重写同一份安装文件。
    if (existing === pkg.source) {
      await PluginPackage.inspect(directory, pkg.sha256);
      return directory;
    }
    await mkdir(directory, { recursive: true });
    for (const [name, bytes] of pkg.entries()) {
      const target = path.join(directory, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { mode: 0o600 });
    }
    await PluginPackage.inspect(directory, pkg.sha256);
    return directory;
  }
  async inspect() {
    const { state, sha256 } = await this.read(), host = await this.host(state);
    return { state_sha256: sha256, packages: state.packages,
      skills: host.states().filter(item => item.state === "active").flatMap(item => skillSummaries(host.package(item.id))),
      states: [
      ...host.states(),
      ...state.packages.filter(item => !item.removed && item.manifest && host.loadErrors.has(item.manifest.id))
        .map(item => ({ id: item.manifest!.id, installed: true, selected: item.enabled,
          state: "failed", reason: host.loadErrors.get(item.manifest!.id) })),
    ] };
  }
  async apply(input: any, revoke: (pkg: InstalledPackageIdentity) => Promise<void>) {
    if (!["codex", "claude-code", "workbuddy", "generic", "desktop"].includes(input.client_adapter)
      || typeof input.operation_key !== "string" || !input.operation_key.trim() || input.operation_key.length > 128
      || typeof input.authorization_note !== "string" || !input.authorization_note.trim() || input.authorization_note.length > 8000)
      throw new PluginInvocationRejected("须提供客户端、原操作键与真实的安装选择。");
    return this.#locked(async () => {
      const { state, sha256 } = await this.read(), key = digest([input.client_adapter, input.operation_key]);
      const previous = state.operations?.[key], input_sha256 = digest(input);
      if (previous) {
        if (previous.input_sha256 !== input_sha256) throw new PluginInvocationRejected("原操作键已绑定其他输入。");
        return previous.result;
      }
      if (sha256 !== input.expected_sha256) throw new PluginInvocationRejected("插件状态已变化，请重新审阅。");
      const host = await this.host(state);
      let pkg: InstalledPackageIdentity;
      if (input.action === "install") {
        try { pkg = await PluginPackage.inspect(input.package_directory); }
        catch (error) { throw new PluginInvocationRejected(error instanceof Error ? error.message : "插件包无法读取。"); }
      } else {
        const installed = state.packages.find(item => !item.removed && item.manifest?.id === input.plugin_id);
        if (!installed?.manifest) throw new PluginInvocationRejected("插件未安装。");
        pkg = { manifest: installed.manifest, sha256: installed.sha256 };
      }
      if (pkg.sha256 !== input.package_sha256) throw new PluginInvocationRejected("操作与已选择的插件包摘要不一致。");
      const affected = new Set<string>();
      if (input.action !== "install" || state.packages.some(item => !item.removed && item.manifest?.id === pkg.manifest.id)) affected.add(pkg.manifest.id);
      if (input.action !== "enable") {
        let changed = true;
        while (changed) {
          changed = false;
          for (const item of state.packages)
            if (!item.removed && item.manifest && !affected.has(item.manifest.id) && item.manifest.dependencies.some(d => affected.has(d.id))) {
              affected.add(item.manifest.id); changed = true;
            }
        }
      }
      if (!["install", "enable", "disable", "uninstall"].includes(input.action)) throw new PluginInvocationRejected("未知插件安装动作。");
      if (input.action !== "enable") {
        for (const owner of affected) {
          const item = state.packages.find(item => !item.removed && item.manifest?.id === owner)!;
          await revoke({ manifest: item.manifest!, sha256: item.sha256 });
          for (const key of Object.keys(state.grants)) if (JSON.parse(key)[0] === owner) delete state.grants[key];
        }
      }
      if (input.action === "install") {
        const verified = pkg as PluginPackage;
        const directory = await this.snapshot(verified);
        if (host.has(pkg.manifest.id)) await host.replace(verified); else host.add(verified);
        state.packages = state.packages.filter(p => p.manifest?.id !== pkg.manifest.id);
        state.packages.push({ path: directory, sha256: pkg.sha256, enabled: true, manifest: pkg.manifest });
        await host.enable(pkg.manifest.id);
      } else if (input.action === "enable") await host.enable(pkg.manifest.id);
      else if (input.action === "disable") {
        for (const owner of affected) {
          if (host.has(owner)) await host.disable(owner);
          state.packages.find(item => !item.removed && item.manifest?.id === owner)!.enabled = false;
        }
      }
      else {
        for (const owner of affected) {
          if (host.has(owner)) await host.disable(owner);
          state.packages.find(item => !item.removed && item.manifest?.id === owner)!.enabled = false;
        }
        if (host.has(pkg.manifest.id)) await host.remove(pkg.manifest.id);
        const item = state.packages.find(p => p.sha256 === pkg.sha256)!;
        item.enabled = false; item.removed = true;
      }
      for (const current of host.states()) {
        const item = state.packages.find(p => p.sha256 === host.package(current.id).sha256)!;
        item.enabled = current.selected;
      }
      const result = { plugin_id: pkg.manifest.id, package_sha256: pkg.sha256, action: input.action, states: host.states() };
      state.operations ??= {};
      state.operations[key] = { input_sha256, result, authorization_note: input.authorization_note, client_adapter: input.client_adapter };
      await this.#write(state);
      return result;
    });
  }
  async getOperation(client: string, operation_key: string) {
    const entry = (await this.read()).state.operations?.[digest([client, operation_key])];
    if (!entry) throw new Error("未找到原插件操作，请保留原键及输入。");
    return entry.result;
  }
}
