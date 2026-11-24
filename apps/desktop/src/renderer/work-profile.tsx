import React, { useEffect, useRef, useState } from "react";
import type { SurfaceContext } from "./contributions.tsx";
import { readWorkContent } from "./work-content.ts";
import { WorkCover } from "./work-cover.tsx";
import { Icon, IconButton, PageActions, Workbench } from "./workbench.tsx";
import { CoverWorkbench } from "./covers.tsx";
import { NovelEditor } from "./novel-editors.tsx";
import { WorkAgent } from "./work-agent.tsx";
const status: Record<string, string> = {
  planning: "筹备中",
  writing: "创作中",
  completed: "已完成",
  archived: "已归档",
};

export function WorkProfile({ work, ai, notify, openContent, plugins, openPlugin }: SurfaceContext) {
  const { agentStatus } = React.useContext(Workbench);
  const [value, setValue] =
      useState<Awaited<ReturnType<typeof readWorkContent>>>(),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""), [coverOpen, setCoverOpen] = useState(false), [coverTab, setCoverTab] = useState<"candidates" | "local" | "history">("candidates"), [editing, setEditing] = useState<"metadata" | "structure">(), [agentOpen, setAgentOpen] = useState(false);
  const held = busy || agentStatus.state === 'running';
  const generation = useRef(0);
  async function load() {
    const epoch = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const next = await readWorkContent(work, {includeDocuments: false});
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
    setAgentOpen(false);
    void load();
    return () => { generation.current++; };
  }, [work.workspace_id, work.kind, work.object_id]);
  const metadata = work.kind === "novel" ? value?.record.metadata : undefined;
  const contentLabel = work.kind === "novel" ? "打开章节" : work.kind === "drama" ? "打开分集" : "打开视频成果";
  function openCover(tab: "candidates" | "local" | "history") {
    setCoverTab(tab); setCoverOpen(true);
  }
  const date = (value: string | undefined) => value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未记录";
  return (
    <section className="work-profile" aria-label="当前作品资料">
      <PageActions>
        <IconButton icon="refresh" label="刷新作品资料" disabled={held} onClick={() => void load()}/>
        <button disabled={held} onClick={() => ai()}><Icon name="sparkles"/>让 AI 完善资料</button>
        {work.kind === "novel" && <button className="primary" disabled={held || !value} onClick={() => setEditing("metadata")}>编辑资料</button>}
      </PageActions>
      {busy && <p role="status">正在读取作品资料…</p>}
      {agentStatus.state === 'running' && <p role="status" className="notice">正在处理，暂时无法编辑资料。</p>}
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
              {metadata.author_name && <div>
              <dt>作者</dt>
              <dd>{metadata.author_name}</dd>
              </div>}{metadata.genre && <div>
              <dt>题材</dt>
              <dd>{metadata.genre}</dd>
              </div>}<div>
              <dt>状态</dt>
              <dd>{status[metadata.status] ?? metadata.status}</dd>
              </div><div>
              <dt>{work.kind === "novel" ? "卷章" : work.kind === "drama" ? "分集" : "成果"}</dt>
              <dd><span>{value.record.volumes.length} 卷 {value.record.chapters.length} 章</span>{openContent && <button type="button" className="profile-directory-link" aria-label={work.kind === "novel" ? "打开章节目录" : work.kind === "drama" ? "打开分集目录" : "打开视频成果"} onClick={openContent}><Icon name="list" size={14}/>{contentLabel}</button>}{metadata && <button type="button" className="profile-directory-link profile-structure-edit" onClick={() => setEditing("structure")}>整理卷章</button>}</dd>
              </div>
            </dl>
            </div></div>
          ) : (
            <p className="manuscript">
              {value.record.description ??
                value.record.brief ??
                "暂无简介"}
            </p>
          )}
          {metadata && <section className="profile-synopsis"><h3>简介</h3><p>{metadata.synopsis || "暂无简介"}</p></section>}
          <div className="profile-details">
          <details className="profile-collaboration" open={agentOpen} onToggle={event => setAgentOpen(event.currentTarget.open)}>
            <summary>协作设置</summary>
            {agentOpen && <WorkAgent key={`${work.workspace_id}/${work.kind}/${work.object_id}`} work={work} notify={notify}/>}
          </details>
          <details className="profile-version">
            <summary>版本信息</summary>
            <dl className="work-metadata profile-timestamps">
              <dt>创建时间</dt><dd>{date(value.summary.created_at)}</dd>
              <dt>作品更新时间</dt><dd>{date(value.summary.updated_at)}</dd>
              <dt>资料更新时间</dt><dd>{date(value.record.updated_at)}</dd>
              <dt>资料修订</dt><dd>{value.summary.fixed_ref.revision_ref.revision}</dd>
              {metadata && <><dt>语言</dt><dd>{metadata.language_tag}</dd></>}
            </dl>
            <code>{value.summary.fixed_ref.sha256}</code>
          </details>
          {!!plugins?.length && <details className="profile-plugins">
            <summary>相关创作插件（{plugins.length}）</summary>
            <p className="profile-plugin-hint">需要专业工作时再打开对应插件，入口会随当前作品类型筛选。</p>
            <div className="profile-plugin-list">{plugins.map(view => <button key={view.key} type="button" onClick={() => openPlugin?.(view)}><Icon name="plugin" size={14}/>{view.title}<Icon name="chevron" size={12}/></button>)}</div>
          </details>}
          </div>
        </>
      )}
      {coverOpen && value && <CoverWorkbench work={work} ai={ai} notify={notify} title={value.summary.title} author={metadata?.author_name ?? ""} initialTab={coverTab} onClose={() => setCoverOpen(false)}/>}
      {editing && value && <NovelEditor key={editing} kind={editing} documents={value.documents} onClose={() => setEditing(undefined)} onSaved={() => { void load(); notify("已保存作品修改。"); }}/ >}
      {!busy && !value && (
        <button onClick={() => ai()}>让 AI 检查当前作品</button>
      )}
    </section>
  );
}
