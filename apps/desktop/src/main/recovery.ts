import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** 同一恢复稿顺序写入，避免较早的异步写覆盖最后一次编辑。 */
export class RecoveryStore {
  #pending = new Map<string, Promise<unknown>>();
  async read(file: string): Promise<unknown> {
    await this.#pending.get(file);
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("本机恢复稿无法读取，请保留文件后检查。");
    }
  }
  write(file: string, value: unknown, budget: number) {
    const content = JSON.stringify(value);
    if (content === undefined || Buffer.byteLength(content) > budget)
      throw new Error("恢复稿超过预算或格式无效。");
    const pending = (this.#pending.get(file) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = file + "." + randomUUID() + ".tmp";
        const handle = await open(temp, "wx", 0o600);
        try {
          await handle.writeFile(content);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, file);
      });
    this.#pending.set(file, pending);
    return pending;
  }
  async flush() {
    await Promise.all(this.#pending.values());
  }
}
