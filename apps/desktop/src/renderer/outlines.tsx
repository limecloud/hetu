import React, { useEffect, useRef, useState } from "react";
import type { SurfaceContext } from "./contributions.tsx";
import { desktop } from "./bridge.ts";
import { Icon, PageActions } from "./workbench.tsx";
import "./surface-pages.css";

export function Outlines({ work, ai, notify }: SurfaceContext) {
  const [snapshot, setSnapshot] = useState<any>(), [items, setItems] = useState<any[]>([]), [editing, setEditing] = useState(false),
    [error, setError] = useState(""), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const expected = useRef<any>(), writes = useRef<Promise<unknown>>(Promise.resolve()), active = useRef(true);
  useEffect(() => () => { active.current = false; void desktop.dirty(false); }, []);
  useEffect(() => {
    let current = true; setSnapshot(undefined); setError("");
    desktop.outlines("get").then(value => {
      if (!current) return; setSnapshot(value);
      expected.current = value.draft?.expected ?? { revision: value.outline.revision, sha256: value.outline.sha256 };
      setItems(value.draft?.items ?? value.outline.items); setEditing(!!value.draft); void desktop.dirty(!!value.draft);
    }).catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [work, reload]);
  function change(next: any[]) {
    setItems(next); setEditing(true); void desktop.dirty(true);
    writes.current = desktop.outlines("draft", { value: { expected: expected.current, items: next } }).catch(e => { if (active.current) setError(e.message); });
  }
  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await writes.current; await fn(); }
    catch (e) { if (active.current) setError((e as Error).message); }
    finally { if (active.current) { setBusy(false); const value = await desktop.outlines("get").catch(() => null); if (value) setSnapshot(value); } }
  }
  const novel = snapshot?.novel?.novel;
  const targets = [{ value: "book:", title: "整书" }, ...(novel?.volumes ?? []).map((r: any) => ({ value: "volume:" + r.volume_id, title: "卷 " + r.title })), ...(novel?.chapters ?? []).map((r: any) => ({ value: "chapter:" + r.document_id, title: "章 " + r.title }))];
  return <section className="surface-page" aria-label="作品大纲">
    <PageActions><button onClick={() => ai()}><Icon name="sparkles"/>让 AI 整理大纲</button></PageActions>
    {error && <p role="alert">{error}</p>}
    {!snapshot && !error && <p role="status">正在读取大纲…</p>}
    {snapshot?.journal?.status === "pending" && <p>前次大纲保存结果尚未确认。<button disabled={busy} onClick={() => run(async () => { await desktop.outlines("recover"); await desktop.dirty(false); setEditing(false); setReload(n => n + 1); })}>恢复原操作</button></p>}
    {snapshot && <>
      {editing && snapshot.outline.revision !== expected.current?.revision && <section aria-label="大纲版本冲突">
        <p>已保存大纲已有更新。本次编辑已保留，请比较后决定。</p>
        <details><summary>查看当前保存的大纲</summary>{snapshot.outline.items.map((item: any) => <article key={item.id}><h3>{item.title}</h3><p style={{ whiteSpace: "pre-wrap" }}>{item.text}</p></article>)}</details>
        <button disabled={busy} onClick={() => { expected.current = { revision: snapshot.outline.revision, sha256: snapshot.outline.sha256 }; change(items); }}>以当前大纲为基线继续编辑</button>
      </section>}
      {!items.length && <p>还没有大纲。可以让 AI 准备，也可以自行填写。</p>}
      <fieldset disabled={busy || snapshot.journal?.status === "pending"} className="baseline-editor-fields">
      {items.map((item, index) => <article key={item.id} className="outline-entry">
        {editing ? <>
          <label>标题<input aria-label={`大纲标题 ${index + 1}`} value={item.title} onChange={e => change(items.map((r, i) => i === index ? { ...r, title: e.target.value } : r))}/></label>
          <label>所属位置<select aria-label={`大纲位置 ${index + 1}`} value={item.level + ":" + (item.target_id ?? "")} onChange={e => { const [level, target] = e.target.value.split(":"); change(items.map((r, i) => i === index ? { ...r, level, target_id: target || null } : r)); }}>{targets.map(target => <option key={target.value} value={target.value}>{target.title}</option>)}</select></label>
          <textarea aria-label={`大纲内容 ${index + 1}`} value={item.text} onChange={e => change(items.map((r, i) => i === index ? { ...r, text: e.target.value } : r))}/>
          <button disabled={busy} onClick={() => change(items.filter((_, i) => i !== index))}>移除此项</button>
        </> : <><h3>{item.title}</h3><small>{targets.find(target => target.value === item.level + ":" + (item.target_id ?? ""))?.title}</small><p style={{ whiteSpace: "pre-wrap" }}>{item.text}</p></>}
      </article>)}
      </fieldset>
      <div className="surface-filters">
        <button disabled={busy} onClick={() => change([...items, { id: "outline_" + crypto.randomUUID(), title: "大纲", level: "book", target_id: null, text: "" }])}>新增大纲</button>
        {!editing && !!items.length && <button onClick={() => setEditing(true)}>编辑大纲</button>}
        {editing && <><button disabled={busy || snapshot.journal?.status === "pending"} onClick={() => run(async () => { await desktop.outlines("save", { expected: expected.current, items }); await desktop.dirty(false); setEditing(false); setReload(n => n + 1); notify("大纲已保存。"); })}>保存大纲</button><button disabled={busy} onClick={() => run(async () => { await desktop.outlines("draft", { value: null }); await desktop.dirty(false); setEditing(false); setReload(n => n + 1); })}>放弃本次编辑</button></>}
      </div>
    </>}
  </section>;
}
