import React, { useRef, useState, useEffect } from "react";
import { desktop } from "./bridge.ts";

export function AgentAppInstall({ disabled = false, onInstalled }: { disabled?: boolean; onInstalled?(): Promise<void> }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return <div className="actions">
    <button disabled={disabled || busy} onClick={() => {
      setBusy(true);
      void desktop.installConnection("codex").then(async () => {
        await onInstalled?.();
        if (alive.current) setNotice("连接包已登记。请刷新或重启 Codex Desktop，再打开河图面板；当前会话加载尚待核对。");
      }).catch(error => { if (alive.current) setNotice(error.message); }).finally(() => { if (alive.current) setBusy(false); });
    }}>{busy ? "正在核对接入…" : "安装 MCP App"}</button>
    {notice && <p role="status">{notice}</p>}
  </div>;
}
