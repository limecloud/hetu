export type TaskRef = { scope_ref: { kind: string; id: string }; task_id: string; request_revision: number; sha256?: string };
export type FeedbackRef = { feedback_id: string; sha256: string };
export const sameTask = (a: TaskRef, b: TaskRef) => a.task_id === b.task_id && a.request_revision === b.request_revision && a.sha256 === b.sha256 && a.scope_ref.kind === b.scope_ref.kind && a.scope_ref.id === b.scope_ref.id;

/** 只交接公开固定引用；读取权限及作者决定仍由原领域用例核验。 */
export function continuationText(task: TaskRef, feedback: FeedbackRef, locale: string) {
  const locator = JSON.stringify({ scope_ref: task.scope_ref, task_id: task.task_id });
  const fixed = JSON.stringify(feedback), request = JSON.stringify(task);
  return locale === "en"
    ? `Continue the same Hetu Luoshu task. Open task_locator ${locator} using the available task connection and verify the fixed task_ref ${request}. Read feedback ${fixed} and its fixed targets with hetu_list_task_feedback. Continue the working copy and include handled feedback_refs when saving and submitting. Preserve the author's requested sections. Do not create a duplicate task, overwrite author text, adopt or finalize.`
    : `继续河图洛书原任务。通过当前可用任务连接打开 task_locator：${locator}，核对固定请求 task_ref：${request}。用 hetu_list_task_feedback 读取公开意见 ${fixed} 及其固定成果，沿原参考稿返工。保留作者要求的部分，保存与提交时引用实际处理的 feedback_refs。不要重建任务、覆盖作者正文、采纳或定稿。`;
}
