import React, { useEffect, useRef, useState } from "react";
import type { SurfaceContext } from "./contributions.tsx";
import { desktop, data } from "./bridge.ts";
import { MediaPreview } from "./media-preview.tsx";
import { Icon, IconButton, PageActions } from "./workbench.tsx";
import "./surface-pages.css";

const rights: Record<string, string> = {
  author_owned: "作者所有",
  licensed: "已获许可",
  reference_only: "仅供参考",
  unknown: "权利待确认",
};
type Collection = "assets" | "cues";

/** 素材元数据与线索共用固定修订阅读；不从记录中的路径加载任意文件。 */
export function MediaLibrary({ work, ai }: SurfaceContext) {
  const [collection, setCollection] = useState<Collection>("assets"),
    [kind, setKind] = useState(""),
    [archived, setArchived] = useState(false),
    [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<string>(),
    [cursor, setCursor] = useState<string>(),
    [reload, setReload] = useState(0),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [view, setView] = useState<any>();
  const generation = useRef(0);
  const selected = useRef<{ type: Collection; id: string; revision: number }>();
  useEffect(() => {
    selected.current = undefined;
    setView(undefined);
  }, [work, collection]);
  useEffect(() => {
    const ticket = ++generation.current;
    setBusy(false);
    setLoading(true);
    setError("");
    desktop
      .read(`hetu.${collection}.list`, {
        work_ref: work,
        limit: 50,
        ...(kind ? { kind } : {}),
        ...(cursor ? { cursor } : {}),
        ...(collection === "cues" ? { include_archived: archived } : {}),
      })
      .then(data)
      .then(async (page) => {
        if (generation.current !== ticket) return;
        setItems(page[collection]);
        setNext(page.next_cursor ?? undefined);
        const fixed = selected.current;
        if (fixed) {
          const result = data(
            await desktop.read(`hetu.${fixed.type}.get`, {
              [fixed.type === "assets" ? "asset_id" : "cue_id"]: fixed.id,
              revision: fixed.revision,
            }),
          );
          if (generation.current === ticket)
            setView({ type: fixed.type, ...result });
        }
      })
      .catch((e) => {
        if (generation.current === ticket) {
          setItems([]);
          setView(undefined);
          setError(e.message);
        }
      })
      .finally(() => {
        if (generation.current === ticket) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [work, collection, kind, archived, cursor, reload]);

  async function open(type: Collection, id: string, revision: number) {
    const ticket = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = data(
        await desktop.read(`hetu.${type}.get`, {
          [type === "assets" ? "asset_id" : "cue_id"]: id,
          revision,
        }),
      );
      if (ticket === generation.current) {
        selected.current = { type, id, revision };
        setView({ type, ...result });
      }
    } catch (e) {
      if (ticket === generation.current) {
        selected.current = undefined;
        setView(undefined);
        setError((e as Error).message);
      }
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }
  const record = view?.[view.type === "assets" ? "asset" : "cue"],
    id = record?.[view.type === "assets" ? "asset_id" : "cue_id"];
  function fixed() {
    return record
      ? {
          [view.type === "assets" ? "asset_id" : "cue_id"]: id,
          revision: record.revision,
        }
      : {};
  }
  return (
    <section className="media-library surface-page" aria-label="素材与线索">
      <PageActions>
        <IconButton icon="refresh" label="刷新素材列表" disabled={loading || busy} onClick={() => { setCursor(undefined); setReload((n) => n + 1); }}/>
        <button onClick={() => ai(fixed())}><Icon name="sparkles"/>让 AI 整理素材</button>
      </PageActions>
      <div className="surface-filters" role="group" aria-label="素材筛选">
        <div className="surface-segments" role="group" aria-label="素材内容">
        <button
          aria-pressed={collection === "assets"}
          onClick={() => {
            setCollection("assets");
            setCursor(undefined);
          }}
        >
          素材文件
        </button>
        <button
          aria-pressed={collection === "cues"}
          onClick={() => {
            setCollection("cues");
            setCursor(undefined);
          }}
        >
          创作线索
        </button>
        </div>
        <label>
          素材类型{" "}
          <select
            aria-label="素材类型"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setCursor(undefined);
            }}
          >
            <option value="">全部类型</option>
            <option value="visual">图片与视频</option>
            <option value="music">声音与配乐</option>
          </select>
        </label>
        {collection === "cues" && (
          <label>
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => {
                setArchived(e.target.checked);
                setCursor(undefined);
              }}
            />
            包含归档线索
          </label>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p role="status">正在读取素材……</p>
      ) : (
        <div className="document-layout">
          <nav className="documents" aria-label="素材列表">
            {items.length === 0 && (
              <p className="muted">还没有这类素材。</p>
            )}
            {items.map((item) => {
              const itemId =
                item[collection === "assets" ? "asset_id" : "cue_id"];
              return (
                <button
                  key={itemId}
                  disabled={busy}
                  aria-pressed={id === itemId && view?.type === collection}
                  onClick={() => void open(collection, itemId, item.revision)}
                >
                  <strong>{item.title}</strong>
                  <small>
                    {collection === "assets"
                      ? rights[item.rights_status]
                      : item.archived
                        ? "已归档"
                        : "创作线索"}
                  </small>
                </button>
              );
            })}
            {cursor && (
              <button onClick={() => setCursor(undefined)}>返回首页</button>
            )}
            {next && (
              <button onClick={() => setCursor(next)}>下一页素材</button>
            )}
          </nav>
          <article aria-label="素材详情" aria-busy={busy}>
            {busy && <p role="status">正在核对固定素材……</p>}
            {!record && !busy && <div className="surface-selection-empty"><Icon name="image" size={20}/><p>选择素材或线索</p></div>}
            {record && (
              <>
                <h2>{record.title}</h2>
                <p>
                  第 {record.revision} 版{!view.is_head && " 历史版本"}
                </p>
                {view.type === "assets" ? (
                  <>
                    <MediaPreview key={id + ":" + record.revision} asset={record} sha256={view.sha256} />
                    <dl>
                      <dt>文件</dt>
                      <dd>{record.original_filename}</dd>
                      <dt>类型与大小</dt>
                      <dd>
                        {record.blob.media_type}{" "}
                        {record.blob.size_bytes.toLocaleString()} 字节
                      </dd>
                      <dt>本版权利</dt>
                      <dd>{rights[record.rights_status]}</dd>
                      <dt>当前权利</dt>
                      <dd>{rights[view.current_rights_status]}</dd>
                      <dt>再分发</dt>
                      <dd>
                        {view.delivery_eligible
                          ? "当前记录符合再分发声明"
                          : "交付前需核对用途与权利"}
                      </dd>
                    </dl>
                    <h3>来源说明</h3>
                    <p className="resource-body">
                      {record.source.creator_statement || "未填写来源说明"}
                    </p>
                    {record.source.source_uri && (
                      <p className="media-source">{record.source.source_uri}</p>
                    )}
                    <h3>权利声明</h3>
                    <p className="resource-body">
                      {record.rights_statement || "尚无再分发声明"}
                    </p>
                  </>
                ) : (
                  <>
                    {record.archived && <p>此线索已归档。</p>}
                    <p className="resource-body">{record.description}</p>
                    {view.stale_sources.length > 0 && (
                      <p role="status">正文已有新版；以下引用仍指向原修订。</p>
                    )}
                    <h3>正文依据</h3>
                    {record.narrative_refs.length === 0 && (
                      <p>此线索没有正文引用。</p>
                    )}
                    {record.narrative_refs.map((source: any, i: number) => (
                      <blockquote key={i}>{source.quote}</blockquote>
                    ))}
                    <h3>固定素材</h3>
                    {view.assets.length === 0 && <p>此线索没有关联素材。</p>}
                    {view.assets.map((asset: any) => (
                      <p key={asset.reference.asset_id}>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void open(
                              "assets",
                              asset.reference.asset_id,
                              asset.reference.revision,
                            )
                          }
                        >
                          {asset.title}
                        </button>
                        {asset.metadata_stale && " 素材资料已有新版"}
                      </p>
                    ))}
                  </>
                )}
                <div className="row">
                  <button
                    disabled={busy || record.revision <= 1}
                    onClick={() =>
                      void open(view.type, id, record.revision - 1)
                    }
                  >
                    前一版素材
                  </button>
                  <button
                    disabled={busy || record.revision >= view.current_revision}
                    onClick={() =>
                      void open(view.type, id, record.revision + 1)
                    }
                  >
                    后一版素材
                  </button>
                  {!view.is_head && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void open(view.type, id, view.current_revision)
                      }
                    >
                      查看当前素材
                    </button>
                  )}
                  <button onClick={() => ai(fixed())}>让 AI 处理此版本</button>
                </div>
                <details>
                  <summary>固定版本信息</summary>
                  <p className="media-source">
                    {id}
                    <br />
                    {view.sha256}
                  </p>
                </details>
              </>
            )}
          </article>
        </div>
      )}
    </section>
  );
}
