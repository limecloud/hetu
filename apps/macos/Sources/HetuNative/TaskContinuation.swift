import Foundation
import HetuCore

public enum TaskContinuation {
    /// 精确引用用来恢复同一任务；不复制正文、意见全文或本机授权。
    public static func prompt(task: JSONValue, feedbackRef: JSONValue, locale: String) throws -> String {
        guard task["request"]["task_id"].string != nil, task["request_sha256"].string != nil,
              feedbackRef["feedback_id"].string != nil, feedbackRef["sha256"].string != nil else { throw CreativeTaskError.invalidResult }
        let locator: JSONValue = .object(["scope_ref": task["request"]["scope_ref"], "task_id": task["request"]["task_id"]])
        let encoded = String(decoding: try locator.encoded(), as: UTF8.self)
        let feedback = String(decoding: try feedbackRef.encoded(), as: UTF8.self)
        if locale == "en" {
            return "Continue the same Hetu Luoshu task. Open task_locator \(encoded) with hetu_open_collaboration_task and use the returned exact task_ref. Read public feedback \(feedback) with hetu_list_task_feedback and its fixed targets. Continue the saved working copy, preserve requested sections, and include the handled feedback_refs when saving and submitting. Do not create a duplicate task, overwrite author text, adopt or finalize. Discover available tools first; recover unknown operations with their original keys."
        }
        return "继续河图洛书原任务。用 hetu_open_collaboration_task 打开 task_locator：\(encoded)，后续使用返回的完整 task_ref。用 hetu_list_task_feedback 读取公开意见 \(feedback) 及其指向的固定成果。沿已保存的参考稿继续修改，保留作者要求保留的部分；保存与提交时引用实际处理的 feedback_refs。不要重建同义任务、覆盖作者正文、采纳或定稿。先发现实际可用工具，未知操作沿原键恢复。"
    }
}
