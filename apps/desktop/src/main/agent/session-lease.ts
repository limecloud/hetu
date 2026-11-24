import { mkdir, readFile, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { atomicJson } from "./session-storage.ts";

function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) return false;
  try { process.kill(pid as number, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function aliveGroup(pid: unknown): boolean {
  if(process.platform === "win32" || !Number.isSafeInteger(pid) || (pid as number)<1)return false;
  try {process.kill(-(pid as number),0);return true;} catch(error) {return (error as NodeJS.ErrnoException).code!=="ESRCH";}
}
/** 只协调河图受管会话。无法证明旧进程退出时不抢占。 */
export class SessionLease {
  #directory: string;
  #nonce = randomUUID();
  #held = false;
  constructor(profile: string, identity: string) {
    this.#directory = path.join(profile, "agent-sessions", "locks", createHash("sha256").update(identity).digest("hex"));
  }
  async acquire() {
    await mkdir(path.dirname(this.#directory), { recursive: true, mode: 0o700 });
    try { await mkdir(this.#directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const recovery = this.#directory + ".recovery";
      try { await mkdir(recovery, { mode: 0o700 }); } catch { throw new Error("另一执行端正在核对旧会话占用，请稍后重试。"); }
      try {
        const previous = JSON.parse(await readFile(path.join(this.#directory, "owner.json"), "utf8").catch(() => "null"));
        if (!previous || alive(previous.owner_pid) || alive(previous.engine_pid) || previous.engine_group && aliveGroup(previous.engine_group)) throw new Error("此会话仍由另一执行端占用，无法确认旧进程退出，请先关闭原会话。");
        await rm(this.#directory, { recursive: true });
        await mkdir(this.#directory, { mode: 0o700 });
      } finally { await rm(recovery, { recursive: true }); }
    }
    this.#held = true;
    await this.update();
  }
  async update(enginePid?: number) {
    if (!this.#held) throw new Error("会话执行权尚未取得。");
    await atomicJson(path.join(this.#directory, "owner.json"), { owner_pid: process.pid, engine_pid: enginePid, engine_group: process.platform === "win32" ? undefined : enginePid, nonce: this.#nonce });
  }
  async release() {
    if (!this.#held) return;
    const record = JSON.parse(await readFile(path.join(this.#directory, "owner.json"), "utf8"));
    if (record.nonce !== this.#nonce) throw new Error("会话执行权已经变化，不能释放其他执行端。");
    await rm(this.#directory, { recursive: true }); this.#held = false;
  }
}
