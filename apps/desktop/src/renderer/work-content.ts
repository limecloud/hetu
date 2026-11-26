import type { WorkRef } from "@hetu/plugin-sdk";
import { desktop, data } from "./bridge.ts";
export type DocumentGroup = { title: string; documents: any[]; episode_id?: string };

/** 使用真实目录身份与顺序组织完整分页，未归入结构的稿件仍保留。 */
export async function readWorkContent(
  work: WorkRef,
  options: { includeDocuments?: boolean; active?: () => boolean; onSnapshot?: (snapshot: any) => void } = {},
): Promise<{
  summary: any;
  record: any;
  documents: any[];
  groups: DocumentGroup[];
  project: any;
}> {
  const includeDocuments = options.includeDocuments !== false;
  const read = async (action: string, input: Record<string, unknown>) => {
    if (options.active?.() === false) throw new Error("当前读取已结束。");
    const value = data(await desktop.read(action, input));
    if (options.active?.() === false) throw new Error("当前读取已结束。");
    return value;
  };
  const start = await read("hetu.works.get", { work_ref: work });
  options.onSnapshot?.(start);
  const documents: any[] = [];
  let cursor: string | undefined;
  if (includeDocuments && work.kind !== "video")
    do {
      const page = await read("hetu.documents.list", {
          work_ref: work,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
      documents.push(...page.documents);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  const project =
    work.kind === "drama"
      ? await read("hetu.drama.projects.get", {
            project_id: work.object_id,
          })
      : work.kind === "video"
        ? await read("hetu.video.projects.get", {
              video_project_id: work.object_id,
            })
        : undefined;
  const end = await read("hetu.works.get", { work_ref: work });
  if (
    JSON.stringify(start.summary.fixed_ref) !==
      JSON.stringify(end.summary.fixed_ref) ||
    (project && project.sha256 !== end.summary.fixed_ref.sha256)
  )
    throw new Error("作品结构在读取期间已有变化，请刷新后重新读取。");
  const index = new Map(documents.map((item) => [item.document_id, item])),
    used = new Set<string>(),
    groups: DocumentGroup[] = [];
  function append(title: string, ids: string[], episode_id?: string) {
    const items = ids.map((id) => index.get(id)).filter(Boolean);
    items.forEach((item) => used.add(item.document_id));
    if (items.length) groups.push({ title, documents: items, ...(episode_id ? {episode_id} : {}) });
  }
  if (includeDocuments) {
    if (work.kind === "novel") {
      append(
        end.record.volumes.length ? "未分卷" : "章节",
        end.record.chapters
          .filter((chapter: any) => chapter.volume_id === null)
          .map((chapter: any) => chapter.document_id),
      );
      for (const volume of end.record.volumes)
        append(
          volume.title,
          end.record.chapters
            .filter((chapter: any) => chapter.volume_id === volume.volume_id)
            .map((chapter: any) => chapter.document_id),
        );
    } else if (work.kind === "drama") {
      for (const item of project.episodes) {
        const document = index.get(item.episode.document_id);
        if (document) document.episode_id = item.episode.episode_id;
        append(/^第\s*[\d一二三四五六七八九十百零〇两]+\s*集/.test(item.episode.title) ? item.episode.title : "第" + item.episode_number + "集 " + item.episode.title, [
          item.episode.document_id,
        ], item.episode.episode_id);
      }
    }
    append(
      groups.length ? "其他稿件" : "文稿",
      documents
        .filter((item) => !used.has(item.document_id))
        .map((item) => item.document_id),
    );
  }
  return { ...end, documents, groups, project };
}
