import type { RecordValue, WorkRef } from "./gateway.ts";
import type { DetailLink } from "./domains.ts";

/** 按固定对象补齐领域往返；不推断当前作品、不从标题猜引用。 */
export function relatedViews(action: string, data: RecordValue, input: RecordValue, work?: WorkRef): DetailLink[] {
  const links: DetailLink[] = [];
  const add = (label: string, action: string, input: RecordValue = {}) => links.push({ label, action, input });
  const record = (key: string) => data[key] && typeof data[key] === "object" ? data[key] as RecordValue : {};
  const rows = (key: string) => Array.isArray(data[key]) ? data[key] as RecordValue[] : [];
  const document = record("document"), episode = record("episode"), media = record("media");
  if (action === "hetu.works.get") {
    if(work?.kind === "novel") { add("查看小说卷章", "hetu.novels.get"); add("查看作品封面", "hetu.covers.get"); }
    if(work?.kind === "drama") add("查看剧本分集", "hetu.drama.projects.get", {project_id:work.object_id});
    if(work?.kind === "video") add("查看视频分集", "hetu.video.projects.get", {video_project_id:work.object_id});
  }
  if(action === "hetu.covers.get") { add("查看封面任务", "hetu.covers.list_requests", {limit:20}); add("查看封面准备记录", "hetu.covers.list_preparations", {limit:20}); }
  if(action === "hetu.novels.get") add("查看完整正文目录", "hetu.documents.list", {limit:50});
  if(action === "hetu.drama.projects.get") add("查看剧本骨架与场次", "hetu.drama.list_skeletons", {limit:20});
  if(action === "hetu.drama.get_skeleton") {
    const skeleton=record("skeleton");if(skeleton.skeleton_id)add("查看原著对照记录", "hetu.drama.list_comparisons", {skeleton_id:skeleton.skeleton_id,limit:20});
  }
  if(action === "hetu.documents.get" && document.document_id) {
    add("查看文稿修订", "hetu.documents.history", {document_id:document.document_id,limit:20});
    if(work?.kind === "drama")add("查看原著与场次映射", "hetu.drama.get_script_mapping", {document_id:document.document_id});
  }
  if(action === "hetu.drama.episodes.get" && episode.document_id) {
    add("阅读作者稿", "hetu.documents.get", {document_id:episode.document_id});
    add("查看分集修订", "hetu.documents.history", {document_id:episode.document_id,limit:20});
    add("查看原著与场次映射", "hetu.drama.get_script_mapping", {document_id:episode.document_id});
  }
  if(action === "hetu.documents.history" && input.document_id)for(const revision of rows("revisions"))if(revision.revision_id)add(`阅读${String(revision.created_at??"历史")}修订`, "hetu.documents.get", {document_id:input.document_id,revision_id:revision.revision_id});
  if(action === "hetu.resources.get") {const resource=record("resource");if(resource.resource_id)add("查看资料使用位置", "hetu.resource_usages.list", {resource_id:resource.resource_id,limit:20});}
  if(action === "hetu.video.episodes.get" && episode.video_episode_id)add("查看本集媒体成果", "hetu.video.media.list", {video_episode_id:episode.video_episode_id,limit:20});
  if(action === "hetu.video.media.get" && data.media_ref) {
    add("查看本版修改意见", "hetu.video.feedback.list", {media_ref:data.media_ref,limit:20});
    add("查看固定交付清单", "hetu.video.delivery.preview", {media_refs:[data.media_ref]});
    if(media.previous_media_ref)add("比较前版视频", "hetu.video.media.get", {media_ref:media.previous_media_ref});
  }
  if(action === "hetu.git.status" && data.initialized !== false) {
    add("查看版本历史", "hetu.git.log", {limit:20});add("查看待审快照", "hetu.git.list_snapshots", {limit:20});add("查看版本线", "hetu.git.references");
    for(const [index,change] of rows("changes").entries())if(typeof change.path === "string")add(`比较文稿 ${index+1}`, "hetu.git.diff", {path:change.path,max_bytes:12000});
  }
  if(action === "hetu.git.get_snapshot") {
    const snapshot=record("snapshot");
    const selection=Array.isArray(snapshot.selection)?snapshot.selection as RecordValue[]:[];
    for(const [index,item] of selection.entries())if(typeof item.path === "string")add(`比较快照文稿 ${index+1}`, "hetu.git.snapshot_diff", {snapshot_id:snapshot.snapshot_id??input.snapshot_id,path:item.path,max_bytes:12000});
  }
  if(action === "hetu.git.read_version" && !input.path)for(const [index,file] of rows("files").entries())if(typeof file.path === "string"&&/\.(md|fountain)$/.test(file.path))add(String(file.title??`阅读历史文稿 ${index+1}`), "hetu.git.read_version", {commit_id:data.commit_id??input.commit_id,path:file.path,max_bytes:12000});
  if(action === "hetu.local_settings.get")add("核对Codex连接", "hetu.local_settings.inspect_connection", {agent_client:"codex"});
  return links;
}
