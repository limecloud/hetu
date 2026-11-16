import React, { useEffect, useState } from "react";
import { desktop, data } from "./bridge.ts";
import type { SurfaceContext } from "./contributions.tsx";
import { TransferDetails, transferKind, type TransferKind } from "./transfer-review.tsx";
import { Icon, IconButton, PageActions } from "./workbench.tsx";
import "./surface-pages.css";

const states: Record<string, string> = {
  pending: "待审阅",
  approved: "已批准，待执行",
  rejected: "已拒绝",
  executed: "已执行",
  executing: "执行结果待确认",
};
const names: Record<string, string> = {
  title: "名称",
  author_name: "作者",
  synopsis: "简介",
  genre: "题材",
  status: "状态",
  language_tag: "语言",
  metadata: "作品资料",
  volumes: "卷",
  chapters: "章",
  plan: "创作计划",
  brief: "创作目标",
  summary: "摘要",
  name: "名称",
  description: "描述",
  order: "顺序",
  episodes: "分集",
  canon: "设定",
  characters: "人物",
  locations: "地点",
  rules: "规则",
};
function fields(
  before: any,
  after: any,
  prefix = "",
): { field: string; before: string; after: string }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    (before && typeof before === "object") ||
    (after && typeof after === "object")
  ) {
    return [
      ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
    ]
      .filter(
        (key) =>
          !/^(schema_version|revision|created_at|updated_at|(?:.*_)?sha256|.*_id|.*_ref)$/.test(
            key,
          ),
      )
      .flatMap((key) =>
        fields(
          before?.[key],
          after?.[key],
          [
            prefix,
            /^\d+$/.test(key) ? String(Number(key) + 1) : (names[key] ?? key),
          ]
            .filter(Boolean)
            .join(" / "),
        ),
      );
  }
  return [
    {
      field: prefix || "内容",
      before: before == null ? "（无）" : String(before),
      after: after == null ? "（无）" : String(after),
    },
  ];
}
function Changes({ view }: { view: any }) {
  if (transferKind(view.action)) return <TransferDetails key={view.proposal_id} view={view} />;
  return (
    <section aria-label="方案具体变化">
      {view.changes.length ? (
        view.changes.map((change: any, index: number) => {
          let rows: ReturnType<typeof fields> | undefined;
          try {
            rows = fields(
              change.before === null ? null : JSON.parse(change.before),
              JSON.parse(change.after),
            );
          } catch {
            /* 正文和非 JSON 内容按文本差异展示。 */
          }
          return (
            <div className="proposal-change" key={index}>
              <h3>变化 {index + 1}</h3>
              {rows?.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>项目</th>
                      <th>当前内容</th>
                      <th>方案内容</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 500).map((row, i) => (
                      <tr key={i}>
                        <th>{row.field}</th>
                        <td>{row.before}</td>
                        <td>{row.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : rows ? (
                <p>此项涉及记录信息，完整变化见下方固定预览。</p>
              ) : (
                <div className="compare">
                  <article>
                    <h4>当前内容</h4>
                    <pre>{change.before ?? "（新建）"}</pre>
                  </article>
                  <article>
                    <h4>方案内容</h4>
                    <pre>{change.after}</pre>
                  </article>
                </div>
              )}
              {rows && rows.length > 500 && (
                <p>此项变化较多，完整内容见下方固定详情。</p>
              )}
            </div>
          );
        })
      ) : (
        <p>此方案在执行时产生交付或外部操作，请核对下面的固定输入和预览。</p>
      )}
      <details>
        <summary>固定输入与完整预览</summary>
        <pre>
          {JSON.stringify(
            {
              action: view.action,
              input: view.input,
              preview: view.preview,
              changes: view.changes,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}

export function Management({ work, notify, ai, workflow }: SurfaceContext & { workflow?: TransferKind }) {
  const [proposals, setProposals] = useState<any[]>([]),
    [cursor, setCursor] = useState<string>(),
    [selected, setSelected] = useState<any>(),
    [preview, setPreview] = useState<any>(),
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
  async function list(next?: string) {
    const page = data(
      await desktop.management("list", next ? { cursor: next } : {}),
    );
    const matching = workflow ? page.proposals.filter((proposal: any) => transferKind(proposal.action) === workflow) : page.proposals;
    setProposals((old) =>
      next ? [...old, ...matching] : matching,
    );
    setCursor(page.next_cursor ?? undefined);
  }
  async function load(proposal: any) {
    const value = await desktop.management("get", {
      proposal_id: proposal.proposal_id,
      proposal_sha256: proposal.proposal_sha256,
    });
    setSelected(value);
    setPreview(undefined);
  }
  useEffect(() => {
    void run(async () => {
      setSelected(undefined);
      setPreview(undefined);
      await list();
    });
  }, [work, workflow]);
  async function recover() {
    data(
      await desktop.management("recover", {
        proposal_id: selected.proposal_id,
      }),
    );
    const current = await desktop.management("get", {
      proposal_id: selected.proposal_id,
      proposal_sha256: selected.proposal_sha256,
    });
    if (current.journal?.status === "succeeded")
      await desktop.management("acknowledge", {
        proposal_id: current.proposal_id,
        operation_key: current.journal.input.operation_key,
      });
    await load(current);
    await list();
    notify("原审核决定已确认。");
  }
  return (
    <div className="management-review surface-page">
      <PageActions>
        <IconButton icon="refresh" label="刷新管理方案" disabled={busy} onClick={() =>
            void run(async () => {
              await list();
              if (selected) await load(selected);
            })
          }
        />
        <button onClick={() => ai()}><Icon name="sparkles"/>{workflow === "import" ? "让 AI 准备导入" : workflow === "delivery" ? "让 AI 准备交付" : "让 AI 准备管理方案"}</button>
      </PageActions>
      {error && <p role="alert">{error}</p>}
      {!proposals.length ? (
        <div className="surface-empty">
          <Icon name={workflow === "delivery" ? "export" : workflow === "import" ? "file" : "shield"} size={20}/>
          <p>{error ? "方案目录未能读取" : workflow === "import" ? "还没有导入方案" : workflow === "delivery" ? "还没有交付方案" : "当前作品还没有管理方案"}</p>
          {cursor && <button disabled={busy} onClick={() => void run(() => list(cursor))}>更多方案</button>}
        </div>
      ) : (
        <>
          <label className="surface-task-selector">
            管理方案{" "}
            <select
              aria-label="当前管理方案"
              disabled={busy}
              value={selected?.proposal_id ?? ""}
              onChange={(e) => {
                const item = proposals.find(
                  (p) => p.proposal_id === e.target.value,
                );
                if (item) void run(() => load(item));
              }}
            >
              <option value="">选择方案</option>
              {proposals.map((proposal) => (
                <option key={proposal.proposal_id} value={proposal.proposal_id}>
                  {proposal.summary}{" "}
                  {states[proposal.state] ?? proposal.state}
                </option>
              ))}
            </select>
          </label>
          {cursor && (
            <button
              disabled={busy}
              onClick={() => void run(() => list(cursor))}
            >
              更多方案
            </button>
          )}
          {selected && (
            <section aria-label="固定管理方案">
              <h2>{selected.summary}</h2>
              <p>
                {states[selected.state] ?? selected.state}
                {selected.is_expired ? " 已过期" : ""}
                {!selected.is_current ? " 作品基线已有变化" : ""}
              </p>
              <Changes view={selected} />
              {selected.journal && (
                <div className="recover">
                  <p>发现待核对的原审核决定。</p>
                  <button disabled={busy} onClick={() => void run(recover)}>
                    恢复原审核决定
                  </button>
                  {selected.journal.status === "blocked" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await desktop.management("acknowledge", {
                            proposal_id: selected.proposal_id,
                            operation_key: selected.journal.input.operation_key,
                          });
                          await load(selected);
                        })
                      }
                    >
                      结束失败决定
                    </button>
                  )}
                </div>
              )}
              {!["executed", "executing"].includes(selected.state) && (
                <div className="actions">
                  {["approve", "reject"].map((decision) => (
                    <button
                      key={decision}
                      disabled={
                        busy ||
                        selected.journal?.status === "pending" ||
                        (decision === "approve" &&
                          (selected.is_expired || !selected.is_current))
                      }
                      onClick={() =>
                        void run(async () =>
                          setPreview(
                            await desktop.management("prepare", {
                              proposal_id: selected.proposal_id,
                              proposal_sha256: selected.proposal_sha256,
                              state_revision: selected.state_revision,
                              decision,
                            }),
                          ),
                        )
                      }
                    >
                      {decision === "approve" ? "批准此方案" : "拒绝此方案"}
                    </button>
                  ))}
                </div>
              )}
              {preview && (
                <section className="recover" aria-label="管理方案决定预览">
                  <h3>{preview.title}</h3>
                  <p>确认后记录这份固定方案的审核决定。</p>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        data(
                          await desktop.management("commit", {
                            token: preview.token,
                          }),
                        );
                        const current = await desktop.management("get", {
                          proposal_id: selected.proposal_id,
                          proposal_sha256: selected.proposal_sha256,
                        });
                        await desktop.management("acknowledge", {
                          proposal_id: current.proposal_id,
                          operation_key: current.journal.input.operation_key,
                        });
                        await load(current);
                        await list();
                        notify(
                          current.state === "approved"
                            ? "方案已批准，尚未执行。"
                            : "方案已拒绝。",
                        );
                      })
                    }
                  >
                    确认此审核决定
                  </button>
                  <button onClick={() => setPreview(undefined)}>
                    返回审阅
                  </button>
                </section>
              )}
              {selected.state === "approved" && (
                <button
                  disabled={busy || selected.is_expired || !selected.is_current}
                  onClick={() =>
                    void run(async () => {
                      await desktop.management("continue", {
                        proposal_id: selected.proposal_id,
                        proposal_sha256: selected.proposal_sha256,
                      });
                      notify("已复制固定方案接续请求，尚未发送给 Agent。");
                    })
                  }
                >
                  复制方案执行请求
                </button>
              )}
              {selected.state === "executed" && (
                <p>
                  方案已执行。返回对应工作面回读成果；正文采纳与定稿另行决定。
                </p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
