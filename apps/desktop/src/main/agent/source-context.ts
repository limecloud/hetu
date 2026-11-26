import {isDeepStrictEqual} from "node:util";
import {sameWork, type WorkRef} from "@hetu/plugin-sdk";

type Read = (action: string, input: Record<string, unknown>) => Promise<any>;
const digest = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function fields(object: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(object).some(key => !allowed.includes(key))) throw Error("上下文包含不支持的来源字段。");
}

/** 来源只消费既有领域读取，不把会话投影升级成任务或专业成果事实。 */
export async function taskSourceContext(work: WorkRef, object: Record<string, any>, read: Read) {
  fields(object, ["task_ref", "submission_id", "working_copy_ref", "feedback_ref"]);
  const task = await read("hetu.creative_tasks.get", {task_ref: object.task_ref, detail:"review", ...(object.submission_id ? {submission_id: object.submission_id} : {})});
  if (task.observation.state === "closed") throw Error("任务已关闭，请在原任务中查看历史。");
  const owner = task.request.input_snapshot.scope_context?.work_ref;
  if (owner ? !sameWork(owner, work) : !await legacyTaskInWork(work, object.task_ref, read))
    throw Error("参考稿或公开意见不属于当前作品。");
  if (!digest(task.request_sha256)) throw Error("任务请求摘要无效。");
  const task_ref = {scope_ref: task.request.scope_ref, task_id: task.request.task_id, request_revision: task.request.request_revision};
  if (!isDeepStrictEqual(task_ref, object.task_ref)) throw Error("任务引用与固定请求不一致。");
  const fixed_refs: Record<string, any>[] = [{kind: "task_request", task_ref, task_locator: {scope_ref: task_ref.scope_ref, task_id: task_ref.task_id}, sha256: task.request_sha256}];
  if (task.submission && object.submission_id !== null) {
    const fixed = task.submission_ref;
    if (!fixed || fixed.submission_id!==task.submission.submission_id || !digest(fixed.sha256)) throw Error("参考稿批次摘要无效。");
    fixed_refs.push({kind: "task_submission", task_ref, submission_id: fixed.submission_id, sha256: fixed.sha256});
  }
  if (object.working_copy_ref) {
    const copy = await read("hetu.working_copies.get", {task_ref, working_copy_ref: object.working_copy_ref,detail:"summary"});
    if (!isDeepStrictEqual(copy.working_copy_ref, object.working_copy_ref) || !isDeepStrictEqual(copy.working_copy.task_ref, task_ref)
      || copy.revision.sha256 !== object.working_copy_ref.sha256) throw Error("参考稿修订与固定来源不一致。");
    fixed_refs.push({kind: "working_copy", task_ref, working_copy_ref: copy.working_copy_ref});
  }
  const feedback_ref = Object.hasOwn(object, "feedback_ref") ? object.feedback_ref : task.feedback_head;
  if (feedback_ref) {
    const page = await read("hetu.task_feedback.list", {task_ref, feedback_ref, limit: 1, result_path: "/feedback/0/feedback_ref", max_bytes: 1024});
    if (!isDeepStrictEqual(page.feedback_page?.value, feedback_ref)) throw Error("当前任务没有这条固定公开意见。");
    fixed_refs.push({kind: "task_feedback", task_ref, feedback_ref});
  }
  return {fixed_refs};
}

async function legacyTaskInWork(work: WorkRef, task_ref: unknown, read: Read) {
  let cursor: string | undefined;
  do {
    const page = await read("hetu.creative_tasks.list", {work_ref: work, limit: 100, ...(cursor ? {cursor} : {})});
    if (page.tasks.some((item: any) => sameWork(item.work_ref, work) && isDeepStrictEqual(item.task_ref, task_ref))) return true;
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return false;
}

export async function pluginSourceContext(work: WorkRef, object: Record<string, any>, read: Read) {
  fields(object, ["owner_plugin_id", "object_id", "revision", "sha256"]);
  if (typeof object.owner_plugin_id !== "string" || typeof object.object_id !== "string" || !Number.isSafeInteger(object.revision)
    || object.revision < 1 || !digest(object.sha256)) throw Error("请选择确切版本的专业成果。");
  const value = await read("hetu.plugin_results.get", {work_ref: work, owner_plugin_id: object.owner_plugin_id, object_id: object.object_id, revision: object.revision});
  if (!sameWork(value.object.work_ref, work) || value.object.owner_plugin_id !== object.owner_plugin_id
    || value.object.object_id !== object.object_id || value.object.revision !== object.revision || value.sha256 !== object.sha256)
    throw Error("专业成果版本、摘要或作品不一致。");
  return {fixed_refs: [{kind: "plugin_object", work_ref: work, ...object, read_action: "hetu.plugin_results.get"}]};
}

export async function sceneSourceContext(work: WorkRef, object: Record<string, any>, read: Read) {
  fields(object, ["document_id", "revision_id", "sha256", "scene_range"]);
  const range = object.scene_range;
  if (work.kind !== "drama" || !digest(object.sha256) || !range
    || !Number.isSafeInteger(range.byte_start) || !Number.isSafeInteger(range.byte_end)
    || range.byte_start < 0 || range.byte_end <= range.byte_start) throw Error("请选择剧本中的固定场次。");
  const value = await read("hetu.documents.scene_index", {work_ref: work, ...object, max_bytes: 1024});
  if (!sameWork(value.work_ref, work) || !isDeepStrictEqual(value.document_ref,
    {document_id: object.document_id, revision_id: object.revision_id, sha256: object.sha256})
    || !isDeepStrictEqual(value.scene?.range, range)) throw Error("场次原稿、摘要或范围不一致。");
  return {fixed_refs: [{kind: "document_scene", work_ref: work, ...object, read_action: "hetu.documents.scene_index"}]};
}

export async function videoSourceContext(work: WorkRef, object: Record<string, any>, read: Read) {
  const media = Object.hasOwn(object, "media_ref");
  fields(object, media ? ["media_ref"] : ["video_episode_id", "revision", "sha256"]);
  if (work.kind !== "video" || (!media && (!Number.isSafeInteger(object.revision) || object.revision < 1 || !digest(object.sha256))))
    throw Error("请选择当前视频的固定分集或成果。");
  const selected = media ? {media_ref: object.media_ref} : {video_episode_id: object.video_episode_id, revision: object.revision};
  const value = await read("hetu.handoffs.get", {view_kind: "video", object_ref: {work_ref: work, ...selected}});
  const fixed = value.fixed_refs?.filter((item: any) => item.kind === (media ? "video_media" : "video_episode"));
  if (!Array.isArray(fixed) || fixed.length !== 1 || !digest(fixed[0].sha256)
    || (media ? !isDeepStrictEqual(fixed[0].media_ref, object.media_ref) || fixed[0].sha256 !== object.media_ref?.sha256
      : fixed[0].video_episode_id !== object.video_episode_id || fixed[0].revision !== object.revision || fixed[0].sha256 !== object.sha256))
    throw Error("视频来源的身份、修订或摘要不一致。");
  return {fixed_refs: [{...fixed[0], work_ref: work, read_action: media ? "hetu.video.media.get" : "hetu.video.episodes.get"}]};
}
