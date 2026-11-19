import React, { useEffect, useState } from "react";
import { desktop } from "./bridge.ts";
import type { SurfaceContext } from "./contributions.tsx";
import { Icon, IconButton, PageActions } from "./workbench.tsx";
import "./surface-pages.css";
import { AgentAppInstall } from "./agent-app-install.tsx";

export function AgentConnection({ work, notify, ai }: SurfaceContext) {
  const [client, setClient] = useState("codex"),
    [status, setStatus] = useState<any>(),
    [busy, setBusy] = useState(false);
  async function act(
    method: "status" | "authorize" | "revoke",
    selected = client,
  ) {
    setBusy(true);
    try {
      setStatus(await desktop.connection(method, selected));
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void desktop
      .state()
      .then((state) => {
        setClient(state.agentClient);
        return act("status", state.agentClient);
      })
      .catch((error) => notify(error.message));
  }, [work]);
  return (
    <section className="agent-connection surface-page">
      <PageActions>
        <IconButton icon="refresh" label="刷新连接状态" disabled={busy} onClick={() => void act("status")}/>
        <button disabled={busy} onClick={() => ai()}><Icon name="sparkles"/>复制作品协作请求</button>
      </PageActions>
      <label className="agent-client-field">
        协作客户端{" "}
        <select
          aria-label="协作客户端"
          disabled={busy}
          value={client}
          onChange={(event) => {
            const selected = event.target.value;
            setClient(selected);
            setStatus(undefined);
            void desktop
              .connection("select", selected)
              .then(() => act("status", selected))
              .catch((error) => notify(error.message));
          }}
        >
          <option value="codex">Codex</option>
          <option value="claude-code">Claude Code</option>
          <option value="workbuddy">WorkBuddy</option>
          <option value="generic">其他客户端</option>
        </select>
      </label>
      {client === "codex" && <AgentAppInstall disabled={busy}/>}
      <p className="agent-authorization-state">
        <Icon name="shield" size={20}/>
        {status
          ? status.authorized
            ? "已连接当前作品。"
            : "发起协作时自动连接当前作品。"
          : "正在核对作品连接…"}
      </p>
      <div className="actions">
        {status?.authorized ? (
          <button disabled={busy} onClick={() => void act("revoke")}>
            断开当前作品连接
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || !status}
            onClick={() => void act("authorize")}
          >
            连接当前作品
          </button>
        )}
      </div>
      <p className="muted">
        连接仅覆盖当前创作对象。阅读和编辑无需另行接入；采纳、定稿和费用仍按固定结果确认。
      </p>
    </section>
  );
}
