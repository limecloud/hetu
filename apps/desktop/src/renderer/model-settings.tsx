import React, { useEffect, useRef, useState } from "react";
import { desktop } from "./bridge.ts";
import { IconButton, PageActions } from "./workbench.tsx";

const kinds = [{ id: "text", title: "文字模型" }, { id: "image", title: "图片模型" }];
const codes = (value: string) => value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);

/** 凭据只在当前密码输入中存在，保存后清空；普通协作入口不接触此表单。 */
export function ModelSettings() {
  const [connection, setConnection] = useState<any>(), [catalogs, setCatalogs] = useState<Record<string, any>>({}),
    [busy, setBusy] = useState(false), [error, setError] = useState(""), [editor, setEditor] = useState<any>(),
    [apiKey, setApiKey] = useState(""), [unknown, setUnknown] = useState(false);
  const live = useRef(true), dialog = useRef<HTMLDialogElement>(null), returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (editor) {if (!dialog.current?.open) dialog.current?.showModal();}
    else if (!busy && returnFocus.current) {returnFocus.current.focus(); returnFocus.current = null;}
  }, [!!editor, busy]);
  function closeEditor() { setEditor(undefined); setApiKey(""); setError(""); }
  async function inspect() {
    const state = await desktop.models("inspect");
    if (!live.current) return;
    setConnection(state);
    const next: Record<string, any> = {};
    for (const kind of kinds) {
      if (!state.connected && (!state.channels?.[kind.id] || state.channels[kind.id] === "cloud")) continue;
      try { next[kind.id] = await desktop.models("catalog", { kind: kind.id }); }
      catch (e) { if (live.current) setError((e as Error).message); }
    }
    if (live.current) setCatalogs(next);
    return state;
  }
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (e) { if (live.current) setError((e as Error).message); }
    finally { if (live.current) setBusy(false); }
  }
  useEffect(() => {
    live.current = true;
    void run(inspect);
    return () => { live.current = false; };
  }, []);
  function edit(id?: string) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const profile = id ? connection.custom_channels[id] : undefined;
    setEditor({ channel_id: id ?? `channel_${crypto.randomUUID()}`, name: profile?.name ?? "", base_url: profile?.base_url ?? "",
      text: (profile?.models.text ?? []).join("\n"), image: (profile?.models.image ?? []).join("\n"), previous: profile });
    setApiKey(""); setUnknown(false); setError("");
  }
  async function save() {
    setUnknown(true);
    await desktop.models("custom_save", { channel_id: editor.channel_id, name: editor.name, base_url: editor.base_url,
      api_key: apiKey, models: { text: codes(editor.text), image: codes(editor.image) } });
    setApiKey(""); setUnknown(false); setEditor(undefined);
    await inspect();
  }
  async function recover() {
    const state = await inspect(), profile = state?.custom_channels?.[editor.channel_id];
    const expectedBase = new URL(editor.base_url).origin + "/v1";
    if (profile?.name === editor.name.trim() && profile.base_url === expectedBase
      && ["text", "image"].every(kind => JSON.stringify(profile.models[kind]) === JSON.stringify(codes(editor[kind])))
      && (!apiKey || profile.credential_ref !== editor.previous?.credential_ref)) {
      setApiKey(""); setUnknown(false); setEditor(undefined);
    } else {
      // 只读未证实保存，保留原输入供作者核对，不自动重发凭据。
      setError("尚未确认本次保存，请核对渠道后继续。");
      setUnknown(false);
    }
  }
  const channelEditor = editor && <dialog ref={dialog} className="model-channel-dialog" aria-labelledby="channel-editor-title" onCancel={event => { if (busy) event.preventDefault(); else closeEditor(); }}>
    <section className="model-settings" aria-label="编辑模型渠道">
    <h2 id="channel-editor-title" className="settings-section-heading">{editor.previous ? "编辑渠道" : "添加渠道"}</h2>
    <form onSubmit={event => { event.preventDefault(); void run(save); }}>
      <fieldset disabled={busy || unknown}>
        <label>渠道名称<input required maxLength={200} value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })}/></label>
        <label>服务地址<input required type="url" placeholder="https://…/v1" value={editor.base_url} onChange={e => setEditor({ ...editor, base_url: e.target.value })}/></label>
        <label>API Key<input type="password" autoComplete="off" required={!editor.previous} maxLength={8192} value={apiKey} onChange={e => setApiKey(e.target.value)}/></label>
        <p className="settings-note">{editor.previous ? "留空保留原密钥；更改地址时须重新填写。" : "密钥仅保存在本机。"}</p>
        <label>文字模型<textarea rows={2} value={editor.text} onChange={e => setEditor({ ...editor, text: e.target.value })}/></label>
        <label>图片模型<textarea rows={2} value={editor.image} onChange={e => setEditor({ ...editor, image: e.target.value })}/></label>
        <p className="settings-note">每行一个模型代码，调用费用由渠道提供方收取。</p>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button type="button" disabled={busy} onClick={closeEditor}>取消</button>
        {unknown ? <button type="button" disabled={busy} onClick={() => void run(recover)}>检查本次保存</button>
          : <button type="submit" className="primary" disabled={busy}>保存渠道</button>}
      </div>
    </form>
  </section></dialog>;
  return <section className="model-settings" aria-label="模型服务">
    <PageActions><IconButton icon="refresh" label="刷新模型服务" disabled={busy} onClick={() => void run(inspect)}/></PageActions>
    {error && !editor && <p role="alert">{error}</p>}
    {!connection ? <p role="status">正在读取模型设置…</p> : <>
      <section className="settings-group"><h3>河图账号</h3><div className="model-account">
        <div className="settings-field"><span>连接状态</span><output>{connection.connected ? "已连接" : "未连接"}</output></div>
        <div className="actions">
          {connection.connected && <button disabled={busy} onClick={() => void run(() => desktop.models("account"))}>账号与费用</button>}
          {!connection.pending && <button disabled={busy} onClick={() => void run(async () => { await desktop.models("connect"); await inspect(); await desktop.models("verify"); })}>{connection.connected ? "重新连接" : "连接账号"}</button>}
          {(connection.connected || connection.pending) && <button disabled={busy} onClick={() => void run(async () => { await desktop.models("disconnect"); await inspect(); })}>断开连接</button>}
        </div>
        {connection.pending && <><div className="settings-field"><span>确认码</span><output>{connection.pending.verification_code}</output></div><div className="actions">
          <button disabled={busy} onClick={() => void run(() => desktop.models("verify"))}>打开确认页</button>
          <button disabled={busy} onClick={() => void run(async () => { const result = await desktop.models("poll"); await inspect(); if (result.status === "pending") setError("等待浏览器确认连接。"); })}>我已完成连接</button>
        </div></>}
      </div></section>
      <section className="settings-group"><h3>自定义渠道</h3><div>
        {Object.entries(connection.custom_channels ?? {}).map(([id, profile]: [string, any]) => <div className="model-channel" key={id}><div><strong>{profile.name}</strong><p>{profile.base_url}</p></div><button disabled={busy} onClick={() => edit(id)}>编辑</button></div>)}
        <div className="model-add"><button disabled={busy} onClick={() => edit()}>添加渠道</button></div>
      </div></section>
      {kinds.map(kind => {
        const selected = connection.defaults?.[kind.id] ?? "", channel = connection.channels?.[kind.id] ?? "cloud", items = catalogs[kind.id]?.items ?? [];
        return <section className="settings-group" key={kind.id}><h3>{kind.title}</h3><div>
          <label className="settings-field"><span>渠道</span><select aria-label={kind.title + "渠道"} disabled={busy} value={channel} onChange={e => void run(async () => { await desktop.models("channel_select", { kind: kind.id, channel_id: e.target.value }); await inspect(); })}>
            <option value="cloud">河图模型服务</option>{Object.entries(connection.custom_channels ?? {}).map(([id, profile]: [string, any]) => <option key={id} value={id}>{profile.name}</option>)}
          </select></label>
          <label className="settings-field"><span>默认模型</span><select aria-label={kind.title + "默认模型"} disabled={busy || !items.length} value={selected} onChange={e => void run(async () => { await desktop.models("select", { kind: kind.id, model_id: e.target.value }); await inspect(); })}>
            <option value="" disabled>请选择模型</option>
            {selected && !items.some((item: any) => item.id === selected) && <option value={selected}>{selected}（当前不可用）</option>}
            {items.map((item: any) => <option key={item.id} value={item.id}>{item.id}{channel === "cloud" && item.billing?.credits_per_unit != null ? ` (${item.billing.credits_per_unit} Credits)` : ""}</option>)}
          </select></label>
          {!items.length && <p className="settings-note">{channel === "cloud" && !connection.connected ? "连接账号后选择模型。" : "当前渠道没有可用模型。"}</p>}
        </div></section>;
      })}
    </>}
    {channelEditor}
  </section>;
}
