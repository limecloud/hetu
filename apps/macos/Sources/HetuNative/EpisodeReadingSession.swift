import CryptoKit
import Foundation
import HetuCore
import Observation

/// 分集页与验收共用的只读旅程。选择参考稿不触碰作者编辑缓冲。
@MainActor @Observable public final class EpisodeReadingSession {
    public private(set) var episode: JSONValue = .null
    public private(set) var content = ""
    public private(set) var selection = -1
    public private(set) var loading = false
    public private(set) var error: String?
    private let model: WorkspaceModel
    private var generation = 0
    public init(model: WorkspaceModel) { self.model = model }
    public var references: [JSONValue] { episode["manuscript"]["references"].array }
    public var selectedReference: JSONValue { references.indices.contains(selection) ? references[selection] : .null }
    public var isAuthor: Bool { selection == -1 }

    public func clear() {
        generation += 1
        episode = .null; content = ""; selection = -1; loading = false; error = nil
    }

    public func load(_ episodeID: String, revision: Int64? = nil) async {
        generation += 1; let request = generation
        loading = true; content = ""; error = nil; episode = .null
        var input: [String: JSONValue] = ["episode_id": .string(episodeID)]
        if let revision { input["revision"] = .integer(revision) }
        let result = await model.workspaceAction("hetu.drama.episodes.get", input: input, onFailure: { message, _ in
            if self.generation == request { self.error = message }
        })
        guard request == generation else { return }
        guard let result else { loading = false; return }
        episode = result
        let preferred = result["manuscript"]["author_has_content"].bool == true ? -1
            : references.firstIndex(where: { $0["kind"].string == "submitted" }) ?? (references.isEmpty ? -1 : 0)
        await select(preferred)
    }

    public func select(_ index: Int) async {
        guard episode != .null, index == -1 || references.indices.contains(index) else { return }
        generation += 1; let request = generation
        selection = index; loading = true; error = nil; content = ""
        let reference = selectedReference
        let action: String, input: [String: JSONValue], expected: JSONValue
        if isAuthor {
            let fixed = episode["manuscript"]["author_ref"]
            action = "hetu.documents.get"; expected = fixed["sha256"]
            input = ["document_id": fixed["document_id"], "revision_id": fixed["revision_id"]]
        } else if reference["kind"].string == "submitted" {
            action = "hetu.drafts.get"; expected = reference["sha256"]
            input = ["draft_id": reference["draft_ref"]["draft_id"]]
        } else {
            action = "hetu.working_copies.get"; expected = reference["sha256"]
            input = ["task_ref": reference["task_ref"], "working_copy_ref": reference["working_copy_ref"]]
        }
        let result = await model.workspaceAction(action, input: input, onFailure: { message, _ in
            if self.generation == request { self.error = message }
        })
        guard request == generation else { return }
        defer { loading = false }
        guard let result else { return }
        let text = action == "hetu.working_copies.get" ? result["revision"]["content"].string : result["content"].string
        guard let text, expected.string == SHA256.hash(data: Data(text.utf8)).map({ String(format: "%02x", $0) }).joined() else {
            error = model.t("drama.reading_integrity"); return
        }
        content = text
    }
}
