import React, { useEffect, useRef, useState } from "react";
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { desktop, data } from "./bridge.ts";
import type { SurfaceContext } from "./contributions.tsx";
import { AuthorAdoption } from "./author-review.tsx";
import { Icon, IconButton, PageActions, Workbench } from "./workbench.tsx";
import "./surface-pages.css";

export function TaskReview({ work, notify, ai }: SurfaceContext) {
  const { agentStatus, setAgentStatus } = React.useContext(Workbench);
  const generation = useRef(0);
  const [tasks, setTasks] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(),
    [cursor, setCursor] = useState<string>(),
    [loading, setLoading] = useState(true),
    [failed, setFailed] = useState(false);
  async function load(next?: string) {
    const epoch = generation.current;
    setLoading(true);
    setFailed(false);
    try {
      let result = data(
        await desktop.tasks("list", undefined, { cursor: next }),
      );
      const requested = agentStatus.taskId;
      const items = [...result.tasks];
      while (!next && requested && !items.some((task: any) => task.task_ref.task_id === requested) && result.next_cursor) {
        result = data(await desktop.tasks("list", undefined, { cursor: result.next_cursor }));
        items.push(...result.tasks);
      }
      if (epoch !== generation.current) return;
      setTasks((old) => (next ? [...old, ...items] : items));
      setCursor(result.next_cursor ?? undefined);
      const reviewable = items.find((task: any) => task.task_ref.task_id === requested) ?? items.find((task: any) => task.submission_count > 0 && task.state !== "closed");
      if (!next) setAgentStatus(reviewable ? { state: "waiting_for_audit", taskId: reviewable.task_ref.task_id, message: reviewable.brief } : { state: "idle" });
    } catch (error) {
      if (epoch !== generation.current) return;
      setFailed(true);
      notify((error as Error).message);
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => { generation.current++; setAgentStatus({ state: "idle" }); };
  }, [work]);
  useEffect(() => {
    if (agentStatus.taskId) setSelected(tasks.find(task => task.task_ref.task_id === agentStatus.taskId));
  }, [tasks, agentStatus.taskId]);
  return (
    <div className="task-review surface-page">
      <PageActions>
        <IconButton icon="refresh" label="刷新任务目录" disabled={loading} onClick={() => void load()}/>
        <button onClick={() => ai()}><Icon name="sparkles"/>让 AI 准备方案</button>
      </PageActions>
      {loading && !tasks.length ? (
        <p role="status">正在读取当前作品的任务…</p>
      ) : !tasks.length ? (
        <div className="surface-empty">
          <Icon name="shield" size={20}/>
          <p>
            {failed
              ? "任务目录未能读取，请重试。"
              : "还没有参考方案"}
          </p>
        </div>
      ) : (
        <>
          <label className="surface-task-selector">
            当前任务{" "}
            <select
              aria-label="当前审阅任务"
              value={selected?.task_ref.task_id ?? ""}
              onChange={(e) =>
                setSelected(
                  tasks.find((t) => t.task_ref.task_id === e.target.value),
                )
              }
            >
              <option value="">选择需要审阅的任务</option>
              {tasks.map((task) => (
                <option
                  key={task.task_ref.task_id}
                  value={task.task_ref.task_id}
                >
                  {task.brief} {task.submission_count} 批成果
                </option>
              ))}
            </select>
          </label>
          {cursor && (
            <button disabled={loading} onClick={() => void load(cursor)}>
              更多任务
            </button>
          )}
          {selected && (
            <TaskPanel
              key={selected.task_ref.task_id}
              task={selected}
              notify={notify}
            />
          )}
        </>
      )}
    </div>
  );
}

export function TaskPanel({
  task,
  notify,
  submissionId,
}: {
  task: any;
  notify: (message: string) => void;
  submissionId?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null),
    [journal, setJournal] = useState<any>(),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const iframe = frame.current!;
    const root = document.documentElement;
    const systemTheme = matchMedia("(prefers-color-scheme: dark)");
    const theme = (): "dark" | "light" =>
      root.dataset.appearance === "dark" ||
      (root.dataset.appearance !== "light" && systemTheme.matches)
        ? "dark"
        : "light";
    const bridge = new AppBridge(
      null,
      { name: "Hetu Luoshu author review", version: "0.9.0" },
      { serverTools: {}, serverResources: {} },
      {
        hostContext: {
          theme: theme(),
          locale: "zh-CN",
        },
      },
    );
    const syncTheme = () =>
      bridge.setHostContext({ theme: theme(), locale: "zh-CN" });
    const appearanceObserver = new MutationObserver(syncTheme);
    appearanceObserver.observe(root, {
      attributes: true,
      attributeFilter: ["data-appearance"],
    });
    systemTheme.addEventListener("change", syncTheme);
    const updateJournal = async () => {
      const record = await desktop.tasks("journal", task.task_ref);
      if (active) setJournal(record);
    };
    bridge.oncalltool = async (params) => {
      if (!active) throw new Error("任务面板已关闭。");
      try {
        return await desktop.tasks("call", task.task_ref, {
          ...params,
          arguments: {
            ...params.arguments,
            ...(submissionId && params.name === "hetu_open_task_view"
              ? { submission_id: submissionId }
              : {}),
          },
        });
      } finally {
        if (active) await updateJournal();
      }
    };
    bridge.onreadresource = (params) => {
      if (!active) throw new Error("任务面板已关闭。");
      return desktop.tasks("resource", task.task_ref, params);
    };
    void (async () => {
      try {
        setError("");
        const result = await desktop.tasks("call", task.task_ref, {
          name: "hetu_open_task_view",
          arguments: {
            task_ref: task.task_ref,
            ...(submissionId ? { submission_id: submissionId } : {}),
          },
        });
        if (!active) return;
        if (result.isError)
          throw new Error(
            result.structuredContent?.error?.message ?? "当前任务不可用。",
          );
        await updateJournal();
        bridge.oninitialized = () => {
          if (!active) return;
          clearTimeout(timer);
          bridge.sendToolInput({ arguments: { task_ref: task.task_ref } });
          bridge.sendToolResult(result);
        };
        bridge.onsizechange = (size) => {
          if (active)
            iframe.style.height = `${Math.max(650, Math.min(size.height ?? 900, 20000))}px`;
        };
        await bridge.connect(
          new PostMessageTransport(
            iframe.contentWindow!,
            iframe.contentWindow!,
          ),
        );
        if (!active) {
          await bridge.close();
          return;
        }
        iframe.src = "hetu-app://shell/task-view.html";
        timer = setTimeout(() => {
          if (active) setError("审阅面板未能连接，请重试。");
        }, 10000);
      } catch (error) {
        if (active) setError((error as Error).message);
      }
    })();
    return () => {
      active = false;
      clearTimeout(timer);
      appearanceObserver.disconnect();
      systemTheme.removeEventListener("change", syncTheme);
      iframe.src = "about:blank";
      void bridge.close().catch(() => {});
    };
  }, [task, refresh, submissionId]);
  return (
    <>
      {!submissionId && (
        <AuthorAdoption task_ref={task.task_ref} notify={notify} />
      )}
      {journal && (
        <div className="recover">
          <span>
            {journal.status === "pending"
              ? "发现未确认的保存操作"
              : "上次保存记录可核验"}
          </span>
          <button
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  data(await desktop.tasks("recover", task.task_ref));
                  setJournal(null);
                  setRefresh((v) => v + 1);
                  notify("原保存操作已确认，可继续比较。采纳与定稿保持独立。");
                } catch (error) {
                  notify((error as Error).message);
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            查询并恢复原保存
          </button>
        </div>
      )}
      {error && (
        <div className="notice" role="alert">
          {error}{" "}
          <button onClick={() => setRefresh((v) => v + 1)}>重新打开面板</button>
        </div>
      )}
      <iframe
        ref={frame}
        title="任务候选审阅"
        sandbox="allow-scripts"
        className="task-frame"
      />
    </>
  );
}
