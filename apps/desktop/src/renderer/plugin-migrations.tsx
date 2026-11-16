import React, { useState } from "react";
import { data, desktop } from "./bridge.ts";

export function PluginMigrations({ plugin }: { plugin: any }) {
  const [items, setItems] = useState<any[]>(), [cursor, setCursor] = useState<string>(),
    [preview, setPreview] = useState<any>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  async function run(action: () => Promise<void>) {
    setBusy(true); setNotice("");
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败，请重试。"); }
    finally { setBusy(false); }
  }
  async function load(append = false) {
    const result = data(await desktop.fallback(plugin.id, "hetu.extensions.migrations.list", { limit: 20, ...(append && cursor ? { cursor } : {}) }));
    setItems(current => append ? [...(current ?? []), ...result.migrations] : result.migrations);
    setCursor(result.next_cursor ?? undefined);
    if (!append) setPreview(undefined);
  }
  return <section aria-label={plugin.display["zh-CN"] + "数据升级"}>
    <button disabled={busy} onClick={() => void run(() => load())}>查看数据升级</button>
    {items && <>
      {items.length === 0 && <p className="muted">没有已准备的数据升级。需要时让 Agent 读取旧成果并准备转换方案。</p>}
      {items.map(item => <div className="row" key={item.migration_id}>
        <span>{item.title} {item.from_schema_version} → {item.target_schema_version} {item.state === "executed" ? "已升级" : "待处理"}</span>
        <button disabled={busy} onClick={() => void run(async () => {
          setPreview(undefined);
          if (item.state === "executed" || plugin.state !== "active") {
            setPreview(data(await desktop.fallback(plugin.id, "hetu.extensions.migrations.get", { migration_id: item.migration_id })));
          } else setPreview(await desktop.migrations("preview", { owner: plugin.id, migration_id: item.migration_id, plan_sha256: item.plan_sha256 }));
        })}>审阅升级内容</button>
      </div>)}
      {cursor && <button disabled={busy} onClick={() => void run(() => load(true))}>继续读取升级方案</button>}
    </>}
    {preview && <section aria-label="固定插件数据升级预览">
      <h3>{preview.plan.before.object.title}</h3>
      <p>数据格式 {preview.plan.before.object.schema_version} → {preview.plan.target_schema_version}。批准后由原 Agent 执行，历史版本继续保留。</p>
      <h4>原内容</h4><pre>{JSON.stringify(preview.plan.before.object.content, null, 2)}</pre>
      <h4>升级后内容</h4><pre>{JSON.stringify(preview.plan.content, null, 2)}</pre>
      {preview.token && <button disabled={busy} onClick={() => void run(async () => {
        await desktop.migrations("approve", { token: preview.token });
        setPreview((current: any) => ({ ...current, token: undefined }));
        setNotice("已批准此数据升级，等待原 Agent 执行。");
      })}>批准此数据升级</button>}
      {plugin.state === "active" && <button disabled={busy} onClick={() => void run(async () => {
        await desktop.migrations("continue", { owner: plugin.id, migration_id: preview.plan.migration_id, plan_sha256: preview.plan_sha256 });
        setNotice("已复制此升级的固定交接，交给原 Agent 继续。");
      })}>让 AI 接续此升级</button>}
      <button disabled={busy} onClick={() => setPreview(undefined)}>关闭升级预览</button>
    </section>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
