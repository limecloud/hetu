import React, { useEffect, useRef, useState } from "react";
import {
  AppBridge,
  PostMessageTransport,
  McpUiMessageRequestSchema,
  McpUiMessageResultSchema,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { desktop, data } from "./bridge.ts";
import type { SurfaceContext } from "./contributions.tsx";
import { AuthorAdoption } from "./author-review.tsx";
import { Icon, IconButton, PageActions, Workbench } from "./workbench.tsx";
import "./surface-pages.css";
import { usePreferences } from "./preferences.tsx";
import { readingProfile } from "@hetu/workbench-ui";
import type {WorkRef} from "@hetu/plugin-sdk";
import {TaskAssessment} from "./task-assessment.tsx";

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
      const reviewable = items.find((task: any) => task.task_ref.task_id === requested) ?? items.find((task: any) => (task.submission_count > 0 || task.working_copy_count > 0) && task.state !== "closed");
      if (!next) setAgentStatus(previous=>reviewable?{state:"waiting_for_audit",taskId:reviewable.task_ref.task_id,message:reviewable.brief,...(previous.taskId===reviewable.task_ref.task_id?{submissionId:previous.submissionId}:{})}:{state:"idle"});
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
              onChange={(e) =>{setAgentStatus(previous=>({...previous,taskId:e.target.value,submissionId:undefined}));setSelected(tasks.find((t)=>t.task_ref.task_id===e.target.value));}}
            >
              <option value="">选择需要审阅的任务</option>
              {tasks.map((task) => (
                <option
                  key={task.task_ref.task_id}
                  value={task.task_ref.task_id}
                >
                  {task.brief} {task.submission_count} 批成果{task.working_copy_count ? ` ${task.working_copy_count} 份工作稿` : ""}
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
            <>
            {agentStatus.submissionId&&<div className="actions"><span>正在查看固定成果批次</span><button onClick={()=>setAgentStatus(previous=>({...previous,submissionId:undefined}))}>查看最新成果</button></div>}
            <TaskPanel
              key={selected.task_ref.task_id+(agentStatus.submissionId??"")}
              task={selected}
              workKind={work.kind}
              work={work}
              notify={notify}
              submissionId={agentStatus.submissionId}
            />
            </>
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
  workKind,
  work,
}: {
  task: any;
  notify: (message: string) => void;
  submissionId?: string;
  workKind?: string;
  work: WorkRef;
}) {
  const preferences = usePreferences(), preferenceRef = useRef(preferences);
  preferenceRef.current = preferences;
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
    const theme = (): "dark" | "light" => root.dataset.appearance === "dark" || root.dataset.effectiveAppearance === "dark" ? "dark" : "light";
    const readingContext = () => ({ kind: workKind === "drama" ? "screenplay" : "novel", preferences: {
      settings_revision: preferenceRef.current.settings_revision ?? 0,
      document_theme: preferenceRef.current.document_theme ?? "system",
      reading_profiles: {novel: readingProfile(preferenceRef.current, "novel"), screenplay: readingProfile(preferenceRef.current, "screenplay")},
    } });
    const bridge = new AppBridge(
      null,
      { name: "Hetu Luoshu author review", version: "0.9.0" },
      { serverTools: {}, serverResources: {},...(desktop.agentSessionHost&&desktop.promptDelivery?.drafts?{message:{text:{}},experimental:{"hetu/message":{drafts:true,directSend:false}}}:{}) },
      {
        hostContext: {
          theme: theme(),
          locale: preferenceRef.current.language ?? "zh-CN",
          "hetu/reading": readingContext(),
        },
      },
    );
    // 保留本机草稿扩展；标准onmessage参数Schema会丢弃_meta。
    bridge.setRequestHandler("ui/message",{params:McpUiMessageRequestSchema.shape.params.passthrough(),result:McpUiMessageResultSchema},async params => {
      if(!active||!desktop.agentSessionHost||!desktop.promptDelivery)throw new Error("当前审阅面板不可交接会话。");
      const metadata=(params as typeof params&{_meta?:Record<string,unknown>})._meta?.["hetu/message"] as {target?:string;send?:boolean}|undefined;
      if(params.role!=="user"||metadata?.send!==false||!["active","new"].includes(metadata.target??"")||params.content.some(part=>part.type!=="text"))throw new Error("此面板仅接受固定任务的文字草稿。");
      const text=params.content.map(part=>part.type==="text"?part.text:"").join("\n");
      if(metadata.target==="new")await desktop.agentSession("new",{work_ref:work});
      if(!active)throw new Error("审阅面板已关闭，草稿未投递。");
      const result=await desktop.promptDelivery.send(text,"draft",work);
      if(active&&!result.isError)window.dispatchEvent(new CustomEvent("hetu:agent-open",{detail:{work_ref:work}}));
      return {isError:result.isError??false};
    });
    const syncTheme = () =>
      bridge.setHostContext({ theme: theme(), locale: preferenceRef.current.language ?? "zh-CN", "hetu/reading": readingContext() });
    const appearanceObserver = new MutationObserver(syncTheme);
    appearanceObserver.observe(root, {
      attributes: true,
      attributeFilter: ["data-appearance", "data-effective-appearance", "data-document-theme", "style"],
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
        if (!active) return;
        bridge.oninitialized = () => {
          if (!active) return;
          clearTimeout(timer);
          bridge.sendToolInput({ arguments: { task_ref: task.task_ref,...(submissionId?{submission_id:submissionId}:{}) } });
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
        const resource = (window as any).hetuTaskViewResource
          ? await (window as any).hetuTaskViewResource() : undefined;
        if (!active) return;
        timer = setTimeout(() => {
          if (active) setError("审阅面板未能连接，请重试。");
        }, 10000);
        if (resource !== undefined) iframe.srcdoc = resource;
        else iframe.src = "hetu-app://shell/task-view.html";
      } catch (error) {
        if (active) setError(typeof (error as Error)?.message === "string" ? (error as Error).message : String(error));
      }
    })();
    return () => {
      active = false;
      clearTimeout(timer);
      appearanceObserver.disconnect();
      systemTheme.removeEventListener("change", syncTheme);
      iframe.removeAttribute("srcdoc");
      iframe.src = "about:blank";
      void bridge.close().catch(() => {});
    };
  }, [task, refresh, submissionId, workKind,work]);
  return (
    <>
      {!submissionId && (
        <AuthorAdoption task_ref={task.task_ref} notify={notify} />
      )}
      {journal && journal.status !== "succeeded" && (
        <div className="recover">
          <span>
            {journal.status === "pending"
              ? "发现未确认的保存操作"
              : "上次保存未完成"}
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
      <TaskAssessment key={task.task_ref.task_id+(submissionId??"")} work={work} taskRef={task.task_ref} submissionId={submissionId} language={preferences.language}/>
      <iframe
        ref={frame}
        title="任务候选审阅"
        sandbox="allow-scripts"
        className="task-frame"
      />
    </>
  );
}
