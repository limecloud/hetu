import React, { useEffect, useRef, useState } from "react";
import { data, desktop, requestAgent } from "./bridge.ts";
import { IconButton } from "./workbench.tsx";
import "./plugin-results.css";

type Summary = { object_id: string; title: string; revision: number; sha256: string };
export function PluginResults({ owner, title, enabled, back }: { owner: string; title: string; enabled: boolean; back(): void }) {
  const [query, setQuery] = useState(""), [items, setItems] = useState<Summary[]>(),
    [cursor, setCursor] = useState<string>(), [busy, setBusy] = useState(false),
    [error, setError] = useState(""), [notice, setNotice] = useState(""),
    [preview, setPreview] = useState<{ object: Summary; content: string }>();
  const generation = useRef(0);
  function invalidate() {
    generation.current++; setItems(undefined); setCursor(undefined); setPreview(undefined);
    setBusy(false); setError(""); setNotice("");
  }
  async function load(more = false, term = query) {
    const request = ++generation.current;
    setBusy(true); setError(""); setNotice("");
    if (!more) { setItems(undefined); setCursor(undefined); setPreview(undefined); }
    try {
      const result = data(await desktop.fallback(owner, "hetu.extensions.objects.search", {
        query: term, limit: 20, ...(more && cursor ? { cursor } : {}),
      }));
      if (request !== generation.current) return;
      setItems(current => more ? [...(current ?? []), ...result.objects] : result.objects);
      setCursor(result.next_cursor ?? undefined);
    } catch (e) {
      if (request !== generation.current) return;
      setCursor(undefined); setError((e as Error).message);
    } finally { if (request === generation.current) setBusy(false); }
  }
  useEffect(() => { void load(); return () => { generation.current++; }; }, [owner]);
  async function act(action: () => Promise<void>) {
    const request = ++generation.current;
    setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (e) { if (request === generation.current) setError((e as Error).message); }
    finally { if (request === generation.current) setBusy(false); }
  }
  async function show(object: Summary) {
    setPreview(undefined);
    const request = generation.current;
    const result = data(await desktop.fallback(owner, "hetu.extensions.objects.export", {
      object_id: object.object_id, revision: object.revision, format: "markdown",
    }));
    if (request !== generation.current) return;
    if (result.sha256 !== object.sha256) throw new Error("成果摘要不一致，请刷新后重新读取。");
    setPreview({ object, content: result.content });
  }
  async function handoff() {
    const request = generation.current;
    await requestAgent("fallback:" + owner, preview ? {
      object_id: preview.object.object_id, revision: preview.object.revision, sha256: preview.object.sha256,
    } : {});
    if (request === generation.current) setNotice(desktop.agentSessionHost ? "已放入Codex会话草稿，请核对后发送。" : "已复制插件成果的协作请求。");
  }
  return <section className="plugin-results" aria-label="插件成果">
    <div className="surface-heading"><h1>{title}成果</h1><div className="actions">
      <button onClick={back}>返回创作插件</button>
      <IconButton icon="refresh" label="刷新插件成果" disabled={busy} onClick={() => void load()}/>
      <button disabled={busy || !enabled} onClick={() => void act(handoff)}>让 AI 处理</button>
    </div></div>
    {!enabled && <p className="muted">插件未启用，仍可读取和导出成果。启用兼容插件后可交给 AI 接续。</p>}
    <form className="plugin-results-search" onSubmit={event => { event.preventDefault(); void load(); }}>
      <input aria-label="搜索插件成果" placeholder="搜索成果标题" maxLength={120} value={query}
        onChange={event => { invalidate(); setQuery(event.target.value); }}/>
      <button disabled={busy} type="submit">搜索</button>
      {query && <button type="button" onClick={() => { invalidate(); setQuery(""); void load(false, ""); }}>清除搜索</button>}
    </form>
    {busy && <p role="status">正在读取插件成果…</p>}
    {error && <div role="alert"><p>{error}</p><button disabled={busy} onClick={() => void load()}>重新读取成果</button></div>}
    {!busy && !error && items === undefined && <p className="muted">输入标题后搜索，或刷新读取全部成果。</p>}
    {items?.length === 0 && <p className="muted">{query ? "没有匹配的成果。" : "还没有保存的插件成果。"}</p>}
    {!!items?.length && <div aria-label="插件成果列表">{items.map(object => <div className="row" key={object.object_id}>
      <div><strong>{object.title}</strong><p className="muted">第{object.revision}版</p></div>
      <button disabled={busy} onClick={() => void act(() => show(object))}>查看导出</button>
    </div>)}</div>}
    {cursor && <button disabled={busy} onClick={() => void load(true)}>继续读取成果</button>}
    {preview && <section aria-label="固定插件成果导出">
      <div className="row"><h2>{preview.object.title} 第{preview.object.revision}版</h2>
        <button disabled={busy} onClick={() => void act(async () => {
          const request = generation.current;
          await desktop.copy(preview.content);
          if (request === generation.current) setNotice("已复制此版本的导出内容。");
        })}>复制导出内容</button></div>
      <pre className="plugin-result-content">{preview.content}</pre>
    </section>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
