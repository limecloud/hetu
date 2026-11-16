import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  unwrap,
  type PluginBridge,
  type ObjectResult,
  sameWork,
} from "@hetu/plugin-sdk";
declare global {
  interface Window {
    hetu: PluginBridge & {
      invoke(action: string, input: unknown): Promise<unknown>;
    };
  }
}
export function mountPlugin(options: {
  title: string;
  kind: string;
  initial: unknown;
  render: (content: any) => React.ReactNode;
  add: (content: any, label: string) => unknown;
  arrange?: boolean;
}) {
  function View() {
    const [objects, setObjects] = useState<any[]>([]),
      [record, setRecord] = useState<ObjectResult>(),
      [label, setLabel] = useState(""),
      [message, setMessage] = useState(""),
      [busy, setBusy] = useState(false);
    type Pending = {
      type: "save" | "invoke";
      input: Record<string, unknown>;
      package_sha256: string;
    };
    const fixed = useRef<Pending>();
    const [recoverable, setRecoverable] = useState(false);
    async function list(preferred?: string) {
      const context = await window.hetu.context();
      const result = unwrap<any>(
        await window.hetu.request("hetu.extensions.objects.list", {
          work_ref: context.work_ref,
          kind: options.kind,
        }),
      );
      setObjects(result.objects);
      const id =
        preferred ?? record?.object.object_id ?? result.objects[0]?.object_id;
      if (id)
        setRecord(
          unwrap<ObjectResult>(
            await window.hetu.request("hetu.extensions.objects.get", {
              work_ref: context.work_ref,
              object_id: id,
            }),
          ),
        );
    }
    useEffect(() => {
      void (async () => {
        await list();
        const context = await window.hetu.context(),
          saved = (await window.hetu.buffer()) as Pending | null;
        if (saved) {
          if (
            saved.package_sha256 !== context.package_sha256 ||
            !sameWork(saved.input.work_ref, context.work_ref)
          ) {
            setMessage(
              "发现其他包版本的恢复记录，已保留；请安装对应版本恢复。",
            );
            return;
          }
          fixed.current = saved;
          setRecoverable(true);
          setMessage("发现尚未确认的原操作，可查询并恢复。");
        }
      })().catch((e) => setMessage(e.message));
    }, []);
    async function execute(pending: Pending) {
      if (busy) return;
      fixed.current = pending;
      setRecoverable(true);
      setBusy(true);
      try {
        await window.hetu.buffer(pending);
        const receipt = await window.hetu.request<ObjectResult>(
          "hetu.extensions.operations.get",
          {
            work_ref: pending.input.work_ref,
            operation_key: pending.input.operation_key,
          },
        );
        let result: ObjectResult;
        if (receipt.status === "succeeded") result = unwrap(receipt);
        else {
          if (receipt.error?.code !== "not_found")
            throw new Error(receipt.error?.message ?? "原操作暂时无法查询。");
          result =
            pending.type === "save"
              ? unwrap<ObjectResult>(
                  await window.hetu.request(
                    "hetu.extensions.objects.save",
                    pending.input,
                  ),
                )
              : unwrap<ObjectResult>(
                  (await window.hetu.invoke(
                    "arrange",
                    Object.fromEntries(
                      Object.entries(pending.input).filter(
                        ([key]) => key !== "work_ref",
                      ),
                    ),
                  )) as any,
                );
        }
        setRecord(result);
        fixed.current = undefined;
        setRecoverable(false);
        await window.hetu.buffer(null);
        setLabel("");
        setMessage(
          pending.type === "save"
            ? "已保存修订 " + result.object.revision
            : "已重新排列并保存。",
        );
        await list(result.object.object_id);
      } catch (e) {
        setMessage((e as Error).message + " 原操作已保留，可查询恢复。");
      } finally {
        setBusy(false);
      }
    }
    async function save(content: unknown) {
      if (fixed.current) return execute(fixed.current);
      const context = await window.hetu.context();
      return execute({
        type: "save",
        package_sha256: context.package_sha256,
        input: {
          work_ref: context.work_ref,
          ...(record ? { object_id: record.object.object_id } : {}),
          kind: options.kind,
          schema_version: "1",
          title: record?.object.title ?? options.title,
          content,
          expected_revision: record?.object.revision ?? 0,
          expected_sha256: record?.sha256 ?? "",
          operation_key: crypto.randomUUID(),
        },
      });
    }
    return (
      <div
        style={{
          font: "14px/1.6 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
          padding: 28,
          color: "var(--ink)",
          background: "var(--page)",
          minHeight: "100vh",
          boxSizing: "border-box",
        }}
      >
        <style>
          {
            "*{box-sizing:border-box}body{margin:0}h2{font-size:20px}h3{font-size:14px}small{font-size:12px}button,input,select{font:inherit;padding:7px 12px;border:.5px solid var(--line);border-radius:6px;background:transparent;color:inherit}button{cursor:pointer}button:hover{background:var(--hover)}button:disabled{opacity:.5}button:focus-visible,input:focus-visible{outline:2px solid var(--focus);outline-offset:2px}"
          }
        </style>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontWeight: 550 }}>{options.title}</h2>
          </div>
          {record && (
            <span style={{ color: "var(--muted)" }}>
              修订 {record.object.revision}
            </span>
          )}
        </header>
        {message && <p role="status">{message}</p>}
        {recoverable && (
          <div>
            <button
              disabled={busy}
              onClick={() => fixed.current && void execute(fixed.current)}
            >
              查询并恢复原操作
            </button>
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 8,
            margin: "20px 0",
            flexWrap: "wrap",
          }}
        >
          {objects.length > 1 && (
            <select
              aria-label="选择成果"
              value={record?.object.object_id}
              onChange={(e) =>
                void window.hetu
                  .context()
                  .then((c) =>
                    window.hetu.request<ObjectResult>(
                      "hetu.extensions.objects.get",
                      { work_ref: c.work_ref, object_id: e.target.value },
                    ),
                  )
                  .then((r) => setRecord(unwrap(r)))
                  .catch((e) => setMessage(e.message))
              }
            >
              {objects.map((o) => (
                <option key={o.object_id} value={o.object_id}>
                  {o.title}
                </option>
              ))}
            </select>
          )}
          <input
            aria-label="新增条目"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={
              options.kind === "relationships" ? "人物名称" : "事件标题"
            }
          />
          <button
            disabled={busy || recoverable || !label.trim()}
            onClick={() =>
              void save(
                options.add(
                  record?.object.content ?? options.initial,
                  label.trim(),
                ),
              )
            }
          >
            添加并保存
          </button>
          {!record && (
            <button
              disabled={busy || recoverable}
              onClick={() => void save(options.initial)}
            >
              创建空白成果
            </button>
          )}
          {options.arrange && record && (
            <button
              disabled={busy || recoverable}
              onClick={() => {
                void window.hetu
                  .context()
                  .then((context) =>
                    execute({
                      type: "invoke",
                      package_sha256: context.package_sha256,
                      input: {
                        work_ref: context.work_ref,
                        object_id: record.object.object_id,
                        operation_key: crypto.randomUUID(),
                      },
                    }),
                  )
                  .catch((e) => setMessage(e.message));
              }}
            >
              自动排列
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => void list().catch((e) => setMessage(e.message))}
          >
            重新读取
          </button>
        </div>
        {record ? (
          options.render(record.object.content)
        ) : (
          <p style={{ padding: "60px 0", color: "var(--muted)" }}>
            还没有成果。可让 AI 准备，或创建空白成果。
          </p>
        )}
      </div>
    );
  }
  createRoot(document.getElementById("root")!).render(<View />);
}
