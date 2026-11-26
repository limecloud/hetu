import React, { useEffect, useState } from "react";
import { desktop } from "./bridge.ts";
import { viewStorage } from "./view-storage.ts";
import "./storage-settings.css";

type Item = { id: string; category: string; name: string; path: string; bytes: number; modified_at: number };
// 分类名称先构成页面；文件大小、候选与可清理范围仍由Core统计。
const categories = [
  ["cache", "界面缓存"], ["collaboration", "协作资料与任务"], ["other", "设置与其他资料"],
  ["plugins", "插件与扩展"], ["runtimes", "运行环境"], ["sessions", "会话记录"], ["works", "本机创作资料"],
];
const bytes = (value: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"]; let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${Number(value.toFixed(index ? 1 : 0))} ${units[index]}`;
};
const requestKey = "hetu-storage-prepare";
function StorageValue({ value, loading, label, count = false }: { value?: number; loading: boolean; label: string; count?: boolean }) {
  return loading ? <span className="storage-number-loading" role="status" aria-label={`正在计算${label}`}>…</span>
    : value === undefined ? <span aria-label={`${label}尚未取得`}>—</span> : <>{count ? `${value} 项` : bytes(value)}</>;
}
export function StoragePlan({ plan }: { plan: any }) {
  return <><p>已选择 {plan.fixed.storage.items.length} 项，共 {bytes(plan.fixed.storage.bytes)}。</p>
    <ul className="storage-review-list">{plan.fixed.storage.items.map((item: Item) => <li key={item.id}><span>{item.name}<small>{item.path}</small></span><span>{bytes(item.bytes)}</span></li>)}</ul></>;
}
export function StorageSettings({ notify }: { notify: (message: string) => void }) {
  const [data, setData] = useState<any>(), [busy, setBusy] = useState(true), [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [category, setCategory] = useState("overview"), [search, setSearch] = useState(""), [age, setAge] = useState(0), [sort, setSort] = useState("size");
  const [selected, setSelected] = useState<Set<string>>(new Set()), [plan, setPlan] = useState<any>();
  async function run(action: () => Promise<unknown>) { setBusy(true); setError(""); try { await action(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }
  async function inspect() {
    setScanning(true);
    try { const next = await desktop.settings("storage_inspect"); setData(next); setSelected(new Set()); return next; }
    finally { setScanning(false); }
  }
  async function fixedPrepare(input: any) {
    const next = await desktop.settings("storage_prepare", input);
    if (next.preparation_failure) { viewStorage.setItem(requestKey, ""); throw new Error(next.preparation_failure.message); }
    return next;
  }
  useEffect(() => { void run(async () => {
    const pending = viewStorage.getItem(requestKey);
    if (pending) { const next = await fixedPrepare(JSON.parse(pending)); setPlan(next); viewStorage.setItem(requestKey, ""); }
    else {
      let cursor: string | undefined;
      do {
        const page = await desktop.settings("list", cursor ? { cursor } : {});
        const prior = page.operations.find((value: any) => value.fixed.kind === "storage_cleanup" && value.fixed.client_adapter === "generic" && ["pending", "approved", "executing"].includes(value.state));
        if (prior) { setPlan(prior); break; }
        cursor = page.next_cursor;
      } while (cursor);
    }
    await inspect();
  }); }, []);
  const items: Item[] = (data?.candidates ?? []).filter((item: Item) => (category === "all" || item.category === category)
    && (item.name + " " + item.path).toLocaleLowerCase().includes(search.toLocaleLowerCase())
    && (!age || item.modified_at < Date.now() / 1000 - age * 86400)).sort((a: Item, b: Item) => sort === "name" ? a.name.localeCompare(b.name, "zh-CN") : sort === "time" ? b.modified_at - a.modified_at : b.bytes - a.bytes);
  const selectedItems: Item[] = (data?.candidates ?? []).filter((item: Item) => selected.has(item.id));
  const allSelected = !!items.length && items.every(item => selected.has(item.id));
  const loading = scanning || !data && busy;
  const groups = categories.map(([id, name]) => data?.categories.find((group: any) => group.id === id)
    ?? { id, name, bytes: data && !data.partial ? 0 : undefined, cleanable_bytes: 0 });
  const value = (amount: number | undefined, label: string, count = false) => <StorageValue value={amount} loading={loading} label={label} count={count}/>;
  async function prepare(ids = [...selected], snapshot = data.storage_snapshot) {
    const pending = viewStorage.getItem(requestKey);
    const input = pending ? JSON.parse(pending) : { selected_ids: ids.sort(), storage_snapshot: snapshot, operation_key: crypto.randomUUID() };
    viewStorage.setItem(requestKey, JSON.stringify(input));
    const next = await fixedPrepare(input); setPlan(next); viewStorage.setItem(requestKey, "");
    return next;
  }
  async function execute(fixed = plan) {
    const result = await desktop.settings("storage_execute", { operation_id: fixed.operation_id });
    if (result.cancelled) return;
    setPlan(result); notify(`已清理 ${bytes(result.result.deleted_bytes)}，${result.result.retained_count} 项保留。`); await inspect();
  }
  async function cleanAll() {
    const current = await inspect();
    if (!current.candidates.length) { notify("当前没有可清理项目。"); return; }
    const fixed = await prepare(current.candidates.map((item: Item) => item.id), current.storage_snapshot);
    await execute(fixed);
  }
  return <section className="storage-settings" aria-label="存储空间明细" aria-busy={busy}>
    <div className="storage-actions"><button disabled={busy} onClick={() => void run(inspect)}>重新统计</button></div>
    {error && <p role="alert">{error}<button disabled={busy} onClick={() => void run(inspect)}>重试统计</button></p>}
      {category === "overview" && !plan && <>
      <div className="storage-summary"><div><span>{data?.partial ? "已统计占用" : "资料占用"}</span><strong>{value(data?.total_bytes, "资料占用")}</strong></div><div><span>可清理</span><strong>{value(data?.cleanable_bytes, "可清理空间")}</strong></div></div>
      <div className="storage-clean-all"><span>缓存与已移除会话，共 {value(data?.candidates.length, "可清理项目数量", true)}</span><button className="primary" disabled={busy || !data?.candidates.length} onClick={() => void run(cleanAll)}>一键清理</button></div>
      <div className="storage-meter" data-loading={loading} aria-hidden="true">{!loading && data?.categories.map((group: any) => <span key={group.id} data-category={group.id} style={{ flexGrow: group.bytes }}/>)}</div>
      <p className="settings-note">{data?.scope ?? "本机河图资料目录；外部作品目录未计入"}。显示文件大小，实际磁盘回收空间可能不同。</p>
      <div className="storage-categories" aria-label="存储分类"><button onClick={() => setCategory("all")}><span>全部可清理项目</span><span>{value(data?.cleanable_bytes, "全部可清理项目大小")}</span></button>{groups.map((group: any) => <button key={group.id} onClick={() => setCategory(group.id)}><span>{group.name}<small>{loading && ["cache", "sessions"].includes(group.id) ? "可清理项目" : group.cleanable_bytes ? `可清理 ${bytes(group.cleanable_bytes)}` : "保留资料"}</small></span><span>{value(group.bytes, group.name + "占用")}</span></button>)}</div>
      <p className="settings-note">缓存可重新生成。已移除会话清理后无法恢复；作品、素材、草稿、授权和插件保留。</p>
      {data?.issues.length > 0 && <details className="storage-issues"><summary>{data.issues.length} 项未纳入清理</summary><ul>{data.issues.map((issue: any, index: number) => <li key={index}>{issue.path && <code>{issue.path}：</code>}{issue.reason}</li>)}</ul></details>}
      </>}
      {!plan && category !== "overview" && <>
        <div className="storage-detail-heading"><button onClick={() => setCategory("overview")}>返回存储概览</button><h3>{category === "all" ? "全部可清理项目" : groups.find((group: any) => group.id === category)?.name}</h3><span>{value(category === "all" ? data?.cleanable_bytes : groups.find((group: any) => group.id === category)?.bytes, "分类占用")}</span></div>
        <div className="storage-filters"><input type="search" aria-label="搜索清理项目" placeholder="搜索名称或位置" value={search} onChange={event => setSearch(event.target.value)}/><select aria-label="清理时间筛选" value={age} onChange={event => setAge(Number(event.target.value))}><option value={0}>全部时间</option><option value={7}>7 天以前</option><option value={30}>30 天以前</option><option value={90}>90 天以前</option></select><select aria-label="清理项目排序" value={sort} onChange={event => setSort(event.target.value)}><option value="size">大小从大到小</option><option value="time">最近修改优先</option><option value="name">按名称</option></select></div>
        {loading ? <p role="status">正在读取清理项目…</p> : !data ? <p role="status">尚未取得清理项目，请重试统计。</p> : items.length ? <><label className="storage-select-all"><input type="checkbox" checked={allSelected} disabled={busy} onChange={() => setSelected(prior => { const next = new Set(prior); for (const item of items) allSelected ? next.delete(item.id) : next.add(item.id); return next; })}/>选择当前列表的 {items.length} 项</label><ul className="storage-items">{items.map(item => <li key={item.id}><label><input type="checkbox" checked={selected.has(item.id)} disabled={busy} onChange={() => setSelected(prior => {const next = new Set(prior); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next;})}/><span>{item.name}<small>{item.path}</small><small>{new Date(item.modified_at * 1000).toLocaleString("zh-CN")}</small></span><span>{bytes(item.bytes)}</span></label></li>)}</ul></> : <p role="status">{category !== "all" && !["cache", "sessions"].includes(category) ? "此分类仅统计占用，资料继续保留。" : "没有符合条件的可清理项目。"}</p>}
        <div className="storage-footer"><span>已选 {selectedItems.length} 项，共 {bytes(selectedItems.reduce((total, item) => total + item.bytes, 0))}</span><button className="primary" disabled={busy || !selectedItems.length} onClick={() => void run(prepare)}>查看清理清单</button></div>
      </>}
    {plan && <section className="storage-plan" aria-label="清理确认清单"><h3>{plan.state === "executed" ? "清理结果" : "核对清理清单"}</h3><StoragePlan plan={plan}/>
      {plan.state === "executed" ? <><p role="status">已清理 {bytes(plan.result.deleted_bytes)}，共 {plan.result.deleted_count} 项；保留 {plan.result.retained_count} 项，原文件已不存在 {plan.result.absent_count} 项。</p>{plan.file_results.filter((value: any) => value.status === "retained").map((value: any) => <p key={value.id}>{value.name}：{value.reason}</p>)}<button disabled={busy} onClick={() => setPlan(undefined)}>完成</button></> : <><p>永久清理所选项目，已移除会话记录无法恢复。</p><div className="storage-actions"><button className="primary" disabled={busy || plan.state === "rejected"} onClick={() => void run(execute)}>{plan.state === "executing" ? "恢复原清理操作" : "确认清理…"}</button><button disabled={busy || plan.state === "executing"} onClick={() => void run(async () => {
        // 不删除文件；拒绝原方案，避免下次重新打开又恢复已放弃的清单。
        await desktop.settings("storage_cancel", { operation_id: plan.operation_id }); setPlan(undefined);
      })}>返回选择</button></div></>}
    </section>}
  </section>;
}
