import React, { useEffect, useState } from "react";
import { desktop } from "./bridge.ts";
import type { SurfaceContext } from "./contributions.tsx";
import { Icon, IconButton, PageActions } from "./workbench.tsx";
import "./surface-pages.css";

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
        <IconButton icon="refresh" label="刷新授权状态" disabled={busy} onClick={() => void act("status")}/>
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
      <p className="agent-authorization-state">
        <Icon name="shield" size={20}/>
        {status
          ? status.authorized
            ? "已授权当前作品。"
            : "尚未授权当前作品。"
          : "正在核对作品授权…"}
      </p>
      <div className="actions">
        {status?.authorized ? (
          <button disabled={busy} onClick={() => void act("revoke")}>
            撤销当前作品授权
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || !status}
            onClick={() => void act("authorize")}
          >
            授权当前作品
          </button>
        )}
      </div>
      <p className="muted">
        授权仅覆盖当前创作对象。作者保留采纳与定稿权；作品内容和本机文件权限分别管理。
      </p>
    </section>
  );
}
