import React, { useEffect, useState } from "react";
import { desktop } from "./bridge.ts";
import { domainText } from "./strings.ts";
import { PartialAdoption } from "./partial-adoption.tsx";

function resultData(result: any) {
  if (!["succeeded", "partial"].includes(result.status))
    throw new Error(result.error?.message ?? "操作未完成。");
  return result.data;
}
async function acknowledge(id: string, result: any) {
  if (result.operation?.key)
    await desktop.author("acknowledge", {
      document_id: id,
      operation_key: result.operation.key,
    });
}
export function DecisionPreview({
  value,
  busy,
  confirm,
  cancel,
}: {
  value: any;
  busy: boolean;
  confirm: () => void;
  cancel: () => void;
}) {
  const compare = value.before !== undefined && !value.is_new;
  return (
    <section className="decision-preview" aria-label="作者决定预览">
      <h3>{value.title}</h3>
      {value.destination && <p>{value.destination}</p>}
      {value.is_new && (
        <p>
          将新增{value.kind === "drama" ? "分集" : "章节"}
          ，采纳后仍需单独检查与定稿。
        </p>
      )}
      <div className={compare ? "compare" : ""}>
        {compare && (
          <section>
            <h4>当前正文</h4>
            <pre>{value.before}</pre>
          </section>
        )}
        <section>
          <h4>{value.is_new || compare ? "采纳后正文" : "固定修订内容"}</h4>
          <pre>{value.after}</pre>
        </section>
      </div>
      {value.baseline !== undefined && value.baseline !== value.before && (
        <details>
          <summary>Agent 使用的原始基线</summary>
          <pre>{value.baseline}</pre>
        </details>
      )}
      {value.blocker && <p role="alert">{value.blocker.message}</p>}
      <div className="actions">
        <button
          className="primary"
          disabled={busy || !value.eligible}
          onClick={confirm}
        >
          确认此预览
        </button>
        <button disabled={busy} onClick={cancel}>
          取消预览
        </button>
      </div>
    </section>
  );
}

export function AuthorAdoption({
  task_ref,
  notify,
}: {
  task_ref: any;
  notify: (text: string) => void;
}) {
  const [candidates, setCandidates] = useState<any[]>([]),
    [selected, setSelected] = useState(""),
    [preview, setPreview] = useState<any>(),
    [busy, setBusy] = useState(false),
    [options, setOptions] = useState<any>(),
    [title, setTitle] = useState(""),
    [volume, setVolume] = useState(""),
    [journal, setJournal] = useState<any>();
  useEffect(() => {
    let active = true;
    setSelected("");
    setCandidates([]);
    setJournal(undefined);
    void Promise.all([
      desktop.tasks("call", task_ref, {
        name: "hetu_open_task_view",
        arguments: { task_ref },
      }),
      desktop.author("new_adoption_journal", { task_ref }),
    ])
      .then(([result, saved]) => {
        const value = resultData(result.structuredContent);
        if (active) {
          setJournal(saved);
          setCandidates(
            value.submission?.candidates.filter(
              (c: any) => c.kind === "text" && c.draft_ref,
            ) ?? [],
          );
        }
      })
      .catch((e) => notify(e.message));
    return () => {
      active = false;
    };
  }, [task_ref]);
  useEffect(() => {
    let active = true;
    setOptions(undefined);
    setPreview(undefined);
    if (selected)
      void desktop
        .author("adoption_options", { task_ref, candidate_id: selected })
        .then((value) => {
          if (active) {
            setOptions(value);
            setTitle(value.title);
            setVolume("");
          }
        })
        .catch((error) => {
          if (active) notify(error.message);
        });
    return () => {
      active = false;
    };
  }, [selected, task_ref]);
  async function refreshJournal() {
    try {
      setJournal(await desktop.author("new_adoption_journal", { task_ref }));
    } catch (error) {
      notify("作者操作恢复状态未能回读：" + (error as Error).message);
    }
  }
  if (!candidates.length && !journal) return null;
  return (
    <details className="author-adoption">
      <summary>采纳到作者正文</summary>
      <p className="muted">
        候选面板中的选择只记录偏好。在这里审阅正文变化，并单独决定采纳。
      </p>
      {journal && (
        <div className="recover">
          <span>
            {journal.title}{" "}
            {journal.status === "pending" ? "结果待确认" : "操作记录可核验"}
          </span>
          <button
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  const result = await desktop.author("new_adoption_recover", {
                    task_ref,
                  });
                  const value = resultData(result);
                  await desktop.author("new_adoption_acknowledge", {
                    task_ref,
                    operation_key: result.operation.key,
                  });
                  notify(
                    `已恢复「${value.document.title}」，可继续阅读核对，尚未定稿。`,
                  );
                } catch (error) {
                  notify((error as Error).message);
                } finally {
                  await refreshJournal();
                  setBusy(false);
                }
              })()
            }
          >
            恢复原新稿采纳
          </button>
          {journal.status === "blocked" && (
            <button
              disabled={busy}
              onClick={() =>
                void (async () => {
                  await desktop.author("new_adoption_acknowledge", {
                    task_ref,
                    operation_key: journal.input.operation_key,
                  });
                  await refreshJournal();
                  setPreview(undefined);
                  notify("原采纳已被拒绝，请重新读取目录并预览。");
                })().catch((error) => notify(error.message))
              }
            >
              结束失败的新稿采纳
            </button>
          )}
        </div>
      )}
      <label>
        参考方案{" "}
        <select
          aria-label="采纳参考方案"
          value={selected}
          disabled={busy}
          onChange={(e) => {
            setSelected(e.target.value);
            setPreview(undefined);
          }}
        >
          <option value="">选择参考方案</option>
          {candidates.map((candidate) => (
            <option key={candidate.candidate_id} value={candidate.candidate_id}>
              {candidate.title}
            </option>
          ))}
        </select>
      </label>{" "}
      <button
        disabled={
          busy ||
          !selected ||
          !options ||
          (options.is_new && (!title.trim() || journal?.status === "pending"))
        }
        onClick={() =>
          void (async () => {
            setBusy(true);
            try {
              setPreview(
                await desktop.author("adoption", {
                  task_ref,
                  candidate_id: selected,
                  ...(options?.is_new
                    ? { new_target: { title, volume_id: volume || null } }
                    : {}),
                }),
              );
            } catch (error) {
              notify((error as Error).message);
            } finally {
              setBusy(false);
            }
          })()
        }
      >
        预览采纳变化
      </button>
      {options?.is_new && (
        <details>
          <summary>
            {options.kind === "drama"
              ? "调整新分集标题"
              : "调整新章节位置与标题"}
          </summary>
          <label>
            新稿标题{" "}
            <input
              aria-label="新稿标题"
              value={title}
              maxLength={200}
              disabled={busy}
              onChange={(e) => {
                setTitle(e.target.value);
                setPreview(undefined);
              }}
            />
          </label>
          {options.kind === "novel" && (
            <label>
              所属分卷{" "}
              <select
                aria-label="新稿所属分卷"
                value={volume}
                disabled={busy}
                onChange={(e) => {
                  setVolume(e.target.value);
                  setPreview(undefined);
                }}
              >
                <option value="">未分卷</option>
                {options.volumes.map((item: any) => (
                  <option key={item.volume_id} value={item.volume_id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </details>
      )}
      {selected && options && !options.is_new && (
        <PartialAdoption
          key={selected}
          task_ref={task_ref}
          candidate_id={selected}
          busy={busy}
          notify={notify}
          preview={setPreview}
        />
      )}
      {preview && (
        <DecisionPreview
          value={preview}
          busy={busy}
          cancel={() => setPreview(undefined)}
          confirm={() =>
            void (async () => {
              setBusy(true);
              try {
                const result = await desktop.author("commit", {
                  token: preview.token,
                });
                resultData(result);
                if (preview.recovery_scope)
                  await desktop.author("new_adoption_acknowledge", {
                    task_ref: preview.recovery_scope,
                    operation_key: result.operation.key,
                  });
                else await acknowledge(preview.document_id, result);
                setPreview(undefined);
                notify("已采纳为新的作者修订，尚未定稿。可继续阅读核对。");
              } catch (error) {
                notify(
                  (error as Error).message +
                    " 可从本任务或目标文稿核验原操作。",
                );
              } finally {
                await refreshJournal();
                setBusy(false);
              }
            })()
          }
        />
      )}
    </details>
  );
}

export function AuthorLifecycle({
  value,
  notify,
  refresh,
  ai,
}: {
  value: any;
  notify: (text: string) => void;
  refresh: () => Promise<void>;
  ai: () => void;
}) {
  const id = value.document.document_id;
  const [journal, setJournal] = useState<any>(),
    [check, setCheck] = useState<any>(),
    [history, setHistory] = useState<any>(),
    [comments, setComments] = useState(""),
    [coverage, setCoverage] = useState(""),
    [reason, setReason] = useState(""),
    [preview, setPreview] = useState<any>(),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([
      desktop.author("journal", { document_id: id }),
      desktop.read("hetu.documents.lifecycle", { document_id: id }),
    ])
      .then(([saved, result]) => {
        if (active) {
          setJournal(saved);
          setHistory(resultData(result));
        }
      })
      .catch((e) => notify(e.message));
    return () => {
      active = false;
    };
  }, [id]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      notify((error as Error).message);
    } finally {
      try {
        setJournal(await desktop.author("journal", { document_id: id }));
      } catch {}
      setBusy(false);
    }
  }
  return (
    <section className="lifecycle">
      {journal && (
        <div className="recover">
          <span>
            {journal.title}{" "}
            {journal.status === "pending" ? "结果待确认" : "操作记录可核验"}
          </span>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await desktop.author("recover", {
                  document_id: id,
                });
                const restored = resultData(result);
                await acknowledge(id, result);
                if (restored.report) setCheck(restored);
                else await refresh();
                notify("原作者操作已确认，保留既有历史。");
              })
            }
          >
            恢复原作者操作
          </button>
          {journal.status === "blocked" && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await desktop.author("acknowledge", {
                    document_id: id,
                    operation_key: journal.input.operation_key,
                  });
                  notify("操作已被拒绝，作品保持原状态。请重新审阅。");
                })
              }
            >
              结束失败操作
            </button>
          )}
        </div>
      )}
      <details>
        <summary>
          检查与定稿{" "}
          {value.document.approved_revision_id === value.revision.revision_id
            ? "当前修订已定稿"
            : value.document.approved_revision_id
              ? "保留历史定稿，当前修订未定稿"
              : "尚未定稿"}
        </summary>
        <p className="muted">
          检查针对当前固定修订。采纳、保存和定稿分别记录。
        </p>
        <button
          disabled={busy || (!!journal?.status && journal.status === "pending")}
          onClick={() =>
            void run(async () => {
              const result = await desktop.author("check", { document_id: id });
              setCheck(resultData(result));
              await acknowledge(id, result);
              setPreview(undefined);
            })
          }
        >
          检查当前修订
        </button>
        {check && (
          <>
            <p>
              {check.report.findings?.length
                ? `发现 ${check.report.findings.length} 项需要核对的问题。`
                : "本次检查没有发现规则问题。"}
            </p>
            {check.report.findings?.map((finding: any) => (
              <div key={finding.finding_id} className="feedback-box">
                <strong>
                  {finding.message ??
                    finding.title ??
                    domainText(finding.message_key, "检查发现")}
                </strong>
                <p>
                  {finding.explanation ?? finding.description ?? finding.reason}
                </p>
                <span className="muted">
                  {domainText("rule.severity." + finding.severity, "需要核对")}{" "}
                 {" "}
                  {domainText(
                    "validation.certainty." + finding.certainty,
                    "请结合语境判断",
                  )}
                </span>
              </div>
            ))}
            <p className="muted">
              自动检查只覆盖已定义规则；请结合完整作品核对人物、语境和创作意图。
            </p>
            <p className="muted">
              {check.report.status === "partial"
                ? "检查覆盖不完整。"
                : "本次检查已完成。"}{" "}
              通过 {check.report.coverage?.counts?.passed ?? 0} 项；缺少前提{" "}
              {check.report.coverage?.counts?.unknown ?? 0} 项；有发现或提示{" "}
              {check.report.coverage?.counts?.finding ?? 0} 项。
            </p>
            <label>
              定稿理由
              <textarea
                aria-label="定稿理由"
                value={comments}
                maxLength={20000}
                onChange={(e) => {
                  setComments(e.target.value);
                  setPreview(undefined);
                }}
              />
            </label>
            <label>
              人工核对说明
              <textarea
                aria-label="人工核对说明"
                value={coverage}
                maxLength={20000}
                onChange={(e) => {
                  setCoverage(e.target.value);
                  setPreview(undefined);
                }}
              />
            </label>
            <div className="actions">
              <button
                disabled={busy || !comments.trim() || !coverage.trim()}
                onClick={() =>
                  void run(async () =>
                    setPreview(
                      await desktop.author("finalization", {
                        document_id: id,
                        report_ref: check.reference,
                        comments,
                        coverage,
                      }),
                    ),
                  )
                }
              >
                预览定稿
              </button>
              <button onClick={ai}>让 AI 核对问题</button>
            </div>
          </>
        )}
        {value.document.finalization_ref && (
          <details>
            <summary>撤回当前定稿决定</summary>
            <p>正文和历史版本保留。</p>
            <label>
              撤回理由
              <textarea
                aria-label="撤回定稿理由"
                value={reason}
                maxLength={20000}
                onChange={(e) => {
                  setReason(e.target.value);
                  setPreview(undefined);
                }}
              />
            </label>
            <button
              disabled={busy || !reason.trim()}
              onClick={() =>
                void run(async () =>
                  setPreview(
                    await desktop.author("withdrawal", {
                      document_id: id,
                      reason,
                    }),
                  ),
                )
              }
            >
              预览撤回定稿
            </button>
          </details>
        )}
        {preview && (
          <DecisionPreview
            value={preview}
            busy={busy}
            cancel={() => setPreview(undefined)}
            confirm={() =>
              void run(async () => {
                const result = await desktop.author("commit", {
                  token: preview.token,
                });
                resultData(result);
                await acknowledge(id, result);
                setPreview(undefined);
                await refresh();
                notify("作者决定已记录，可查看决定历史。");
              })
            }
          />
        )}
        {history && (
          <details>
            <summary>
              决定历史 {history.adoptions?.length ?? 0} 次采纳，
              {history.finalizations?.length ?? 0} 次定稿决定
            </summary>
            {history.finalizations?.map((item: any) => (
              <div className="row" key={item.finalization_id}>
                <strong>
                  {item.decision === "confirmed" ? "确认定稿" : "撤回定稿"}
                </strong>
                <span>{item.comments ?? item.reason}</span>
                <time>{item.created_at}</time>
              </div>
            ))}
          </details>
        )}
      </details>
    </section>
  );
}
