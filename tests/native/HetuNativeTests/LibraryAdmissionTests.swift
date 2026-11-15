import Foundation
import HetuCore
import HetuNative

enum LibraryAdmissionTests {
    struct Failure: Error { let message: String }
    private static func check(_ valid: Bool, _ message: String) throws { if !valid { throw Failure(message: message) } }
    @MainActor static func run(root: URL) async throws {
        let directory = root.appendingPathComponent("机器建书授权")
        let library = LibraryStore(directory: root.appendingPathComponent("机器接纳书库"))
        let client = CollaborationClient(clientAdapter: "codex", directory: directory)
        func call(_ action: String, _ input: [String: JSONValue]) async throws -> JSONValue {
            try await client.request(action, input: input).requiringSuccess()
        }
        var created: [JSONValue] = []
        for (key, drama) in [("novel", false), ("drama", true)] {
            let initial = try await call("hetu.creation_projects.create", ["brief": .string("雨夜旧站收到明天的车票。"), "locale": .string("zh-CN"), "operation_key": .string(key)])
            let saved = try await call("hetu.creation_projects.save", ["management_ref": initial["management_ref"], "project_id": initial["project"]["project_id"], "expected": .object(["revision": initial["revision"], "sha256": initial["sha256"]]), "brief": .string("由当前 Codex 通过机器入口整理。"), "selected_fields": .object(["title": .object(["value": .string(drama ? "雨夜旧站 剧本" : "雨夜旧站 小说"), "candidate_ref": .null])]), "work_profile": .object(["work_type": .string(drama ? "drama" : "novel"), "language_tag": .string("zh-CN"), "drama_mode": drama ? .string("original") : .null]), "operation_key": .string("save")])
            var input: [String: JSONValue] = ["management_ref": initial["management_ref"], "project_id": initial["project"]["project_id"], "expected": .object(["revision": saved["revision"], "sha256": saved["sha256"]]), "target_path": initial["target_path"], "operation_key": .string("create")]
            if drama {
                input["profile"] = .object(["title": .string("雨夜旧站 剧本"), "description": .string("原创剧本"), "mode": .string("original"), "language_tag": .string("zh-CN")])
            } else {
                input["metadata"] = .object(["title": .string("雨夜旧站 小说"), "author_name": .string("演示作者"), "synopsis": .string("一张来自明天的车票。"), "genre": .string("悬疑"), "language_tag": .string("zh-CN"), "status": .string("planning")])
            }
            created.append(try await call(drama ? "hetu.creation_projects.create_drama" : "hetu.creation_projects.create_novel", input))
        }
        try check(try await library.entries().isEmpty, "机器创建前已预建书库登记")
        try await library.receiveCreatedWorks(collaborationDirectory: directory)
        let entries = try await library.entries()
        try check(entries.count == 2 && Set(entries.map(\.contentType)) == ["novel", "drama"], "机器创建的小说或剧本未进入书库")
        try check(entries.allSatisfy { $0.lastOpenedAt == nil }, "后台接纳伪造了作者打开时间")
        for work in created {
            guard let entry = entries.first(where: { $0.workspaceID == work["workspace"]["workspace_id"].string }) else { throw Failure(message: "书库作品身份不匹配") }
            try check(try await library.resolve(entry).path == work["target_path"].string, "书库没有指向同一作品目录")
        }
        try await library.receiveCreatedWorks(collaborationDirectory: directory)
        try check(try await library.entries() == entries, "重复接纳改变最近打开时间或重复登记")
        // 未接纳即被作者撤权的记录不能进入新的书库。
        let first = created[0]
        let author = try await Workspace.open(at: URL(fileURLWithPath: first["target_path"].string!), mode: .author)
        _ = try await author.data("hetu.collaboration.revoke_management", input: ["grant_id": first["workspace_management_ref"]["grant_id"], "client_adapter": .string("codex"), "collaboration_path": .string(directory.path), "operation_key": .string("revoke")])
        let secondLibrary = LibraryStore(directory: root.appendingPathComponent("撤权后的接纳"))
        try await secondLibrary.receiveCreatedWorks(collaborationDirectory: directory)
        try check(try await secondLibrary.entries().count == 1, "撤权后的历史创建被重新接纳")
        print("机器建书自动接纳：小说/原创剧本、身份书签、原键去重、最近打开及撤权过滤通过")
    }
}
