import type { ViewContribution } from "@hetu/plugin-sdk";
import type { PluginPackage } from "./package.ts";
export type Dispose = () => void | Promise<void>;
export class EffectScope {
  #effects: Dispose[] = [];
  #closed = false;
  #disposal?: Promise<void>;
  effect(dispose: Dispose) {
    if (this.#closed) throw new Error("贡献生命周期已结束。");
    this.#effects.push(dispose);
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#closed = true;
    this.#disposal = Promise.resolve().then(() => this.#dispose());
    return this.#disposal;
  }
  async #dispose() {
    const errors = [];
    for (const dispose of this.#effects.reverse()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#effects = [];
    if (errors.length) throw new AggregateError(errors, "插件清理失败。");
  }
}
export class SlotRegistry<T> {
  #entries = new Map<string, { owner: string; value: T }>();
  register(owner: string, id: string, value: T, scope: EffectScope) {
    if (this.#entries.has(id)) throw new Error("贡献名称冲突：" + id);
    scope.effect(() => {
      this.#entries.delete(id);
    });
    this.#entries.set(id, { owner, value });
  }
  list() {
    return [...this.#entries].map(([id, { owner, value }]) => ({
      id,
      owner,
      value,
    }));
  }
}
export interface PluginState {
  id: string;
  installed: true;
  selected: boolean;
  state: "installed" | "active" | "blocked" | "disabled" | "failed";
  reason?: string;
}
export class PluginHost {
  readonly views = new SlotRegistry<ViewContribution>();
  readonly actions = new SlotRegistry<
    PluginPackage["manifest"]["contributions"]["actions"][number]
  >();
  #packages = new Map<string, PluginPackage>();
  #states = new Map<string, PluginState>();
  #scopes = new Map<string, EffectScope>();
  #transition: Promise<unknown> = Promise.resolve();
  /** 依赖图共享贡献；过渡串行化，防止迟到启用复活已停用的包。 */
  #enqueue<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.#transition.then(action);
    this.#transition = pending.catch(() => {});
    return pending;
  }
  add(pkg: PluginPackage) {
    if (this.#packages.has(pkg.manifest.id))
      throw new Error("同一插件已安装；升级须固定新版本并重新授权。");
    this.#packages.set(pkg.manifest.id, pkg);
    this.#states.set(pkg.manifest.id, {
      id: pkg.manifest.id,
      installed: true,
      selected: false,
      state: "installed",
    });
  }
  package(id: string) {
    const pkg = this.#packages.get(id);
    if (!pkg) throw new Error("插件未安装。");
    return pkg;
  }
  has(id: string) {
    return this.#packages.has(id);
  }
  replace(pkg: PluginPackage) {
    return this.#enqueue(() => this.#replace(pkg));
  }
  async #replace(pkg: PluginPackage) {
    this.package(pkg.manifest.id);
    await this.#disable(pkg.manifest.id);
    this.#packages.set(pkg.manifest.id, pkg);
    this.#states.set(pkg.manifest.id, {
      id: pkg.manifest.id,
      installed: true,
      selected: false,
      state: "installed",
    });
  }
  remove(id: string) {
    return this.#enqueue(async () => {
      await this.#disable(id);
      this.#packages.delete(id);
      this.#states.delete(id);
    });
  }
  states() {
    return [...this.#states.values()].map((s) => ({ ...s }));
  }
  enable(id: string) {
    return this.#enqueue(() => this.#enable(id));
  }
  async #enable(id: string, visiting = new Set<string>()) {
    const pkg = this.package(id),
      state = this.#states.get(id)!;
    if (state.state === "active") return;
    if (visiting.has(id)) throw new Error("插件依赖存在环。");
    visiting.add(id);
    state.selected = true;
    const scope = new EffectScope();
    try {
      for (const dep of pkg.manifest.dependencies) {
        if (this.package(dep.id).manifest.version !== dep.version)
          throw new Error("依赖版本不匹配：" + dep.id);
        await this.#enable(dep.id, new Set(visiting));
        if (this.#states.get(dep.id)?.state !== "active")
          throw new Error("依赖未就绪：" + dep.id);
      }
      for (const view of pkg.manifest.contributions.views)
        this.views.register(id, id + ":" + view.id, view, scope);
      for (const action of pkg.manifest.contributions.actions)
        this.actions.register(id, id + ":" + action.id, action, scope);
      this.#scopes.set(id, scope);
      state.state = "active";
      delete state.reason;
    } catch (error) {
      await scope.dispose();
      state.state = "blocked";
      state.reason = error instanceof Error ? error.message : "插件加载失败。";
    }
  }
  disable(id: string) {
    return this.#enqueue(() => this.#disable(id));
  }
  async #disable(id: string) {
    for (const [other, pkg] of this.#packages) {
      if (
        other !== id &&
        pkg.manifest.dependencies.some((d) => d.id === id) &&
        this.#states.get(other)?.state === "active"
      )
        await this.#disable(other);
    }
    const state = this.#states.get(id);
    if (!state) throw new Error("插件未安装。");
    try {
      await this.#scopes.get(id)?.dispose();
      state.state = "disabled";
      delete state.reason;
    } catch (error) {
      state.state = "failed";
      state.reason = String(error);
    } finally {
      this.#scopes.delete(id);
      state.selected = false;
    }
  }
  active(id: string) {
    return this.#states.get(id)?.state === "active";
  }
}
