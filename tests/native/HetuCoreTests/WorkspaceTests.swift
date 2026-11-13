import Foundation
import HetuCore

@main
struct WorkspaceBridgeTests {
static func main() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("河图 Bridge \(UUID().uuidString)")
    let author = try await Workspace.open(at: root, mode: .author, title: "中文小说", operationKey: "init")
    let created = try await author.data("hetu.documents.create", input: ["kind": .string("novel_chapter"), "title": .string("第一章"), "source_format": .string("markdown"), "content": .string("你好，河图。🌿"), "operation_key": .string("chapter")])
    let agent = try await Workspace.open(at: root, mode: .agent)
    let read = try await agent.data("hetu.documents.get", input: ["document_id": created["document"]["document_id"]])
    try check(read["content"].string == "你好，河图。🌿", "Swift ↔ Rust 未保留原始中文与 Emoji。")
    let replay = try await author.data("hetu.documents.create", input: ["kind": .string("novel_chapter"), "title": .string("第一章"), "source_format": .string("markdown"), "content": .string("你好，河图。🌿"), "operation_key": .string("chapter")])
    try check(replay == created, "Swift 重放原键未返回同一文档。")
    let denied = try await agent.request("hetu.blueprints.unlock", input: ["expected": .object(["revision": .integer(1), "sha256": .string(String(repeating: "0", count: 64))]), "reason": .string("越权"), "operation_key": .string("denied")])
    try check(denied["error"]["code"].string == "forbidden", "Swift 入口未执行作者权限校验。")
    let fixture = try await author.data("hetu.documents.create", input: ["kind": .string("novel_chapter"), "title": .string("剧情预算"), "source_format": .string("markdown"), "content": .string("# 夜\n\n林舟推开门。\n\n林舟走。"), "operation_key": .string("plot-document")])
    let plotInput: [String: JSONValue] = ["document_revisions": .array([.object(["document_id": fixture["document"]["document_id"], "revision_id": fixture["revision"]["revision_id"], "sha256": fixture["revision"]["sha256"]])]), "blueprint_revision": .integer(1), "options": .object(["max_nodes": .integer(1)]), "save_result": .bool(false)]
    let partial = try await agent.request("hetu.plot.extract", input: plotInput)
    try check(partial["status"].string == "partial", "部分提取被当成完整成功")
    do { _ = try partial.requiringSuccess(); throw CheckFailure(message: "默认桥接接受了 partial") }
    catch CoreError.business { }
    let accepted = try await agent.data("hetu.plot.extract", input: plotInput, allowPartial: true)
    try check(accepted["plot"]["coverage"]["status"].string == "partial" && accepted["saved"].bool == false, "显式部分结果缺少覆盖或改变工作区")
    // 此目录由测试独占创建，删除只回收测试作品，不触碰用户工作区。
    try FileManager.default.removeItem(at: root)
    print("Swift Bridge：中文、Emoji、原键重放与作者权限检查通过")
}
static func check(_ value: Bool, _ message: String) throws {
    guard value else { throw CheckFailure(message: message) }
}
struct CheckFailure: Error { let message: String }
}
