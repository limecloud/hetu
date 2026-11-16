import React, { useEffect, useState } from "react";
import { desktop, data } from "./bridge.ts";
import type { SurfaceContext } from "./contributions.tsx";
import { Icon, IconButton, PageActions } from "./workbench.tsx";
import "./surface-pages.css";
const relations: Record<string, string> = {
  adaptation: "改编依据",
  production: "制作依据",
  reference: "创作参考",
};

export function WorkLinks({ work, notify, ai }: SurfaceContext) {
  const [links, setLinks] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(),
    [archived, setArchived] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function list() {
    const items: any[] = [];
    let cursor: string | undefined;
    do {
      const page = data(
        await desktop.read("hetu.work_links.list", {
          work_ref: work,
          include_archived: archived,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      );
      items.push(...page.links);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    setLinks(items);
  }
  async function load(id: string, revision?: number) {
    setSelected(
      data(
        await desktop.read("hetu.work_links.get", {
          work_ref: work,
          link_id: id,
          ...(revision ? { revision } : {}),
        }),
      ),
    );
  }
  useEffect(() => {
    setSelected(undefined);
    void run(list);
  }, [work, archived]);
  const fixed =
      selected?.link[
        selected.direction === "incoming" ? "source_ref" : "target_ref"
      ],
    record = selected?.related_work?.record;
  return (
    <section className="work-links surface-page" aria-label="关联作品依据">
      <PageActions>
        <IconButton icon="refresh" label="刷新关联作品" disabled={busy} onClick={() => void run(async () => {
          await list();
          if (selected) await load(selected.link.link_id, selected.link.revision);
        })}/>
        <button disabled={busy} onClick={() => ai(selected ? { link_id: selected.link.link_id, link_revision: selected.link.revision } : {})}>
          <Icon name="sparkles"/>{selected ? "让 AI 处理此关联" : "让 AI 整理作品关联"}
        </button>
      </PageActions>
      {!selected && <div className="surface-filters">
        <label>
          <input
            type="checkbox"
            checked={archived}
            disabled={busy}
            onChange={(e) => setArchived(e.target.checked)}
          />{" "}
          包含已解除的关联
        </label>
      </div>}
      {busy && <p>正在核对作品关联…</p>}
      {error && <p role="alert">{error}</p>}
      {selected ? (
        <>
          <button className="surface-back" onClick={() => setSelected(undefined)}><Icon name="back"/>返回关联列表</button>
          <h2>{selected.related_title ?? "关联作品"}</h2>
          <p>
            {relations[selected.link.relation] ?? selected.link.relation}{" "}
            {selected.direction === "incoming"
              ? "当前作品使用的依据"
              : "使用当前作品的创作"}
            {selected.link.archived ? " 此关联已解除" : ""}
          </p>
          <p>
            固定作品资料第 {fixed.revision_ref.revision} 版 关联第{" "}
            {selected.link.revision} 版
          </p>
          {selected.related_has_newer_revision === true && (
            <p>关联作品资料已有新版，当前依据继续保留。</p>
          )}
          {selected.related_current_archived === true && (
            <p>关联作品当前已归档，历史依据继续保留。</p>
          )}
          {selected.related_status === "unavailable" && (
            <p role="alert">
              关联资料暂时无法核验：
              {selected.related_error?.message ?? "请保留当前依据后重试。"}
            </p>
          )}
          {selected.related_status === "requires_authorization" && (
            <p>读取另一端作品资料需要它的精确授权。</p>
          )}
          {record && (
            <article className="manuscript" aria-label="固定关联作品资料">
              <h3>{record.metadata?.title ?? record.title}</h3>
              <p>
                {record.metadata?.synopsis ??
                  record.description ??
                  record.brief ??
                  "没有作品说明"}
              </p>
              {record.metadata?.author_name && (
                <p>作者：{record.metadata.author_name}</p>
              )}
            </article>
          )}
          <details>
            <summary>关联历史与版本</summary>
            <label>
              读取关联修订{" "}
              <select
                aria-label="关联历史修订"
                disabled={busy}
                value={selected.link.revision}
                onChange={(e) =>
                  void run(() =>
                    load(selected.link.link_id, Number(e.target.value)),
                  )
                }
              >
                {Array.from(
                  {
                    length: Math.min(selected.current_link_ref.revision, 1000),
                  },
                  (_, i) => selected.current_link_ref.revision - i,
                ).map((revision) => (
                  <option key={revision} value={revision}>
                    第 {revision} 版
                  </option>
                ))}
              </select>
            </label>
            <p>
              固定资料摘要：<code>{fixed.sha256}</code>
            </p>
          </details>
        </>
      ) : (
        <>
          {links.map((item) => (
            <div className="row work-link-row" key={item.link.link_id}>
              <Icon name="link" size={20}/><div>
                <strong>{item.related_title ?? "关联作品"}</strong>
                <p>
                  {relations[item.link.relation] ?? item.link.relation}
                  {item.link.archived ? " 已解除" : ""}
                  {item.related_has_newer_revision === true
                    ? " 资料已有新版"
                    : ""}
                  {item.related_status === "unavailable"
                    ? " 资料无法核验"
                    : ""}
                </p>
              </div>
              <button
                disabled={busy}
                onClick={() => void run(() => load(item.link.link_id))}
              >
                查看固定依据
              </button>
            </div>
          ))}
          {!busy && !error && !links.length && (
            <div className="surface-empty"><Icon name="link" size={20}/><p>当前作品没有关联依据</p></div>
          )}
        </>
      )}
    </section>
  );
}
