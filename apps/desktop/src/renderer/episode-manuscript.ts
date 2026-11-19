import { desktop, data } from "./bridge.ts";

export function manuscriptKey(reference: any): string {
  return reference.kind === "submitted"
    ? `${reference.submission_id}/${reference.candidate_id}`
    : `${reference.working_copy_ref.working_copy_id}/${reference.working_copy_ref.working_revision_id}`;
}

/** 固定参考稿只读；主进程重新核对分集、作品和修订，不能当作作者正文保存。 */
export async function readEpisodeReference(episode_id: string, reference: any): Promise<string> {
  const submitted = reference.kind === "submitted";
  const value = data(await desktop.read(submitted ? "hetu.drafts.get" : "hetu.working_copies.get", {
    episode_id,
    ...(submitted ? { draft_id: reference.draft_ref.draft_id }
      : { task_ref: reference.task_ref, working_copy_ref: reference.working_copy_ref }),
  }));
  return submitted ? value.content : value.revision.content;
}
