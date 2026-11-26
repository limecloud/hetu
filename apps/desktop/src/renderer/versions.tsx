import React, { useEffect, useState } from "react";
import { desktop, requestAgent } from "./bridge.ts";
import type { SurfaceContext } from "./contributions.tsx";
import { Icon, IconButton, PageActions, Workbench } from "./workbench.tsx";
import "./surface-pages.css";
import {ManuscriptReading, ManuscriptComparison} from "@hetu/workbench-ui";
import {usePreferences} from "./preferences.tsx";

export function Versions({ work, notify, ai }: SurfaceContext) {
  const preferences = usePreferences();
  const kind = work.kind === "drama" ? "screenplay" : "novel";
  const format = (path: string) => path.endsWith(".fountain") ? "fountain" : path.endsWith(".md") ? "markdown" : "plain";
  const { agentStatus } = React.useContext(Workbench);
  const [status, setStatus] = useState<any>(), [snapshots, setSnapshots] = useState<any[]>([]),
    [history, setHistory] = useState<any[]>([]), [snapshotCursor, setSnapshotCursor] = useState<string>(),
    [historyCursor, setHistoryCursor] = useState<string>(), [view, setView] = useState<any>(),
    [preview, setPreview] = useState<any>(), [version, setVersion] = useState<any>(),
    [historical, setHistorical] = useState<any>(), [diff, setDiff] = useState<any>(),
    [journal, setJournal] = useState<any>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function refresh() {
    const current = await desktop.versions("status"), recovery = await desktop.versions("journal");
    setStatus(current); setJournal(recovery);
    if (current.initialized) {
      const [prepared, commits] = await Promise.all([desktop.versions("snapshots"), desktop.versions("history")]);
      setSnapshots(prepared.snapshots); setSnapshotCursor(prepared.next_cursor ?? undefined);
      setHistory(commits.commits); setHistoryCursor(commits.next_cursor ?? undefined);
    }
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError((e as Error).message); notify((e as Error).message); }
    finally {
      setBusy(false);
      void desktop.versions("journal").then(setJournal).catch(() => setJournal(null));
    }
  }
  useEffect(() => { void run(refresh); }, [work]);
  async function open(id: string) {
    setPreview(undefined); setVersion(undefined); setHistorical(undefined); setDiff(undefined);
    setView(await desktop.versions("snapshot", { snapshot_id: id }));
  }
  return <section className="version-review surface-page" aria-label="文稿版本">
    <PageActions><IconButton icon="refresh" label="刷新版本" disabled={busy} onClick={() => void run(refresh)}/><button onClick={() => ai()}><Icon name="sparkles"/>让 AI 整理版本</button></PageActions>
    {error && <p role="alert">{error}</p>}
    {!status && !error && <p role="status">正在读取文稿版本…</p>}
    {status && !status.initialized && <div className="surface-empty"><Icon name="branch" size={20}/><p>尚未建立本地版本库</p><span>让 AI 准备初始化方案。</span></div>}
    {journal && <section aria-label="版本批准恢复"><h3>原版本批准</h3><p>{journal.status === "pending" ? "结果尚未确认，请沿原操作恢复。" : journal.status === "blocked" ? journal.error : "原批准已确认。"}</p>
      {journal.status === "pending" ? <button disabled={busy} onClick={() => void run(async () => { await desktop.versions("recover"); await refresh(); notify("原版本批准已核对；提交结果请查看已保存版本。"); })}>恢复原版本批准</button>
        : <button disabled={busy} onClick={() => void run(async () => { await desktop.versions("acknowledge", { operation_key: journal.input.operation_key }); await refresh(); })}>已阅批准结果</button>}
    </section>}
    {status?.initialized && <>
      <details><summary>当前文稿变更（{status.changes.length}）</summary>
        <p>这些是尚未纳入本作品版本的受管文稿文件。AI 可以准备其中一部分作为固定快照。</p>
        <ul>{status.changes.map((item: any) => <li key={item.path}><button disabled={busy} onClick={() => void run(async () => { setDiff(await desktop.versions("diff", { path: item.path })); })}>{item.path}</button></li>)}</ul>
        {diff && <section aria-label="当前文件差异"><ManuscriptComparison before={diff.before ?? ""} after={diff.after ?? ""} beforeLabel="已保存版本" afterLabel="当前文稿" format={format(diff.path ?? "")} kind={kind} preferences={preferences}/>{diff.truncated && <p role="alert">文件超出差异读取预算，当前显示不完整。</p>}</section>}
      </details>
      <section aria-label="已准备快照"><h3>已准备快照</h3>
        {!snapshots.length && <p>没有待审阅的文稿快照。向 AI 说明要保留哪个创作节点。</p>}
        <ul>{snapshots.map((item: any) => <li key={item.snapshot_id}><button disabled={busy} onClick={() => void run(() => open(item.snapshot_id))}>{item.message}</button><span> {item.file_count} 个文稿文件</span></li>)}</ul>
        {snapshotCursor && <button disabled={busy} onClick={() => void run(async () => { const page = await desktop.versions("snapshots", { cursor: snapshotCursor }); setSnapshots([...snapshots, ...page.snapshots]); setSnapshotCursor(page.next_cursor ?? undefined); })}>更多快照</button>}
      </section>
      {view && <section aria-label="固定文稿快照"><h3>{view.snapshot.message}</h3>
        <p>{view.approval_state === "executed" ? "已保存版本" : !view.is_current ? "文稿或版本头已变化，请让 AI 重新准备" : view.approval_state === "approved" ? "已批准，等待 Agent 执行" : "等待作者审阅"} 提交身份：{view.snapshot.author.name}</p>
        <details><summary>固定范围与提交身份</summary><p>{view.snapshot.author.email}</p><pre>{JSON.stringify(view.snapshot.selection, null, 2)}</pre></details>
        {view.is_current && view.approval_state !== "executed" && <button disabled={busy || journal?.status === "pending"} onClick={() => void run(async () => { setPreview(await desktop.versions("prepare", { snapshot_id: view.snapshot.snapshot_id, snapshot_sha256: view.snapshot_sha256 })); })}>审阅完整快照差异</button>}
        <button disabled={busy} onClick={() => void run(async () => { if(desktop.agentSessionHost) await requestAgent("work.versions",{snapshot_id:view.snapshot.snapshot_id});else await desktop.versions("continue", { snapshot_id: view.snapshot.snapshot_id, snapshot_sha256: view.snapshot_sha256 }); notify(desktop.agentSessionHost ? "已放入当前会话草稿，请核对后发送。" : "已复制固定版本的接续提示词。"); })}>让 AI 接续此版本</button>
        {preview && <section aria-label="版本批准预览"><h3>批准前核对</h3>
          {preview.diffs.map((item: any) => <details key={item.path} open><summary>{item.path}</summary><ManuscriptComparison before={item.before ?? ""} after={item.after ?? ""} beforeLabel="已保存版本" afterLabel="本次文稿" format={format(item.path)} kind={kind} preferences={preferences}/></details>)}
          <button disabled={busy || journal?.status === "pending"} onClick={() => void run(async () => { await desktop.versions("commit", { token: preview.token }); setPreview(undefined); await open(view.snapshot.snapshot_id); await refresh(); notify("已批准此文稿版本，由 Agent 执行提交。"); })}>确认批准此快照</button>
          <button disabled={busy} onClick={() => setPreview(undefined)}>关闭预览</button>
        </section>}
      </section>}
      <section aria-label="文稿版本历史"><h3>已保存版本</h3>
        {!history.length && <p>还没有文稿提交。</p>}
        <ul>{history.map((item: any) => <li key={item.commit_id}><button disabled={busy} onClick={() => void run(async () => { setVersion(await desktop.versions("version", { commit_id: item.commit_id })); setHistorical(undefined); setView(undefined); setPreview(undefined); })}>{item.message}</button></li>)}</ul>
        {historyCursor && <button disabled={busy} onClick={() => void run(async () => { const page = await desktop.versions("history", { cursor: historyCursor }); setHistory([...history, ...page.commits]); setHistoryCursor(page.next_cursor ?? undefined); })}>更多版本</button>}
        {version && <section aria-label="固定历史文稿"><h3>{version.message}</h3><p>历史只读。需要接续此稿时，让 AI 准备参考稿，再比较采纳。</p><button onClick={() => ai({ git_commit_id: version.commit_id, ...(historical ? { git_path: historical.path } : {}) })}>让 AI 接续此历史稿</button>
          <ul>{version.files?.filter((item: any) => /\.(md|fountain)$/.test(item.path)).map((item: any, i: number) => <li key={item.path}><button disabled={busy} onClick={() => void run(async () => { setHistorical(await desktop.versions("version", { commit_id: version.commit_id, path: item.path })); })}>{item.title} 文稿 {i + 1}</button></li>)}</ul>
          {historical && <article aria-label="历史正文">{historical.content.length > 128 * 1024
            ? <pre className="version-history-plain">{historical.content}</pre>
            : <ManuscriptReading text={historical.content} label="历史正文" format={format(historical.path)} kind={kind} preferences={preferences}/>}
            {historical.next_offset_bytes != null && <button disabled={busy} onClick={() => void run(async () => {
              const page = await desktop.versions("version", { commit_id: historical.commit_id, path: historical.path, offset_bytes: historical.next_offset_bytes, max_bytes: 262144 });
              if (page.sha256 !== historical.sha256 || page.commit_id !== historical.commit_id || page.path !== historical.path || page.offset_bytes !== historical.next_offset_bytes) throw new Error("历史文稿分页依据不一致，请重新读取。");
              setHistorical({ ...page, content: historical.content + page.content });
            })}>继续阅读历史正文</button>}
            <details><summary>固定版本引用</summary><code>{historical.commit_id}</code><p>{historical.path}</p><code>{historical.sha256}</code></details></article>}
        </section>}
      </section>
    </>}
  </section>;
}
