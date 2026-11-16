export type ArtworkSubject =
  | { kind: "entity"; entity_ref: string; blueprint_revision?: number }
  | { kind: "document"; document_id: string; revision_id?: string };

export type Artwork = {
  task: any;
  submission_id: string;
  candidate: any;
  preview: any;
  provenance: any;
  received_at: string;
  category: string;
};

export function artworkKey(item: Artwork) {
  return `${item.task.task_ref.task_id}/${item.submission_id}/${item.candidate.candidate_id}`;
}

export function artworkPreview(preview: any) {
  if (preview?.media_type !== "image/jpeg" || typeof preview.base64 !== "string"
    || preview.base64.length > 350000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(preview.base64)) return undefined;
  return `data:image/jpeg;base64,${preview.base64}`;
}

export function artworkMatches(item: Artwork, subject?: ArtworkSubject) {
  return !subject || item.candidate.subject_refs?.some((ref: any) =>
    ref.kind === subject.kind && (subject.kind === "entity"
      ? ref.entity_ref === subject.entity_ref : ref.document_id === subject.document_id));
}

/** 目录页可能只有文字任务，不能据此判断作品没有图片。 */
export async function readArtworkPage(
  read: (method: "list" | "view", input?: any) => Promise<any>,
  cursor?: string,
  active: () => boolean = () => true,
) {
  const items: Artwork[] = [], errors: string[] = [], visited = new Set<string>();
  let next = cursor;
  do {
    const page = await read("list", { cursor: next });
    if (!active()) return undefined;
    for (const task of page.tasks) {
      if (!["artwork", "cover"].includes(task.task_kind) || !task.submission_count) continue;
      try {
        const value = await read("view", task.task_ref);
        if (!active()) return undefined;
        for (const candidate of value.submission?.candidates ?? []) {
          if (candidate.kind !== "image") continue;
          items.push({ task, submission_id: value.submission.submission_id, candidate,
            preview: value.image_previews?.find((p: any) => p.candidate_id === candidate.candidate_id),
            provenance: value.submission.provenance, received_at: value.submission.received_at,
            category: task.task_kind === "cover" ? "cover" : candidate.image_category ?? "other" });
        }
      } catch (error) {
        if (!active()) return undefined;
        errors.push(`${task.brief}：${(error as Error).message}`);
      }
    }
    next = page.next_cursor ?? undefined;
    if (next && visited.has(next)) throw new Error("图片目录游标未前进，请刷新后重试。");
    if (next) visited.add(next);
  } while (!items.length && next);
  return { items, errors, cursor: next };
}

export function mergeArtwork(previous: Artwork[], incoming: Artwork[]) {
  return [...new Map([...previous, ...incoming].map(item => [artworkKey(item), item])).values()]
    .sort((a, b) => b.received_at.localeCompare(a.received_at));
}
