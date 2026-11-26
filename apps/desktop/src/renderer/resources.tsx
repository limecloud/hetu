import React, { useEffect, useRef, useState } from "react";
import { desktop, data, requestAgent } from "./bridge.ts";
import type { SurfaceContext } from "./contributions.tsx";
import { Icon, IconButton, PageActions } from "./workbench.tsx";
import "./surface-pages.css";
import {ResourceBody} from "./resource-reading.tsx";
import {useObjectContextMenu} from "./text-context-menus.tsx";
import {manuscriptVisibleText} from "@hetu/workbench-ui/manuscript-format";
import {resourceCategories as categories} from "./resource-source.ts";

const states: Record<string, string> = {
  draft: "草稿",
  adopted: "已采用",
  archived: "已归档",
};

export function Resources({ work, notify }: SurfaceContext) {
  const context = useObjectContextMenu(notify);
  const [items, setItems] = useState<any[]>([]),
    [cursor, setCursor] = useState<string>(),
    [recoveries, setRecoveries] = useState<any[]>([]),
    [category, setCategory] = useState(""),
    [state, setState] = useState(""),
    [tag, setTag] = useState(""),
    [view, setView] = useState<any>(),
    [usages, setUsages] = useState<any[]>([]),
    [usageCursor, setUsageCursor] = useState<string>(),
    [entities, setEntities] = useState<{ name: string; revision: number }[]>(
      [],
    ),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [listError, setListError] = useState(""),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<any>(),
    [edits, setEdits] = useState<any>();
  const epoch = useRef(0),
    selectedEpoch = useRef(0);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function load(next?: string) {
    const token = ++epoch.current;
    setLoading(true);
    setListError("");
    try {
      const result = data(await desktop.resources("list", { category, state, tag, cursor: next }));
      if (token !== epoch.current) return;
      setItems(result.resources);
      setRecoveries(result.recoveries ?? []);
      setCursor(result.next_cursor ?? undefined);
    } catch (error) {
      if (token === epoch.current) setListError((error as Error).message);
    } finally {
      if (token === epoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      epoch.current++;
      selectedEpoch.current++;
    };
  }, [work, category, state]);
  async function open(id: string, revision?: number) {
    if (edits) throw new Error("请先保存或取消当前资料编辑。");
    const token = ++selectedEpoch.current;
    const result = await desktop.resources("get", {
      resource_id: id,
      revision,
    });
    const positions = data(
      await desktop.resources("usages", { resource_id: id }),
    );
    const linked = await Promise.all(
      result.resource.entity_refs.map(async (ref: any) => {
        const fixed = data(
          await desktop.read("hetu.blueprints.get", {
            work_ref: ref.work_ref,
            revision: ref.blueprint_revision,
            sha256: ref.blueprint_sha256,
          }),
        );
        if (fixed.blueprint.blueprint_id !== ref.blueprint_id)
          throw new Error("资料的固定设定身份不一致。");
        const [collection, field] = (
          {
            character: ["characters", "character_id"],
            location: ["locations", "location_id"],
            faction: ["factions", "faction_id"],
            event: ["timeline", "event_id"],
            world: ["world", "entry_id"],
          } as Record<string, string[]>
        )[ref.kind];
        const entity = fixed.blueprint[collection].find(
          (entity: any) => entity[field] === ref.entity_id,
        );
        if (!entity) throw new Error("资料的固定设定条目不存在。");
        return {
          name: entity.name ?? entity.title,
          revision: ref.blueprint_revision,
        };
      }),
    );
    if (token !== selectedEpoch.current) return;
    setView(result);
    setEntities(linked);
    setUsages(positions.usages);
    setUsageCursor(positions.next_cursor ?? undefined);
    setPreview(undefined);
    return result;
  }
  async function ai() {
    await requestAgent(
      "work.resources",
      view
        ? {
            resource_id: view.resource.resource_id,
            revision: view.resource.revision,
          }
        : {},
    );
    notify(desktop.agentSessionHost ? "已放入当前会话草稿，请核对后发送。" : "已复制资料整理请求，可向外部 Agent 说明要补充或调整的内容。");
  }
  async function prepare(kind: string, fixed = view, changes = edits) {
    setPreview(
      await desktop.resources("prepare", {
        resource_id: fixed.resource.resource_id,
        revision: fixed.resource.revision,
        sha256: fixed.sha256,
        kind,
        ...(changes ? { edits: changes } : {}),
      }),
    );
  }
  async function change(next: any, fixed = view) {
    setEdits(next);
    await desktop.dirty(true);
    await desktop.resources("draft", {
      resource_id: fixed.resource.resource_id,
      value: {
        base: { revision: fixed.resource.revision, sha256: fixed.sha256 },
        edits: next,
      },
    });
  }
  async function refresh() {
    const next = await desktop.resources("get", {
      resource_id: view.resource.resource_id,
    });
    setView(next);
    setPreview(undefined);
    await load();
  }
  async function commit() {
    let result;
    try {
      result = await desktop.resources("commit", { token: preview.token });
    } finally {
      // 即使传输中断，也回读持久记录；人工恢复稿保留到明确成功。
      setEdits(undefined);
      await desktop.dirty(false);
      await refresh();
    }
    data(result);
    if (preview.action === "hetu.resources.update") {
      await desktop.resources("draft", {
        resource_id: resource.resource_id,
        value: null,
      });
      setView((value: any) => ({ ...value, buffer: null }));
    }
    notify("资料决定已保存并回读。");
  }
  const resource = view?.resource;
  const itemContext = (item: any) => context(item.title, [
    {id: "open", label: "打开", disabled: busy || !!edits, action: () => run(async () => {await open(item.resource_id, item.revision);})},
    {id: "edit", label: "编辑", disabled: busy || !!edits || item.state === "archived", action: () => run(async () => {
      const fixed = await open(item.resource_id, item.revision); if (!fixed?.is_head || fixed.journal) throw new Error("请先确认当前资料版本与原操作。");
      await change({title: fixed.resource.title, body: fixed.resource.body, source_notes: fixed.resource.source_notes}, fixed);
    })},
    {id: "copy-title", label: "复制名称", action: () => desktop.copy(item.title)},
    {id: "copy-as", label: "复制为", children: [
      {id: "plain", label: "纯文本", action: async () => {const fixed = await desktop.resources("get", {resource_id: item.resource_id, revision: item.revision}); await desktop.copy(manuscriptVisibleText(fixed.resource.body));}},
      {id: "source", label: "完整原稿", action: async () => {const fixed = await desktop.resources("get", {resource_id: item.resource_id, revision: item.revision}); await desktop.copy(fixed.resource.body);}},
    ]},
    {id: "review", separator: true},
    {id: "adopt", label: "采用此版资料", disabled: busy || !!edits || item.state !== "draft", action: () => run(async () => {const fixed = await open(item.resource_id, item.revision); if (fixed) await prepare("adopt", fixed, undefined);})},
    {id: "archive", label: "归档此版资料", disabled: busy || !!edits || item.state === "archived", action: () => run(async () => {const fixed = await open(item.resource_id, item.revision); if (fixed) await prepare("archive", fixed, undefined);})},
    {id: "ai", label: "让 AI 整理此资料", action: () => requestAgent("work.resources", {resource_id: item.resource_id, revision: item.revision})},
  ]);
  return (
    <section className="resources surface-page" aria-label="作品资料与素材">
      <PageActions>
        <IconButton icon="refresh" label="筛选与刷新资料" disabled={busy || loading} onClick={() => void load()}/>
        <button disabled={busy} onClick={() => void run(ai)}>
          <Icon name="sparkles"/>
          让 AI 整理资料
        </button>
      </PageActions>
      <div className="surface-filters" role="group" aria-label="资料筛选">
        <label>
          资料分类{" "}
          <select
            aria-label="资料分类"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">全部分类</option>
            {Object.entries(categories).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          资料状态{" "}
          <select
            aria-label="资料状态"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="">草稿与已采用</option>
            {Object.entries(states).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          资料标签{" "}
          <input
            aria-label="资料标签"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          />
        </label>
        <button disabled={busy || loading} onClick={() => void load()}>应用标签</button>
      </div>
      {(busy || loading) && <p role="status">正在核对资料版本…</p>}
      {listError && <p role="alert">{listError}</p>}
      {error && <p role="alert">{error}</p>}
      {recoveries.length > 0 && (
        <section aria-label="待核对的资料操作">
          {recoveries.map((entry) => (
            <button
              key={entry.resource_id}
              disabled={busy}
              onClick={() => void run(() => open(entry.resource_id))}
            >
              核对保留操作：{entry.title}
            </button>
          ))}
        </section>
      )}
      <div className="document-layout">
        <nav className="documents" aria-label="资料目录">
          {items.map((item) => (
            <button
              key={item.resource_id}
              {...itemContext(item)}
              aria-pressed={resource?.resource_id === item.resource_id}
              onClick={() => void run(() => open(item.resource_id))}
            >
              <strong>{item.title}</strong>
              <span>
                {categories[item.category]} {states[item.state]}
              </span>
            </button>
          ))}
          {!busy && !loading && !items.length && !error && !listError && (
            <p>当前筛选没有资料。可让 AI 根据作品整理。</p>
          )}
          {cursor && (
            <button
              disabled={busy || loading}
              onClick={() => void load(cursor)}
            >
              下一批资料
            </button>
          )}
        </nav>
        <section aria-label="固定资料详情">
          {resource ? (
            <>
              <h2>{resource.title}</h2>
              <p>
                {categories[resource.category]} {states[resource.state]} 第{" "}
                {resource.revision} 版{view.is_head ? "" : "（历史修订）"}
              </p>
              <p>{resource.tags.join("、") || "无标签"}</p>
              {entities.length > 0 && (
                <p>
                  关联设定：
                  {entities
                    .map(
                      (entity) =>
                        `${entity.name}（第 ${entity.revision} 版设定）`,
                    )
                    .join("、")}
                </p>
              )}
              {edits ? (
                <div className="resource-edit" aria-label="资料人工编辑">
                  <label>
                    资料名称{" "}
                    <input
                      aria-label="资料名称"
                      value={edits.title}
                      onChange={(e) =>
                        void change({ ...edits, title: e.target.value }).catch(
                          (e) => setError(e.message),
                        )
                      }
                    />
                  </label>
                  <label>
                    资料正文{" "}
                    <textarea
                      aria-label="资料正文"
                      value={edits.body}
                      onChange={(e) =>
                        void change({ ...edits, body: e.target.value }).catch(
                          (e) => setError(e.message),
                        )
                      }
                    />
                  </label>
                  <label>
                    资料来源{" "}
                    <textarea
                      aria-label="资料来源"
                      value={edits.source_notes}
                      onChange={(e) =>
                        void change({
                          ...edits,
                          source_notes: e.target.value,
                        }).catch((e) => setError(e.message))
                      }
                    />
                  </label>
                  <button
                    disabled={busy}
                    onClick={() => void run(() => prepare("update"))}
                  >
                    预览资料修改
                  </button>
                  <button
                    onClick={() =>
                      void run(async () => {
                        setEdits(undefined);
                        setPreview(undefined);
                        await desktop.dirty(false);
                        await desktop.resources("draft", {
                          resource_id: resource.resource_id,
                          value: null,
                        });
                        await refresh();
                      })
                    }
                  >
                    取消资料编辑
                  </button>
                </div>
              ) : (
                <>
                  <div className="resource-body" aria-label="资料全文">
                    <ResourceBody text={resource.body || "此资料没有正文。"} title={resource.title}/>
                  </div>
                  <h3>来源说明</h3>
                  <p className="resource-body">
                    {resource.source_notes || "未填写来源说明"}
                  </p>
                  <div className="actions">
                    {view.is_head && resource.state === "draft" && (
                      <button
                        disabled={busy || !!view.journal}
                        onClick={() => void run(() => prepare("adopt"))}
                      >
                        采用此版资料
                      </button>
                    )}
                    {view.is_head && resource.state !== "archived" && (
                      <button
                        disabled={busy || !!view.journal}
                        onClick={() => void run(() => prepare("archive"))}
                      >
                        归档此版资料
                      </button>
                    )}
                    {view.is_head && (
                      <button
                        disabled={busy || !!view.journal}
                        onClick={() =>
                          void run(async () => {
                            await change({
                              title: resource.title,
                              body: resource.body,
                              source_notes: resource.source_notes,
                            });
                          })
                        }
                      >
                        手工编辑资料
                      </button>
                    )}
                  </div>
                </>
              )}
              {view.buffer && !edits && (
                <div className="empty" role="region" aria-label="资料恢复稿">
                  <p>
                    本机保留了第 {view.buffer.base.revision} 版上的人工修改。
                  </p>
                  <button
                    disabled={busy || !!view.journal}
                    onClick={() =>
                      void run(async () => {
                        const fixed = await desktop.resources("get", {
                          resource_id: resource.resource_id,
                          revision: view.buffer.base.revision,
                        });
                        setView(fixed);
                        setEdits(fixed.buffer.edits);
                        await desktop.dirty(true);
                      })
                    }
                  >
                    恢复资料编辑
                  </button>
                </div>
              )}
              {view.journal && (
                <div className="empty" role="region" aria-label="资料操作恢复">
                  <p>
                    {view.journal.title}：
                    {view.journal.status === "pending"
                      ? "结果尚未确认"
                      : view.journal.status === "succeeded"
                        ? "已成功，等待确认回读"
                        : "已阻断，请核对当前资料"}
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await desktop.resources("recover", {
                          resource_id: resource.resource_id,
                        });
                        await refresh();
                        data(result);
                      })
                    }
                  >
                    查询并恢复原资料操作
                  </button>
                  {view.journal.status !== "pending" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await desktop.resources("acknowledge", {
                            resource_id: resource.resource_id,
                            operation_key: view.journal.input.operation_key,
                          });
                          await refresh();
                        })
                      }
                    >
                      已核对资料结果
                    </button>
                  )}
                </div>
              )}
              {preview && (
                <div className="empty" role="region" aria-label="资料决定预览">
                  <h3>{preview.title}</h3>
                  <p>{preview.after.title}</p>
                  <p>
                    固定第 {preview.before.revision} 版。
                    {states[preview.before.state]} →{" "}
                    {states[preview.after.state]}
                  </p>
                  <div className="resource-body">{preview.after.body}</div>
                  <p className="resource-body">{preview.after.source_notes}</p>
                  <button disabled={busy} onClick={() => void run(commit)}>
                    确认此资料决定
                  </button>
                  <button disabled={busy} onClick={() => setPreview(undefined)}>
                    返回资料审阅
                  </button>
                </div>
              )}
              <div className="actions">
                <button
                  disabled={busy || !!edits || resource.revision <= 1}
                  onClick={() =>
                    void run(() =>
                      open(resource.resource_id, resource.revision - 1),
                    )
                  }
                >
                  上一版资料
                </button>
                <button
                  disabled={busy || !!edits || view.is_head}
                  onClick={() =>
                    void run(() =>
                      open(resource.resource_id, resource.revision + 1),
                    )
                  }
                >
                  下一版资料
                </button>
                <button
                  disabled={busy || !!edits}
                  onClick={() => void run(() => open(resource.resource_id))}
                >
                  读取最新资料
                </button>
              </div>
              <h3>固定使用位置</h3>
              {usages.length ? (
                usages.map(
                  ({ usage, target_title, stale_resource, stale_source }) => (
                    <div key={usage.usage_id}>
                      <strong>
                        {target_title} {usage.role}
                      </strong>
                      <blockquote>{usage.target_ref.quote}</blockquote>
                      <p>
                        {usage.archived ? "已归档的使用记录。" : ""}
                        {stale_resource ? "资料已有新版；此处保留旧版。" : ""}
                        {stale_source ? "原文已有新版；位置仍指向旧稿。" : ""}
                      </p>
                    </div>
                  ),
                )
              ) : (
                <p>没有登记使用位置。</p>
              )}
              {usageCursor && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const next = data(
                        await desktop.resources("usages", {
                          resource_id: resource.resource_id,
                          cursor: usageCursor,
                        }),
                      );
                      setUsages(next.usages);
                      setUsageCursor(next.next_cursor ?? undefined);
                    })
                  }
                >
                  下一批使用位置
                </button>
              )}
            </>
          ) : (
            <div className="surface-selection-empty"><Icon name="file" size={20}/><p>选择资料</p></div>
          )}
        </section>
      </div>
    </section>
  );
}
