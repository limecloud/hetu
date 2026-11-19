import { Outlines } from "./outlines.tsx";
import { VideoReview as Video } from "./video-review.tsx";
import { verifyBaselineSurfaces } from "../../../../packages/plugin-sdk/src/baseline.ts";
import React, { useEffect, useRef, useState } from "react";
import {
  EffectScope,
  SlotRegistry,
} from "../../../../packages/plugin-host/src/registry.ts";
import type { WorkRef } from "@hetu/plugin-sdk";
import { desktop, data } from "./bridge.ts";
import { TaskReview } from "./task-review.tsx";
import { AgentConnection } from "./agent-connection.tsx";
import { Management } from "./management.tsx";
import { WorkProfile } from "./work-profile.tsx";
import { WorkLinks } from "./work-links.tsx";
import { ArtworkLibrary } from "./artwork.tsx";
import { ImagesWorkbench } from "./covers.tsx";
import { Resources } from "./resources.tsx";
import { MediaLibrary } from "./media.tsx";
import { Versions } from "./versions.tsx";
import { Documents } from "./documents.tsx";
import { Icon, IconButton, PageActions } from "./workbench.tsx";
import { domainText } from "./strings.ts";
import { canonKinds, entityName, expectedCanon } from "./canon-model.ts";
import { CanonEditor, CanonHistory, CanonLock, CanonRemoval } from "./canon-editors.tsx";
import { artworkMatches, artworkPreview, mergeArtwork, readArtworkPage, type Artwork } from "./artwork-model.ts";
import "./canon.css";
export interface SurfaceContext {
  work: WorkRef;
  notify: (message: string) => void;
  ai: (object?: Record<string, unknown>) => void;
}
export interface SurfaceContribution {
  id: string;
  title: string;
  kinds: WorkRef["kind"][];
  component: React.ComponentType<SurfaceContext>;
}
export const surfaces = new SlotRegistry<SurfaceContribution>();
const scope = new EffectScope();
type CanonEntry = { section: string; kind: string; id: string; label: string; value: any };
function SourceEvidence({ sources }: { sources?: any[] }) {
  if (!sources?.length) return null;
  return <div className="canon-sources">{sources.map((source, index) => <div key={index}>
    {source.quote && <blockquote>{source.quote}</blockquote>}
    <details><summary>原文依据 {index + 1}</summary><dl className="canon-fields">
      <dt>文稿</dt><dd><code>{source.document_id}</code></dd>
      <dt>修订</dt><dd><code>{source.revision_id}</code></dd>
      <dt>原文位置</dt><dd>{source.byte_start}–{source.byte_end} 字节</dd>
    </dl></details>
  </div>)}</div>;
}
function Canon({ work, notify, ai }: SurfaceContext) {
  const workKey = `${work.workspace_id}/${work.kind}/${work.object_id}`;
  const [snapshot, setCanon] = useState<{ workKey: string; value: any }>(),
    [kind, setKind] = useState("characters"),
    [query, setQuery] = useState(""),
    [selectedID, setSelectedID] = useState(""),
    [showArchived, setShowArchived] = useState(false),
    [showImages, setShowImages] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0), [editor, setEditor] = useState<{ entity?: any }>(),
    [history, setHistory] = useState(false), [locking, setLocking] = useState(false), [removal, setRemoval] = useState<CanonEntry>(),
    [images, setImages] = useState<Artwork[]>([]), [imageCursor, setImageCursor] = useState<string>(), [imageError, setImageError] = useState(""), [busy, setBusy] = useState(false);
  const detailDialog = useRef<HTMLDialogElement>(null), imageGeneration = useRef(0);
  useEffect(() => { if (selectedID) detailDialog.current?.showModal(); }, [selectedID]);
  async function loadImages(more = false) {
    const epoch = ++imageGeneration.current;
    try {
      const page = await readArtworkPage(async (method, input) => method === "list" ? data(await desktop.tasks("list", undefined, input)) : data((await desktop.tasks("call", input, { name: "hetu_open_task_view", arguments: { task_ref: input } })).structuredContent), more ? imageCursor : undefined, () => epoch === imageGeneration.current);
      if (!page) return;
      setImages(previous => mergeArtwork(more ? previous : [], page.items)); setImageCursor(page.cursor); setImageError(page.errors.length ? "部分设定图片未能读取" : "");
    } catch (e) { if (epoch === imageGeneration.current) setImageError((e as Error).message); }
  }
  useEffect(() => { setImages([]); void loadImages(); return () => { imageGeneration.current++; }; }, [workKey, reload]);
  useEffect(() => {
    let active = true;
    setCanon(undefined);
    setSelectedID("");
    setShowImages(false);
    setLoading(true);
    setError("");
    desktop.canon("get")
      .then((r) => {
        if (!active) return;
        const value = r;
        setCanon({ workKey, value });
      })
      .catch((e) => {
        if (active) { setError(e.message); notify(e.message); }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workKey, reload]);
  const canon = snapshot?.workKey === workKey ? snapshot.value : undefined;
  const blueprint = canon?.blueprint ?? canon;
  const entries: CanonEntry[] = canonKinds.flatMap((category) =>
    (Array.isArray(blueprint?.[category.section]) ? blueprint[category.section] : [])
      .filter((value: any) => value && typeof value === "object" && typeof value[category.id] === "string")
      .map((value: any) => ({ ...category, id: value[category.id], value })),
  );
  const category = canonKinds.find((value) => value.section === kind)!;
  const visible = entries.filter((entry) => entry.section === kind &&
    (showArchived || !entry.value.archived) &&
    [entityName(entry), entry.value.description, ...(entry.value.aliases ?? [])]
      .filter(Boolean).join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = visible.find((entry) => entry.id === selectedID);
  const entity = selected?.value;
  const name = (reference?: string) => entries.find((entry) => entry.id === reference)
    ? entityName(entries.find((entry) => entry.id === reference)!) : "所引设定不可用";
  const references = (values?: string[]) => (values ?? []).map(name).join("、");
  const revision = blueprint?.revision ?? canon?.revision;
  const entityAI = () => ai(selected ? { entity_ref: selected.id, blueprint_revision: revision } : undefined);
  const field = (label: string, value: React.ReactNode) => value === undefined || value === null || value === "" ? null :
    <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>;
  const factValue = (fact: any) => fact.predicate === "primary_faction" ? name(fact.value) :
    fact.predicate === "life_state" ? domainText("fact.life." + fact.value, fact.value) : String(fact.value ?? "");
  const locked = blueprint?.lock?.locked === true, held = busy || loading || canon?.journal?.status === "pending";
  const refresh = () => setReload(value => value + 1);
  async function change(entry: CanonEntry, remove = false) {
    setBusy(true); setError("");
    try {
      const input = { expected: expectedCanon(canon), typed_changes: [remove ? { type: "remove_entity", entity_ref: entry.id } : { type: "upsert_" + entry.kind, entity: { ...entry.value, archived: !entry.value.archived } }] };
      if (remove) { await desktop.canon("preview", input); setRemoval(entry); }
      else { await desktop.canon("save", input); await desktop.canon("acknowledge"); refresh(); }
    } catch (e) { setError((e as Error).message); try { setCanon({ workKey, value: await desktop.canon("get") }); } catch { /* 保留读取和原操作错误。 */ } }
    finally { setBusy(false); }
  }
  function entryActions(entry: CanonEntry) {
    return <div className="canon-entry-actions"><IconButton icon="sparkles" label={"让 AI 处理" + entityName(entry)} onClick={() => ai({ entity_ref: entry.id, blueprint_revision: revision })}/><span/>
      <button disabled={held || locked} onClick={() => setEditor({ entity: entry.value })}>编辑</button>
      <details className="popover-menu"><summary aria-label={entityName(entry) + "操作"}><Icon name="more"/></summary><div className="menu-panel">
        {["character", "faction", "location"].includes(entry.kind) && <button disabled={held || locked} onClick={() => void change(entry)}>{entry.value.archived ? "取消归档" : "归档"}</button>}
        <button className="danger" disabled={held || locked} onClick={() => void change(entry, true)}>移除</button>
      </div></details>
    </div>;
  }
  function primary(entry: CanonEntry) {
    return images.filter(image => image.category === (entry.kind === "character" ? "character" : "scene") && artworkMatches(image, { kind: "entity", entity_ref: entry.id }) && (entry.kind !== "character" || !image.candidate.image_view || ["portrait", "front"].includes(image.candidate.image_view)))
      .sort((a, b) => (["portrait", "front"].indexOf(a.candidate.image_view) < 0 ? 2 : ["portrait", "front"].indexOf(a.candidate.image_view)) - (["portrait", "front"].indexOf(b.candidate.image_view) < 0 ? 2 : ["portrait", "front"].indexOf(b.candidate.image_view)) || b.received_at.localeCompare(a.received_at))[0];
  }
  return <section className="canon-workbench" aria-label="作品设定">
    <PageActions>
      <IconButton icon="refresh" label="刷新作品设定" disabled={loading} onClick={() => setReload((value) => value + 1)}/>
      <button onClick={() => ai()}><Icon name="sparkles"/>让 AI 完善设定</button>
      {blueprint && <details className="popover-menu"><summary aria-label="更多设定操作"><Icon name="more"/></summary><div className="menu-panel"><button onClick={() => setHistory(true)}>设定历史</button><button disabled={held} onClick={() => setLocking(true)}>{locked ? "解锁设定" : "锁定设定"}</button><button disabled={held || locked} onClick={() => setEditor({})}>新增{category.label}</button></div></details>}
    </PageActions>
    <div className="canon-controls">
      <div className="canon-categories" role="tablist" aria-label="设定分类">
        {canonKinds.map((item, index) => <button key={item.section} role="tab" aria-selected={kind === item.section} tabIndex={kind === item.section ? 0 : -1}
          className={kind === item.section ? "selected" : ""} onClick={() => { setKind(item.section); setSelectedID(""); setShowImages(false); }} onKeyDown={event => {
            const next = event.key === "ArrowRight" ? (index + 1) % canonKinds.length : event.key === "ArrowLeft" ? (index + canonKinds.length - 1) % canonKinds.length : event.key === "Home" ? 0 : event.key === "End" ? canonKinds.length - 1 : -1;
            if (next >= 0) { event.preventDefault(); setKind(canonKinds[next].section); setSelectedID(""); setShowImages(false); (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus(); }
          }}>
          {item.label}
        </button>)}
      </div>
      <label className="canon-search"><Icon name="search"/><input aria-label="搜索设定" placeholder="搜索设定" value={query} onChange={(event) => setQuery(event.target.value)}/></label>
    </div>
    {blueprint && <div className="canon-status">
      <span>{blueprint.lock?.locked ? "设定已锁定" : "当前作品设定"}{revision ? ` 第${revision}版` : ""}</span>
      {["characters", "factions", "locations"].includes(kind) && <label><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)}/>显示已归档</label>}
    </div>}
    {loading && <p role="status">正在读取当前作品设定…</p>}
    {error && <p role="alert">{error}</p>}
    {canon?.journal?.status === "pending" && <div className="recover"><p>原设定操作尚未确认。</p><button disabled={busy} onClick={() => { setBusy(true); void desktop.canon("recover").then(() => desktop.canon("acknowledge")).then(refresh).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>恢复原设定操作</button></div>}
    {!loading && !error && !visible.length && <div className="canon-empty">
      <Icon name={query ? "search" : "layers"} size={20}/>
      <h2>{query ? "没有匹配的设定" : `还没有${category.label}设定`}</h2>
      {query ? <button onClick={() => setQuery("")}>清除搜索</button> : <button onClick={() => ai()}>让 AI 整理设定</button>}
    </div>}
    {!!visible.length && <div className="canon-results"><div className={["character", "location"].includes(category.kind) ? "canon-grid" : "canon-rows"} aria-label={category.label + "条目"}>{visible.map(entry => {
      const image = primary(entry), preview = artworkPreview(image?.preview);
      return <section key={entry.id} className={"canon-entity " + entry.kind}><button className="canon-entity-open" onClick={() => { setSelectedID(entry.id); setShowImages(false); }} aria-label={"查看" + entityName(entry)}>
        {["character", "location"].includes(entry.kind) && <span className="canon-entity-image">{preview ? <img src={preview} alt={entityName(entry)}/> : <Icon name={entry.kind === "character" ? "image" : "layers"} size={20}/>}</span>}
        <span className="canon-entity-text"><strong>{entityName(entry)}</strong>{entry.value.description && <span>{entry.value.description}</span>}{entry.value.archived && <small>已归档</small>}{entry.kind === "event" && entry.value.time_anchor && <small>{entry.value.time_anchor.calendar} {entry.value.time_anchor.tick}</small>}</span>
      </button>{entryActions(entry)}</section>;
    })}</div>{imageError && <p role="alert">{imageError}</p>}{imageCursor && <button disabled={held} onClick={() => void loadImages(true)}>加载更多图片</button>}</div>}
    {selected && <dialog ref={detailDialog} className="canon-detail-sheet" aria-label="设定详情" onClose={() => { setSelectedID(""); setShowImages(false); }}>
      <article className="canon-detail" aria-label="设定详情" key={selected.id}>
        <header className="canon-detail-heading"><div><h2>{entityName(selected)}</h2><p>{category.label}{entity.archived ? " 已归档" : ""}</p></div>
          <button onClick={entityAI}><Icon name="sparkles"/>让 AI 处理</button>
          <button disabled={held || locked} onClick={() => setEditor({ entity })}>编辑</button><IconButton icon="close" label="关闭设定详情" onClick={() => detailDialog.current?.close()}/>
        </header>
        {entity.description && <p className="canon-description">{entity.description}</p>}
        <dl className="canon-fields">
          {field("别名", entity.aliases?.join("、"))}
          {field("特征", entity.traits?.join("、"))}
          {selected.kind === "location" && <>{field("所属地点", entity.parent_ref ? name(entity.parent_ref) : "无")}{field("内外景", domainText("location." + entity.interior_exterior, "未标明"))}</>}
          {selected.kind === "event" && <>{field("历法", entity.time_anchor?.calendar)}{field("时间位置", entity.time_anchor?.tick)}{field(domainText("timeline.before", "前置关系"), references(entity.before_refs))}{field(domainText("timeline.after", "后置关系"), references(entity.after_refs))}</>}
          {selected.kind === "rule" && <>
            {field("规则类型", domainText("rule.type." + entity.type, entity.type))}
            {field("严重程度", domainText("rule.severity." + entity.severity, entity.severity))}
            {field("例外处理", domainText("rule.exception." + entity.exception_policy, entity.exception_policy))}
            {field("说明", entity.rationale)}
            {field("适用作品", entity.scope?.packages?.map((value: string) => domainText("package." + value, value)).join("、"))}
            {field("适用设定", references(entity.scope?.entity_refs))}
            {field("补充说明", entity.parameters?.text)}
            {field("禁止用语", entity.parameters?.terms?.join("、"))}
            {field("用语例外", entity.parameters?.exceptions?.join("、"))}
            {field("较早事件", entity.parameters?.before_event_id ? name(entity.parameters.before_event_id) : undefined)}
            {field("较晚事件", entity.parameters?.after_event_id ? name(entity.parameters.after_event_id) : undefined)}
            {field("地点限制", entity.parameters?.location_ref ? name(entity.parameters.location_ref) : undefined)}
            {field("禁止能力", entity.parameters?.forbidden_capability)}
          </>}
        </dl>
        {!!entity.facts?.length && <section className="canon-section"><h3>人物事实</h3><div className="canon-facts">{entity.facts.map((fact: any) => <div key={fact.fact_id}>
          <strong>{domainText("fact.predicate." + fact.predicate, fact.predicate)}</strong><p>{factValue(fact)}</p>
          <p className="canon-validity">从{name(fact.valid_from)}起{fact.valid_to ? `，至${name(fact.valid_to)}` : "，持续有效"}</p>
          <SourceEvidence sources={fact.source_refs}/>
        </div>)}</div></section>}
        {!!entity.relations?.length && <section className="canon-section"><h3>势力关系</h3><dl className="canon-fields">{entity.relations.map((relation: any, index: number) => <React.Fragment key={index}>
          <dt>{name(relation.target_ref)}</dt><dd>{domainText("faction.relation." + relation.type, relation.type)}</dd>
        </React.Fragment>)}</dl></section>}
        {!!entity.source_refs?.length && <section className="canon-section"><h3>来源依据</h3><SourceEvidence sources={entity.source_refs}/></section>}
        {["character", "location"].includes(selected.kind) && <section className="canon-section">
          <button onClick={() => setShowImages(!showImages)}>{showImages ? "收起关联图片" : "查看关联图片"}</button>
          {showImages && <div className="canon-images"><ArtworkLibrary work={work} notify={notify} ai={ai}
            subject={{ kind: "entity", entity_ref: selected.id, blueprint_revision: revision }}/></div>}
        </section>}
        <details className="canon-raw"><summary>完整设定数据</summary><pre>{JSON.stringify(entity, null, 2)}</pre></details>
      </article>
    </dialog>}
    {editor && canon && <CanonEditor snapshot={canon} category={category} entity={editor.entity} ai={ai} onClose={() => setEditor(undefined)} onSaved={refresh}/>}
    {history && canon && <CanonHistory snapshot={canon} ai={ai} onClose={() => setHistory(false)}/>}
    {locking && canon && <CanonLock snapshot={canon} onClose={() => setLocking(false)} onSaved={refresh}/>}
    {removal && canon && <CanonRemoval snapshot={canon} entry={removal} onClose={() => setRemoval(undefined)} onSaved={refresh}/>}
  </section>;
}

const baseContributions: SurfaceContribution[] = [
  {
    id: "novel.reader",
    title: "小说",
    kinds: ["novel"],
    component: Documents,
  },
  { id: "novel.outlines", title: "作品大纲", kinds: ["novel"], component: Outlines },
  {
    id: "drama.reader",
    title: "剧本",
    kinds: ["drama"],
    component: Documents,
  },
  { id: "video.review", title: "视频", kinds: ["video"], component: Video },
  {
    id: "work.tasks",
    title: "参考稿审核",
    kinds: ["novel", "drama", "video"],
    component: TaskReview,
  },
  {
    id: "work.profile",
    title: "作品资料",
    kinds: ["novel", "drama", "video"],
    component: WorkProfile,
  },
  {
    id: "work.links",
    title: "关联作品",
    kinds: ["novel", "drama", "video"],
    component: WorkLinks,
  },
  {
    id: "work.canon",
    title: "作品设定",
    kinds: ["novel", "drama", "video"],
    component: Canon,
  },
  {
    id: "work.images",
    title: "图片成果",
    kinds: ["novel", "drama", "video"],
    component: ImagesWorkbench,
  },
  {
    id: "work.resources",
    title: "资料与素材",
    kinds: ["novel", "drama", "video"],
    component: Resources,
  },
  {
    id: "work.media",
    title: "素材与线索",
    kinds: ["novel", "drama", "video"],
    component: MediaLibrary,
  },
  {
    id: "work.import",
    title: "原稿导入",
    kinds: ["novel", "drama"],
    component: (context: SurfaceContext) => <Management {...context} workflow="import" />,
  },
  {
    id: "work.delivery",
    title: "作品交付",
    kinds: ["novel", "drama"],
    component: (context: SurfaceContext) => <Management {...context} workflow="delivery" />,
  },
  { id: "work.versions", title: "文稿版本", kinds: ["novel", "drama"], component: Versions },
  {
    id: "work.agent",
    title: "Agent 协作",
    kinds: ["novel", "drama", "video"],
    component: AgentConnection,
  },
  {
    id: "work.management",
    title: "管理方案",
    kinds: ["novel", "drama", "video"],
    component: Management,
  },
];
verifyBaselineSurfaces(baseContributions);
for (const contribution of baseContributions)
  surfaces.register("org.hetu.authoring", contribution.id, contribution, scope);
