import { randomUUID } from "node:crypto";
import type { RecoveryStore } from "./recovery.ts";

type Machine = (action: string, input: Record<string, unknown>) => Promise<any>;
type Pending = { client: "codex"; operation_id: string; sha256: string; operation_key: string; state: "pending" | "registered" };

/** 安装编排只协调已有本机方案；业务权限、固定包和原键恢复仍由Core负责。 */
export class AgentConnectionInstall {
  #active = false;
  constructor(private machine: Machine, private approve: (plan: any) => Promise<void>, private recovery: RecoveryStore, private file: string) {}
  async run() {
    if (this.#active) throw new Error("正在核对接入，请等待当前操作。");
    this.#active = true;
    try {
      let pending = await this.recovery.read(this.file) as Pending | null;
      if (pending && (pending.client !== "codex" || !["pending", "registered"].includes(pending.state) || !/^localop_[0-9a-f-]{36}$/.test(pending.operation_id) || !/^[0-9a-f]{64}$/.test(pending.sha256) || typeof pending.operation_key !== "string")) throw new Error("接入恢复记录无效，请保留后检查。");
      let plan: any;
      if (pending) {
        plan = await this.machine("hetu.local_settings.get_operation", { operation_id: pending.operation_id });
        if (plan.fixed.kind !== "agent_connection" || plan.fixed.agent_client !== "codex" || plan.sha256 !== pending.sha256) throw new Error("原接入方案不匹配，请保留恢复记录。");
      } else {
        plan = await this.machine("hetu.local_settings.prepare", { kind: "agent_connection", agent_client: "codex", summary: "将河图MCP App接入Codex", operation_key: randomUUID() });
      }
      if (plan.state === "pending") await this.approve(plan);
      else if (!["approved", "executing", "executed"].includes(plan.state)) throw new Error("原接入方案未获批准，请核对本机方案。");
      if (!pending) {
        pending = { client: "codex", operation_id: plan.operation_id, sha256: plan.sha256, operation_key: randomUUID(), state: "pending" };
        await this.recovery.write(this.file, pending, 16384);
      }
      // 已开始执行的恢复仅由Core核对原登记与原缓存，不重新安装。
      const executed = await this.machine("hetu.local_settings.execute", { operation_id: pending.operation_id, sha256: pending.sha256, operation_key: pending.operation_key });
      if (executed.state !== "executed" || executed.installation?.state !== "registered") throw new Error("接入结果尚未确认，请沿原操作核对。");
      const inspected = await this.machine("hetu.local_settings.inspect_connection", { agent_client: "codex" });
      if (inspected.registered !== true) throw new Error("当前连接登记未确认，请保留原安装记录核对。");
      await this.recovery.write(this.file, { ...pending, state: "registered" }, 16384);
      return { registered: true, session_loaded: false, installation: executed.installation, operation_id: pending.operation_id };
    } finally { this.#active = false; }
  }
}
