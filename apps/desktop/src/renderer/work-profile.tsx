import React, { useEffect, useRef, useState } from "react";
import type { SurfaceContext } from "./contributions.tsx";
import { readWorkContent } from "./work-content.ts";
import { WorkCover } from "./work-cover.tsx";
import { Icon, IconButton, PageActions, Workbench } from "./workbench.tsx";
import { ArtworkLibrary } from "./artwork.tsx";
import { CoverWorkbench } from "./covers.tsx";
import type { Artwork } from "./artwork-model.ts";
import { NovelEditor } from "./novel-editors.tsx";
import { WorkAgent } from "./work-agent.tsx";
const status: Record<string, string> = {
  planning: "筹备中",
  writing: "创作中",
  completed: "已完成",
  archived: "已归档",
};

export function WorkProfile({ work, ai, notify }: SurfaceContext) {
  const { agentStatus } = React.useContext(Workbench);
  const [value, setValue] =
      useState<Awaited<ReturnType<typeof readWorkContent>>>(),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""), [coverOpen, setCoverOpen] = useState(false), [coverCandidate, setCoverCandidate] = useState<Artwork>(), [coverTab, setCoverTab] = useState<"candidates" | "local" | "history">("candidates"), [editing, setEditing] = useState<"metadata" | "structure">();
  const held = busy || agentStatus.state === 'running';
  const generation = useRef(0);
  async function load() {
    const epoch = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const next = await readWorkContent(work);
      if (epoch === generation.current) setValue(next);
    } catch (e) {
      if (epoch === generation.current) setError((e as Error).message);
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setValue(undefined);
    setCoverOpen(false);
    setEditing(undefined);
    void load();
    return () => { generation.current++; };
  }, [work.workspace_id, work.kind, work.object_id]);
  const metadata = work.kind === "novel" ? value?.record.metadata : undefined;
  function openCover(tab: "candidates" | "local" | "history", candidate?: Artwork) {
    setCoverCandidate(candidate); setCoverTab(tab); setCoverOpen(true);
  }
  const date = (value: string | undefined) => value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未记录";
  return (
    <section className="work-profile" aria-label="当前作品资料">
      <PageActions>
        <IconButton icon="refresh" label="刷新作品资料" disabled={held} onClick={() => void load()}/>
        <button disabled={held} onClick={() => ai()}><Icon name="sparkles"/>让 AI 完善作品资料</button>
        {work.kind === "novel" && <button className="primary" disabled={held || !value} onClick={() => setEditing("metadata")}>编辑资料</button>}
      </PageActions>
      {busy && <p role="status">正在读取作品资料…</p>}
      {agentStatus.state === 'running' && <p role="status" className="notice">AI 正在执行编排任务，作品资料已自动锁定。</p>}
      {error && <p role="alert">{error}</p>}
      {value && (
        <>
          {!metadata && <h2>{value.summary.title}</h2>}
          {metadata ? (
            <div className="profile-overview">
            <div className="profile-cover">
              <WorkCover work={work} title={value.summary.title} author={metadata.author_name}/>
              <div className="actions profile-cover-actions">
                <button onClick={() => openCover("candidates")}>更换封面</button>
                <details className="popover-menu"><summary className="icon-button" aria-label="更多封面操作" title="更多封面操作"><Icon name="more"/></summary><div className="menu-panel">
                  <button onClick={() => openCover("local")}>本地导入</button>
                  <button onClick={() => openCover("history")}>封面历史</button>
                </div></details>
              </div>
            </div>
            <div className="profile-properties">
            <h2>{value.summary.title}</h2>
            <dl className="work-metadata profile-facts">
              <div>
              <dt>作者</dt>
              <dd>{metadata.author_name || "未填写"}</dd>
              </div><div>
              <dt>题材</dt>
              <dd>{metadata.genre || "未填写"}</dd>
              </div><div>
              <dt>创作状态</dt>
              <dd>{status[metadata.status] ?? metadata.status}</dd>
              </div><div>
              <dt>语言</dt>
              <dd>{metadata.language_tag}</dd>
              </div><div>
              <dt>创作结构</dt>
              <dd>{value.record.volumes.length} 卷、{value.record.chapters.length} 章</dd>
              </div>
            </dl>
            <dl className="work-metadata profile-timestamps">
              <dt>创建时间</dt><dd>{date(value.summary.created_at)}</dd>
              <dt>更新时间</dt><dd>{date(value.summary.updated_at)}</dd>
              <dt>资料更新时间</dt><dd>{date(value.record.updated_at)}</dd>
              <dt>资料修订</dt><dd>{value.summary.fixed_ref.revision_ref.revision}</dd>
            </dl>
            </div></div>
          ) : (
            <p className="manuscript">
              {value.record.description ??
                value.record.brief ??
                "尚未准备作品说明"}
            </p>
          )}
          {metadata && <section className="profile-synopsis"><h3>简介</h3><p>{metadata.synopsis || "尚未准备简介"}</p></section>}
          {metadata && <div className="profile-cover-candidates"><ArtworkLibrary work={work} notify={notify} ai={ai} embedded filterCategory="cover" onUseCover={item => openCover("candidates", item)}/></div>}
          <WorkAgent key={`${work.workspace_id}/${work.kind}/${work.object_id}`} work={work} notify={notify}/>
          <section aria-label="作品创作结构">
            <details className="profile-structure"><summary>查看{work.kind === "novel" ? "卷章" : "分集"}结构</summary>
            {metadata && <button onClick={() => setEditing("structure")}>人工整理卷章</button>}
            {value.groups.map((group) => (
              <section key={group.title}>
                <h4>{group.title}</h4>
                <ol>
                  {group.documents.map((document) => (
                    <li key={document.document_id}>{document.title}</li>
                  ))}
                </ol>
              </section>
            ))}
            {work.kind === "video" &&
              value.project.episodes.map((item: any) => (
                <div className="row" key={item.episode.video_episode_id}>
                  <strong>
                    第{item.episode_number}集 {item.episode.title}
                  </strong>
                  <p>{item.episode.brief}</p>
                </div>
              ))}
            {!value.groups.length && !value.project?.episodes?.length && (
              <p>当前还没有卷章或分集，请让 Agent 准备固定结构方案。</p>
            )}
            </details>
          </section>
          <details>
            <summary>固定作品资料版本</summary>
            <p>资料修订 {value.summary.fixed_ref.revision_ref.revision}</p>
            <code>{value.summary.fixed_ref.sha256}</code>
          </details>
        </>
      )}
      {coverOpen && value && <CoverWorkbench work={work} ai={ai} notify={notify} title={value.summary.title} author={metadata?.author_name ?? ""} initial={coverCandidate} initialTab={coverTab} onClose={() => setCoverOpen(false)}/>}
      {editing && value && <NovelEditor key={editing} kind={editing} documents={value.documents} onClose={() => setEditing(undefined)} onSaved={() => { void load(); notify("已保存作品修改。"); }}/ >}
      {!busy && !value && (
        <button onClick={() => ai()}>让 AI 检查当前作品</button>
      )}
    </section>
  );
}
