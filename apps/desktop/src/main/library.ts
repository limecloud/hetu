import { realpath } from "node:fs/promises";
import path from "node:path";
import { sameWork, type WorkRef } from "@hetu/plugin-sdk";
import { RecoveryStore } from "./recovery.ts";

type Registration = {
  path: string;
  workspace_id: string;
  works: { work_ref: WorkRef; title: string }[];
};
/** 本机位置登记与名称缓存；作品内容及当前身份每次仍由 Core 核验。 */
export class CreativeLibrary {
  #roots: Registration[] = [];
  #views: any[] = [];
  #queue: Promise<any> = Promise.resolve();
  constructor(
    private file: string,
    private recovery: RecoveryStore,
    private read: (directory: string) => Promise<any[]>,
  ) {}
  async load() {
    const record: any = await this.recovery.read(this.file);
    if (record === null) return;
    if (
      record?.schema_version !== 1 ||
      !Array.isArray(record.roots) ||
      record.roots.length > 1000 ||
      record.roots.some(
        (item: any) =>
          !path.isAbsolute(item.path ?? "") ||
          typeof item.workspace_id !== "string" ||
          !Array.isArray(item.works) ||
          item.works.some(
            (work: any) =>
              work.work_ref?.workspace_id !== item.workspace_id ||
              typeof work.title !== "string",
          ),
      )
    )
      throw new Error("创作库位置登记无效，请保留本机记录检查。");
    this.#roots = record.roots;
    this.#views = this.#roots.flatMap((root) =>
      root.works.map((work) => ({
        ...work,
        unavailable: true,
        error: "尚未核验作品位置，请刷新创作库。",
      })),
    );
  }
  rows() {
    return this.#views;
  }
  #serial<T>(fn: () => Promise<T>) {
    const pending = this.#queue.catch(() => {}).then(fn);
    this.#queue = pending;
    return pending;
  }
  #persist() {
    return this.recovery.write(
      this.file,
      { schema_version: 1, roots: this.#roots },
      4 * 1024 * 1024,
    );
  }
  async #register(directory: string, works: any[]) {
    const canonical = await realpath(directory);
    if (
      !works.length ||
      works.some(
        (item) =>
          !item.work_ref ||
          item.work_ref.workspace_id !== works[0].work_ref.workspace_id,
      )
    )
      throw new Error("作品目录没有可核验的创作对象。");
    const workspace_id = works[0].work_ref.workspace_id;
    const existing = this.#roots.find((item) => item.path === canonical);
    if (existing && existing.workspace_id !== workspace_id)
      throw new Error("此位置已被另一工作区占用，请保留旧登记并检查作品目录。");
    const registration = {
      path: canonical,
      workspace_id,
      works: works.map((item) => ({
        work_ref: item.work_ref,
        title: item.title,
      })),
    };
    if (existing) Object.assign(existing, registration);
    else {
      if (this.#roots.length >= 1000)
        throw new Error("创作库登记达到本机上限。");
      this.#roots.push(registration);
    }
    this.#views = [
      ...this.#views.filter(
        (item) => item.work_ref.workspace_id !== workspace_id,
      ),
      ...works.map((item) => ({ ...item, unavailable: false })),
    ];
    await this.#persist();
  }
  register(directory: string, works: any[]) {
    return this.#serial(() => this.#register(directory, works));
  }
  refresh(discovered: { path: string; workspace_id: string }[]) {
    return this.#serial(async () => {
      for (const candidate of discovered) {
        if (
          this.#roots.some(
            (root) => root.workspace_id === candidate.workspace_id,
          )
        )
          continue;
        const works = await this.read(candidate.path);
        if (
          !works.length ||
          works[0].work_ref.workspace_id !== candidate.workspace_id
        )
          throw new Error("Agent 新建作品的真实身份与交接不符。");
        await this.#register(candidate.path, works);
      }
      const views: any[] = [];
      for (const root of this.#roots) {
        try {
          const works = await this.read(root.path);
          if (
            !works.length ||
            works.some(
              (item) => item.work_ref.workspace_id !== root.workspace_id,
            )
          )
            throw new Error("此位置的工作区身份已变化，不能沿旧登记打开。");
          root.works = works.map((item) => ({
            work_ref: item.work_ref,
            title: item.title,
          }));
          views.push(...works.map((item) => ({ ...item, unavailable: false })));
        } catch (e) {
          views.push(
            ...root.works.map((item) => ({
              ...item,
              unavailable: true,
              error: (e as Error).message,
            })),
          );
        }
      }
      this.#views = views;
      await this.#persist();
      return views;
    });
  }
  resolve(reference: WorkRef) {
    const registration = this.#roots.find(
      (root) =>
        root.workspace_id === reference.workspace_id &&
        root.works.some((work) => sameWork(work.work_ref, reference)),
    );
    if (!registration)
      throw new Error("创作对象尚未登记，请先打开或刷新作品。");
    return registration.path;
  }
}
