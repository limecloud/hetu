import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RecoveryStore } from "./recovery.ts";

type Machine = (action: string, input: Record<string, unknown>) => Promise<any>;
export type InstallTarget = { kind: "agent_connection" | "agent_suite"; agent_client: string; suite_id?: string; work_ref?: unknown };
type Pending = { client: string; operation_id: string; sha256: string; operation_key: string; state: "pending" | "registered" };

/** 宿主仅协调固定安装方案；字节校验、客户端登记和原键恢复归Core。 */
export class AgentConnectionInstall {
  #active = false;
  constructor(private machine: Machine, private approve: (plan: any) => Promise<void>, private recovery: RecoveryStore, private file: string) {}
  async run(target: InstallTarget = {kind:"agent_connection",agent_client:"codex"}) {
    if (this.#active) throw new Error("正在安装，请等待当前操作。");
    this.#active = true;
    try {
      let pending = await this.recovery.read(this.file) as Pending | null;
      if (pending && (pending.client !== target.agent_client || !["pending", "registered"].includes(pending.state) || !/^localop_[0-9a-f-]{36}$/.test(pending.operation_id) || !/^[0-9a-f]{64}$/.test(pending.sha256) || typeof pending.operation_key !== "string")) throw new Error("安装恢复记录无效，请保留后检查。");
      let plan: any;
      if (pending) {
        plan = await this.machine("hetu.local_settings.get_operation", {operation_id:pending.operation_id});
        if (plan.fixed.kind !== target.kind || plan.fixed.agent_client !== target.agent_client || plan.sha256 !== pending.sha256 || (target.kind === "agent_suite" && (plan.fixed.suite.suite_id !== target.suite_id || !isDeepStrictEqual(plan.fixed.work_ref ?? null, target.work_ref ?? null)))) throw new Error("原安装方案不属于当前选择，请保留恢复记录。");
        if (plan.state === "executed") {
          const inspected = await this.inspect(target);
          const current = target.kind === "agent_connection" ? inspected.registered === true && !inspected.version_differs : inspected.state === "found" && !inspected.version_differs && (target.agent_client !== "codex" || inspected.registration === "enabled");
          if (current) return {registered:true,session_loaded:false,installation:plan.installation,operation_id:plan.operation_id};
          // 只有结果已明确的旧版本才准备新安装；未知结果始终恢复原键。
          pending = null; plan = undefined;
        }
      }
      if (!plan) plan = await this.machine("hetu.local_settings.prepare", {...target,...(target.kind === "agent_suite" ? {install:true} : {}),summary:target.kind === "agent_connection" ? "安装河图 MCP App 到 Codex Desktop" : "安装当前所选 Skills 套件",operation_key:randomUUID()});
      if (plan.state === "pending") await this.approve(plan);
      else if (!["approved","executing","executed"].includes(plan.state)) throw new Error("原安装方案未获批准，请核对本机方案。");
      if (!pending) {
        pending = {client:target.agent_client,operation_id:plan.operation_id,sha256:plan.sha256,operation_key:randomUUID(),state:"pending"};
        await this.recovery.write(this.file,pending,16384);
      }
      const executed = await this.machine("hetu.local_settings.execute", {operation_id:pending.operation_id,sha256:pending.sha256,operation_key:pending.operation_key});
      if (executed.state !== "executed" || !["registered","files_installed"].includes(executed.installation?.state)) throw new Error("安装结果尚未确认，请沿原操作恢复。");
      const inspected = await this.inspect(target);
      if (target.kind === "agent_connection" ? inspected.registered !== true : inspected.state !== "found" || target.agent_client === "codex" && inspected.registration !== "enabled") throw new Error("安装后的文件或客户端登记未确认，请沿原操作核对。");
      await this.recovery.write(this.file,{...pending,state:"registered"},16384);
      return {registered:true,session_loaded:false,installation:executed.installation,operation_id:pending.operation_id};
    } finally { this.#active = false; }
  }
  private inspect(target: InstallTarget) {
    return this.machine(target.kind === "agent_connection" ? "hetu.local_settings.inspect_connection" : "hetu.local_settings.inspect_suite", {agent_client:target.agent_client,...(target.suite_id ? {suite_id:target.suite_id} : {})});
  }
}
