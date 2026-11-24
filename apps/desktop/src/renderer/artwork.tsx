import React, { useEffect, useRef, useState } from "react";
import { desktop, data, requestAgent } from "./bridge.ts";
import type { SurfaceContext } from "./contributions.tsx";
import { domainText } from "./strings.ts";
import { Icon, IconButton, PageActions } from "./workbench.tsx";
import { ArtworkDetail } from "./artwork-detail.tsx";
import { artworkKey, artworkMatches, artworkPreview, mergeArtwork, readArtworkPage, type Artwork, type ArtworkSubject } from "./artwork-model.ts";
import { useObjectContextMenu } from "./text-context-menus.tsx";
import "./artwork.css";

const categories = ["all", "cover", "character", "scene", "prop", "illustration", "costume", "other"];

/** 图片库只投影 Core 的固定任务成果；没有任意路径或第二份素材事实。 */
export function ArtworkLibrary({ work, notify, subject, embedded = false, filterCategory, onUseCover }: SurfaceContext & { subject?: ArtworkSubject; embedded?: boolean; filterCategory?: string; onUseCover?: (item: Artwork) => void }) {
  const context = useObjectContextMenu(notify);
  const [items, setItems] = useState<Artwork[]>([]),
    [detail, setDetail] = useState<{ item: Artwork; group: Artwork[] }>(),
    [category, setCategory] = useState("all"),
    [query, setQuery] = useState(""),
    [loading, setLoading] = useState(true),
    [errors, setErrors] = useState<string[]>([]),
    [cursor, setCursor] = useState<string>();
  const generation = useRef(0);
  async function load(more = false) {
    const epoch = ++generation.current;
    setLoading(true);
    setErrors([]);
    try {
      const page = await readArtworkPage(async (method, input) => method === "list"
        ? data(await desktop.tasks("list", undefined, input))
        : data((await desktop.tasks("call", input, { name: "hetu_open_task_view", arguments: { task_ref: input } })).structuredContent),
      more ? cursor : undefined, () => epoch === generation.current);
      if (!page) return;
      setItems(previous => mergeArtwork(more || page.errors.length ? previous : [], page.items));
      setCursor(page.cursor);
      setErrors(page.errors);
    } catch (error) {
      if (epoch === generation.current) setErrors([(error as Error).message]);
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    setItems([]); setDetail(undefined); setCategory("all"); setQuery(""); setCursor(undefined);
    void load();
    return () => { generation.current++; };
  }, [work]);
  const scoped = items.filter(item => artworkMatches(item, subject) && (!filterCategory || item.category === filterCategory));
  const visible = scoped.filter(item => (category === "all" || category === item.category)
    && (!query.trim() || item.candidate.title?.normalize("NFKC").toLocaleLowerCase().includes(query.trim().normalize("NFKC").toLocaleLowerCase())));
  async function handoff(item?: Artwork) {
    try {
      const object = subject ? Object.fromEntries(Object.entries(subject).filter(([key]) => key !== "kind")) : {};
      await requestAgent("work.images", item ? {...object, task_ref: item.task.task_ref, submission_id: item.submission_id, candidate_id: item.candidate.candidate_id} : object);
      notify(desktop.agentSessionHost ? "已放入Codex会话草稿，请核对后发送。" : "已复制图片协作请求。");
    } catch (error) { notify((error as Error).message); }
  }
  const controls = <>
    <label className="artwork-search"><Icon name="search"/><input type="search" aria-label="搜索图片" placeholder="搜索图片" value={query} onChange={e => setQuery(e.target.value)}/></label>
    <IconButton icon="refresh" label="刷新图片" disabled={loading} onClick={() => void load()}/>
    {!!scoped.length && <button onClick={() => void handoff()}><Icon name="sparkles"/>让 AI 准备图片</button>}
  </>;
  return <section className={"artwork-library" + (subject || embedded ? " embedded-artwork" : "")} aria-label={subject ? "关联图片" : filterCategory === "cover" ? "封面候选" : "作品图片成果"} aria-busy={loading}>
    {subject || embedded ? <div className="artwork-embedded-heading"><h2>{filterCategory === "cover" ? "封面候选" : "关联图片"}</h2><div className="actions">{controls}</div></div> : <PageActions>{controls}</PageActions>}
    {!filterCategory && <div className="artwork-categories" role="tablist" aria-label="图片分类">
      {categories.map((kind, index) => <button type="button" role="tab" key={kind} aria-selected={category === kind} tabIndex={category === kind ? 0 : -1} onClick={() => setCategory(kind)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? (index + 1) % categories.length : event.key === "ArrowLeft" ? (index + categories.length - 1) % categories.length : event.key === "Home" ? 0 : event.key === "End" ? categories.length - 1 : undefined;
        if (next !== undefined) { event.preventDefault(); setCategory(categories[next]!); (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus(); }
      }}>{domainText(`artwork.category.${kind}`, kind)}</button>)}
    </div>}
    {!!errors.length && <div className="artwork-errors" role="alert"><p>部分图片未能读取。</p><details><summary>查看读取问题</summary>{errors.map((error, index) => <p key={index}>{error}</p>)}</details></div>}
    {loading && !items.length ? <div className="artwork-empty" role="status"><Icon name="image" size={20}/><p>正在读取图片…</p></div>
      : !visible.length ? <div className="artwork-empty" role="status"><Icon name="image" size={20}/><p>{errors.length ? "图片未能完整读取" : scoped.length ? "没有符合条件的图片" : "还没有图片成果"}</p>
        {scoped.length ? <button onClick={() => { setCategory("all"); setQuery(""); }}>清除筛选</button>
          : errors.length ? <button onClick={() => void load()}>重新读取</button> : <button onClick={() => void handoff()}><Icon name="sparkles"/>让 AI 准备图片</button>}
      </div> : <div className="artwork-results"><div className="artwork-grid">
        {visible.map(item => { const openDetail = () => setDetail({ item, group: items.filter(other => other.task.task_ref.task_id === item.task.task_ref.task_id && other.submission_id === item.submission_id) }); const card = <button {...context(item.candidate.title, [
          {id: "open", label: "打开图片", action: openDetail},
          {id: "copy-title", label: "复制名称", action: () => desktop.copy(item.candidate.title)},
          {id: "source", label: "图片来源与意见", action: openDetail},
          ...(onUseCover && item.category === "cover" ? [{id: "use-cover", label: "选用此封面", action: () => onUseCover(item)}] : []),
          {id: "ai", label: "让 AI 处理此图片", action: () => void handoff(item)},
        ])} className="artwork-item" key={artworkKey(item)} onClick={openDetail}>
          <span className="artwork-thumbnail">{artworkPreview(item.preview) ? <img loading="lazy" src={artworkPreview(item.preview)} alt={item.candidate.title}/> : <Icon name="image" size={24}/>}</span>
          <strong>{item.candidate.title}</strong><span className="artwork-caption"><span>{domainText(item.candidate.image_view ? `artwork.view.${item.candidate.image_view}` : `artwork.category.${item.category}`, item.category)}</span><span>{item.candidate.width} × {item.candidate.height}</span></span>
        </button>; return onUseCover && item.category === "cover" ? <div className="artwork-cover-cell" key={artworkKey(item)}>{card}<button onClick={() => onUseCover(item)}>选用此封面</button></div> : card; })}
      </div>{cursor && <div className="artwork-pagination"><button disabled={loading} onClick={() => void load(true)}>{loading ? "正在读取…" : "加载更多图片"}</button></div>}</div>}
    {!visible.length && cursor && !loading && <div className="artwork-pagination"><button onClick={() => void load(true)}>加载更多图片</button></div>}
    {detail && <ArtworkDetail item={detail.item} group={detail.group} notify={notify} onUseCover={onUseCover} onClose={() => setDetail(undefined)}/>}
  </section>;
}
