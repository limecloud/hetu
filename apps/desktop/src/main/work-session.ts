import path from "node:path";
import { sameWork, type WorkRef } from "@hetu/plugin-sdk";
import type { AppServer } from "./rpc.ts";
import { RecoveryStore } from "./recovery.ts";
import { CoverReview } from "./covers.ts";
import { NovelDetails } from "./novel-details.ts";
import { CanonReview } from "./canon.ts";
import { TaskReview, type TaskRef } from "./task-review.ts";
import { Authoring } from "./authoring.ts";
import { ManagementReview } from "./management.ts";
import { VersionReview } from "./versions.ts";
import { ResourceReview } from "./resources.ts";
import { MediaAccess } from "./media.ts";
import { VideoReview } from "./video-review.ts";
import { OutlineReview } from "./outlines.ts";

export type WorkSessionPorts = {
  profile: string; recovery: RecoveryStore;
  active(): boolean;
  scopedReview(action: string, input: Record<string, unknown>): Promise<any>;
  confirm(message: string, detail: string, accept?: string): Promise<boolean>;
  chooseFile(options: any): Promise<string | undefined>;
  saveFile(options: any): Promise<string | undefined>;
  agentClient(): string;
  collaborationContext(client: string): any;
  coreCliBinary(): string;
  copy(text: string): void;
};

/** 共享作品应用用例；Electron与MCP工作台只替换宿主IO，不复制审核和编辑规则。 */
export function createWorkSession(ref: WorkRef, selectedServer: AppServer, ports: WorkSessionPorts) {
  const { recovery, active, scopedReview, agentClient, collaborationContext, coreCliBinary } = ports;
  const work = ref;
  const clipboard = { writeText: (text: string) => ports.copy(text) };
  const confirm = (options: any) => ports.confirm(options.message,options.detail,options.buttons?.[1]);
  const handlers = new Map<string, (...args:any[])=>any>();
  const shellHandler = (name: string, handler: (...args:any[])=>any) => handlers.set(name.slice(8), handler);
  let taskReview: TaskReview, authoring: Authoring, management: ManagementReview, versions: VersionReview, resources: ResourceReview, media: MediaAccess;
  let videoReview: VideoReview | undefined, outlineReview: OutlineReview | undefined, covers: CoverReview | undefined, novelDetails: NovelDetails | undefined, canon: CanonReview;
      media = new MediaAccess(ref, selectedServer,
        () => active());
      taskReview = new TaskReview(
        ref,
        path.join(ports.profile, "task-buffers"),
        recovery,
        (action, input) =>
          selectedServer.request("workspace/request", {
            action,
            input,
            contract_revision: "1",
          }),
        () =>
          active(),
      );
      authoring = new Authoring(
        ref,
        path.join(ports.profile, "author-buffers"),
        recovery,
        (action, input) =>
          selectedServer.request("workspace/request", {
            action,
            input,
            contract_revision: "1",
          }),
        () =>
          active(),
      );
      outlineReview = ref.kind === "novel" ? new OutlineReview(ref, path.join(ports.profile, "outline-review"), recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => active()) : undefined;
      videoReview = ref.kind === "video" ? new VideoReview(ref, path.join(ports.profile, "video-review"), recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => active(),
        (method, input) => selectedServer.request(method, input)) : undefined;
      resources = new ResourceReview(
        ref,
        path.join(ports.profile, "resource-buffers"),
        recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => active(),
      );
      canon = new CanonReview(
        ref, path.join(ports.profile, "canon-decisions"), recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => active(),
      );
      novelDetails = ref.kind === "novel" ? new NovelDetails(
        ref, path.join(ports.profile, "novel-decisions"), recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => active(),
      ) : undefined;
      covers = ref.kind === "novel" ? new CoverReview(
        ref, path.join(ports.profile, "cover-decisions"), recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => active(),
      ) : undefined;
      versions = new VersionReview(
        ref, path.join(ports.profile, "version-decisions"), recovery,
        (action, input) => selectedServer.request("workspace/request", { action, input, contract_revision: "1" }),
        () => active(),
      );
      management = new ManagementReview(
        ref,
        path.join(ports.profile, "management-buffers"),
        recovery,
        scopedReview,
        (action, input) =>
          selectedServer.request("workspace/request", {
            action,
            input,
            contract_revision: "1",
          }),
        () =>
          active(),
      );
    shellHandler(
      "desktop:tasks",
      (method: string, ref?: TaskRef, params?: any) => {
        if (!taskReview) throw new Error("请先选择当前作品。");
        if (method === "list") return taskReview.list(params?.cursor);
        if (!ref) throw new Error("缺少确切任务引用。");
        if (method === "journal") return taskReview.journal(ref);
        if (method === "recover") return taskReview.recover(ref);
        if (method === "call")
          return taskReview.call(ref, params.name, params.arguments);
        if (method === "resource") return taskReview.resource(ref, params.uri);
        throw new Error("未知任务审阅能力。");
      },
    );
    shellHandler(
      "desktop:read",
      async (action: string, input: Record<string, unknown>) => {
        if (!authoring) throw new Error("请选择当前作品。");
        return authoring.read(action, input);
      },
    );
    shellHandler("desktop:canon", async (method: string, input: any = {}) => {
      const current = canon;
      if (!current) throw new Error("请选择当前作品。");
      if (method === "get") return current.get(input.revision);
      if (method === "preview") return current.preview(input);
      if (method === "save") return current.save(input);
      if (method === "lock") return current.lock(input);
      if (method === "recover") return current.recover();
      if (method === "acknowledge") return current.acknowledge();
      throw new Error("未知设定用例。");
    });
    shellHandler("desktop:novel", async (method: string, input: any = {}) => {
      const current = novelDetails;
      if (!current) throw new Error("请选择当前小说。");
      if (method === "get") return current.get();
      if (method === "save") return current.save(input);
      if (method === "recover") return current.recover();
      if (method === "acknowledge") return current.acknowledge();
      throw new Error("未知小说编辑用例。");
    });
    shellHandler("desktop:covers", async (method: string, input: any = {}) => {
      const current = covers;
      if (!current) throw new Error("请选择当前小说。");
      if (method === "get") return current.get(input.revision);
      if (method === "requests") return current.requests(input.cursor);
      if (method === "candidates") return current.candidates(input.request_id);
      if (method === "prepare") return current.prepare(input);
      if (method === "commit") return current.commit(input.token);
      if (method === "recover") return current.recover();
      if (method === "acknowledge") return current.acknowledge();
      if (method === "choose_file") {
        const selected = await ports.chooseFile({ title: "选择封面图片", properties: ["openFile"], filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }] });
        return selected ? current.chooseFile(selected) : null;
      }
      throw new Error("未知封面用例。");
    });
    shellHandler("desktop:outlines", async (method: string, input: any = {}) => {
      const current = outlineReview;
      if (!current) throw new Error("请选择当前小说。");
      if (method === "get") return current.get();
      if (method === "save") return current.save(input);
      if (method === "draft") return current.draft(input.value);
      if (method === "recover") return current.recover();
      throw new Error("未知大纲用例。");
    });
    shellHandler("desktop:video", async (method: string, input: any = {}) => {
      const current = videoReview;
      if (!current) throw new Error("请选择当前视频作品。");
      if (["list", "media", "feedback", "delivery"].includes(method)) return current.read(method, input);
      if (method === "save_feedback") return current.saveFeedback(input);
      if (method === "journal") return current.journal();
      if (method === "recover") return current.recover();
      if (method === "draft") return current.draft(input.media_ref, input.value);
      if (method === "export") return current.exportFile(input.media_ref, async name => {
        return ports.saveFile({ title: "导出本版视频", defaultPath: name });
      });
      throw new Error("未知视频审阅用例。");
    });
    shellHandler("desktop:media", async (method: string, input: any = {}) => {
      if (!media) throw new Error("请选择当前作品。");
      if (method === "open") return media.open(input);
      if (method === "release") return media.release(input.url);
      throw new Error("未知媒体预览用例。");
    });
    shellHandler("desktop:resources", async (method: string, input: any = {}) => {
      const current = resources;
      if (!current) throw new Error("请选择当前作品。");
      if (method === "list") return current.list(input);
      if (method === "get") return current.get(input.resource_id, input.revision);
      if (method === "draft") return current.draft(input.resource_id, input.value);
      if (method === "usages") return current.usages(input.resource_id, input.cursor);
      if (method === "prepare") return current.prepare(input.resource_id, input.revision, input.sha256, input.kind, input.edits);
      if (method === "recover") return current.recover(input.resource_id);
      if (method === "acknowledge") return current.acknowledge(input.resource_id, input.operation_key);
      if (method === "commit") {
        const prepared = current.prepared(input.token);
        const answer = await confirm({
          type: "question", buttons: ["取消", "确认资料决定"], defaultId: 0, cancelId: 0,
          message: prepared.decision.title + "？",
          detail: "仅提交已审阅的资料版本。历史与使用位置保留，后来的修改将阻止覆盖。",
        });
        if (!answer) throw new Error("已取消资料决定。");
        return current.commit(input.token);
      }
      throw new Error("未知资料用例。");
    });
    shellHandler("desktop:versions", async (method: string, input: any = {}) => {
      const current = versions;
      if (!current) throw new Error("请选择当前作品。");
      if (method === "journal") return current.journal();
      if (method === "prepare") return current.prepare(input.snapshot_id, input.snapshot_sha256);
      if (method === "recover") return current.recover();
      if (method === "acknowledge") return current.acknowledge(input.operation_key);
      if (method === "commit") {
        const preview = current.prepared(input.token);
        const answer = await confirm({
          type: "question", buttons: ["取消", "批准此版本"], defaultId: 0, cancelId: 0,
          message: "批准「" + preview.view.snapshot.message + "」？",
          detail: "仅批准已审阅的固定文稿差异。由 Agent 执行提交；当前正文、未保存稿和工作区分支保持。",
        });
        if (!answer) throw new Error("已取消版本批准。");
        return current.commit(input.token);
      }
      if (method === "continue") {
        const view = await current.read("snapshot", { snapshot_id: input.snapshot_id });
        if (view.snapshot_sha256 !== input.snapshot_sha256) throw new Error("快照摘要已变化。");
        const context = collaborationContext(agentClient()), access = await context.status();
        if (!access.authorized) throw new Error("请先授权当前作品的 Agent 连接。");
        context.check();
        clipboard.writeText("请接续当前作品的固定文稿版本。先回读快照与执行状态；批准不等于执行。若已有执行键，必须沿原键恢复，不重复提交。\n" + JSON.stringify({
          core_cli: coreCliBinary(), client_adapter: context.client,
          ...(process.env.HETU_COLLABORATION_DIR ? { collaboration_directory: process.env.HETU_COLLABORATION_DIR } : {}),
          management_ref: access.management_ref, work_ref: view.snapshot.work_ref,
          snapshot_id: view.snapshot.snapshot_id, snapshot_sha256: view.snapshot_sha256,
          execute_action: "hetu.git.snapshot", phase: "execute",
          suggested_first_execution_key: "execute-" + view.snapshot.snapshot_id,
        }, null, 2));
        return { copied: true };
      }
      return current.read(method, input);
    });
    shellHandler("desktop:author", async (method: string, input: any) => {
      const current = authoring,
        tasks = taskReview;
      if (!current || !tasks) throw new Error("请选择当前作品。");
      if (method === "adoption_options")
        return current.adoptionOptions(
          await tasks.candidate(input.task_ref, input.candidate_id),
          input.task_ref,
        );
      if (method === "adoption")
        return current.adoption(
          await tasks.candidate(input.task_ref, input.candidate_id),
          input.task_ref,
          input.new_target,
        );
      if (method === "adoption_context")
        return current.adoptionContext(
          await tasks.candidate(input.task_ref, input.candidate_id),
          input.task_ref,
        );
      if (method === "adoption_partial")
        return current.adoptionPartial(input.token, input.source, input.target);
      if (method === "check") return current.check(input.document_id);
      if (method === "finalization")
        return current.finalization(
          input.document_id,
          input.report_ref,
          input.comments,
          input.coverage,
        );
      if (method === "withdrawal")
        return current.withdrawal(input.document_id, input.reason);
      if (method === "journal") return current.journal(input.document_id);
      if (method === "acknowledge")
        return current.acknowledge(input.document_id, input.operation_key);
      if (method === "recover") return current.recover(input.document_id);
      if (method === "new_adoption_journal")
        return current.journal(input.task_ref);
      if (method === "new_adoption_recover")
        return current.recover(input.task_ref);
      if (method === "new_adoption_acknowledge")
        return current.acknowledge(input.task_ref, input.operation_key);
      if (method === "commit") {
        const prepared = current.prepared(input.token);
        const decision = await confirm({
          type: "question",
          buttons: ["取消", "确认"],
          defaultId: 0,
          cancelId: 0,
          message: prepared.title + "？",
          detail:
            "仅提交刚才审阅的固定预览。并发变化将阻止提交，历史修订与来源继续保留。",
        });
        if (!decision)
          throw new Error("已取消，作品保持原状态。");
        return current.commit(input.token);
      }
      throw new Error("未知作者用例。");
    });
    shellHandler(
      "desktop:management",
      async (method: string, input: any = {}) => {
        const current = management;
        if (!current) throw new Error("请选择当前作品。");
        if (method === "list") return current.list(input.cursor);
        if (method === "get")
          return current.get(input.proposal_id, input.proposal_sha256);
        if (method === "verify")
          return current.verify(input.proposal_id, input.proposal_sha256);
        if (method === "prepare")
          return current.prepare(
            input.proposal_id,
            input.proposal_sha256,
            input.state_revision,
            input.decision,
          );
        if (method === "recover") return current.recover(input.proposal_id);
        if (method === "acknowledge")
          return current.acknowledge(input.proposal_id, input.operation_key);
        if (method === "commit") {
          const prepared = current.prepared(input.token);
          const answer = await confirm({
            type: "question",
            buttons: ["取消", "确认决定"],
            defaultId: 0,
            cancelId: 0,
            message: prepared.decision.title + "？",
            detail:
              "仅确认刚才审阅的固定方案。批准后由外部 Agent 执行；作品或审核状态变化将阻止提交。",
          });
          if (!answer) throw new Error("已取消审核决定。");
          return current.commit(input.token);
        }
        if (method === "continue") {
          const view = await current.get(
            input.proposal_id,
            input.proposal_sha256,
          );
          if (view.state !== "approved" || !view.is_current || view.is_expired)
            throw new Error(
              "当前方案尚未获批、已过期或基线已变化，请刷新核对。",
            );
          const context = collaborationContext(agentClient()),
            status = await context.status();
          if (!status.authorized) throw new Error("当前作品授权已撤销。");
          const request = {
            client_adapter: context.client,
            management_ref: status.management_ref,
            work_ref: context.work,
            core_cli: coreCliBinary(),
            ...(process.env.HETU_COLLABORATION_DIR
              ? { collaboration_directory: process.env.HETU_COLLABORATION_DIR }
              : {}),
            action: "hetu.agent_operations.execute",
            input: {
              proposal_id: view.proposal_id,
              proposal_sha256: view.proposal_sha256,
              operation_key:
                "execute-" + view.proposal_id + "-" + view.proposal_sha256,
            },
          };
          context.check();
          clipboard.writeText(
            "请以当前客户端的精确管理授权执行已批准的固定方案；保留此原键，未知结果先回读，不重新准备或更换输入。执行后回读作品并告诉我结果。\n" +
              JSON.stringify(request, null, 2),
          );
          return { copied: true };
        }
        throw new Error("未知管理方案用例。");
      },
    );
    shellHandler(
      "desktop:buffer",
      async (document_id: string, value: unknown, kind = "document") => {
        if (!work || !/^doc_[a-f0-9-]{36}$/.test(document_id))
          throw new Error("编辑对象无效。");
        if (!["document", "annotations"].includes(kind))
          throw new Error("恢复稿类型无效。");
        const name = path.join(
          ports.profile,
          "buffers",
          work.workspace_id,
          work.object_id,
          document_id +
            (kind === "annotations" ? ".annotations" : "") +
            ".json",
        );
        if (value === undefined) return recovery.read(name);
        // 正文恢复同时含编辑稿、原基线和固定待提交输入，覆盖三份合法长文。
        await recovery.write(
          name,
          value,
          (kind === "document" ? 16 : 4) * 1024 * 1024,
        );
        return true;
      },
    );

  return { taskReview, authoring, management, versions, resources, media, videoReview, outlineReview, covers, novelDetails, canon,
    async call(method: string, args: any[]) {
      if (!active()) throw new Error("作品上下文已变化，请重新打开对应作品。");
      const handler = handlers.get(method);
      if (!handler) throw new Error("未知工作台用例。");
      return handler(...args);
    },
    async dispose() { await media.dispose(); await recovery.flush(); },
  };
}
export type WorkSession = ReturnType<typeof createWorkSession>;
