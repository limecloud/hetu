import SwiftUI
import HetuCore
import HetuNative

/// 作者查看业务结果；确切参数仍可在技术详情核对。
struct AgentOperationPreview: View {
    let model: WorkspaceModel
    let proposal: JSONValue
    private var action: String { proposal["action"].string ?? "" }
    private var input: JSONValue { proposal["input"] }
    private var preview: JSONValue { proposal["preview"] }
    static func supports(_ action: String) -> Bool {
        action.hasPrefix("hetu.git.") || ["hetu.documents.export", "hetu.bundles.export", "hetu.assets.import", "hetu.assets.update", "hetu.cues.save", "hetu.resource_usages.save", "hetu.plot.correct", "hetu.drama.edit_skeleton", "hetu.image_tasks.prepare", "hetu.creative_tasks.prepare"].contains(action)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if action.hasPrefix("hetu.git.") { git }
            else if action == "hetu.documents.export" || action == "hetu.bundles.export" { delivery }
            else if action == "hetu.assets.import" || action == "hetu.assets.update" { asset }
            else if action == "hetu.creative_tasks.prepare" || action == "hetu.image_tasks.prepare" {
                Text(model.t("handoff.task_review")).foregroundStyle(WorkbenchPalette.muted)
                Text(input["brief"].string ?? "").textSelection(.enabled)
                LabeledContent(model.t("handoff.context_count"), value: String(input["input_refs"].array.count))
            } else if action == "hetu.cues.save" {
                Text(preview["cue"]["title"].string ?? "").fontWeight(.semibold)
                Text(preview["cue"]["description"].string ?? "").textSelection(.enabled)
            } else if action == "hetu.resource_usages.save" {
                Text(input["role"].string ?? "").fontWeight(.semibold)
                Text(input["source_ref"]["quote"].string ?? "").textSelection(.enabled)
            } else if action == "hetu.plot.correct" {
                ForEach(Array(preview["plot"]["nodes"].array.enumerated()), id: \.offset) { _, node in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.t("plot.kind." + (node["kind"].string ?? "action"))).fontWeight(.semibold)
                        Text(node["source_refs"].array.compactMap { $0["quote"].string }.joined(separator: "\n")).textSelection(.enabled)
                        Text(model.t("plot.verification." + (node["verification"].string ?? "needs_author_review"))).foregroundStyle(WorkbenchPalette.muted)
                    }
                }
            } else if action == "hetu.drama.edit_skeleton" {
                ForEach(Array(preview["skeleton"]["episodes"].array.enumerated()), id: \.offset) { _, episode in
                    Text(episode["title"].string ?? "").fontWeight(.semibold)
                    ForEach(Array(episode["scenes"].array.enumerated()), id: \.offset) { _, scene in
                        Text(scene["title"].string ?? "").fontWeight(.medium)
                        Text(displayName(model, reference: scene["location_ref"].string ?? "") + "  " + model.t("location." + (scene["interior_exterior"].string ?? "unknown")) + "  " + model.t("plot.time_of_day." + (scene["time_of_day"].string ?? "unknown")))
                        Text(scene["character_refs"].array.compactMap(\.string).map { displayName(model, reference: $0) }.joined(separator: model.locale == "en" ? ", " : "、")).foregroundStyle(WorkbenchPalette.muted)
                        Text(scene["adaptation_note"].string ?? "").textSelection(.enabled)
                    }
                }
            }
        }.font(.system(size: 14)).frame(maxWidth: .infinity, alignment: .leading)
    }
    private var git: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.t("git.preserve_content")).foregroundStyle(WorkbenchPalette.muted)
            if let branch = input["branch"].string { LabeledContent(model.t("git.branch"), value: branch) }
            if let current = preview["head"]["reference"].string { Text(current.replacingOccurrences(of: "refs/heads/", with: "")) }
            if let remote = preview["remote"].string { LabeledContent(model.t("git.remote"), value: remote) }
            if let url = preview["url"].string { Text(url).textSelection(.enabled) }
            if let commit = preview["target_commit"].string { Text(commit).font(.system(size: 12, design: .monospaced)).textSelection(.enabled) }
            if let message = input["message"].string { Text(message).textSelection(.enabled) }
            ForEach(Array(preview["conflicts"].array.enumerated()), id: \.offset) { _, conflict in
                Text(conflict["path"].string ?? "").fontWeight(.semibold)
                HStack(alignment: .top, spacing: 16) {
                    Text(conflict["ours"]["text"].string ?? model.t("git.binary_note")).frame(maxWidth: .infinity, alignment: .leading)
                    Text(conflict["theirs"]["text"].string ?? model.t("git.binary_note")).frame(maxWidth: .infinity, alignment: .leading)
                }.textSelection(.enabled)
                Text(model.t(conflict["choice"].string == "ours" ? "git.use_ours" : "git.use_theirs")).foregroundStyle(WorkbenchPalette.muted)
            }
        }
    }
    private var delivery: some View {
        let delivery = preview["preview"]
        return VStack(alignment: .leading, spacing: 10) {
            Text(model.t(action == "hetu.bundles.export" ? "delivery.bundle" : "delivery.document" )).fontWeight(.semibold)
            ForEach(Array(delivery["inputs"]["document_refs"].array.enumerated()), id: \.offset) { _, item in
                Text(model.documents.first { $0.id == item["document_id"].string }?.title ?? model.t("handoff.new_object"))
            }
            ForEach(Array(delivery["files"].array.enumerated()), id: \.offset) { _, file in
                HStack { Text(file["path"].string ?? ""); Spacer(); Text(model.localizer.byteCount(file["size_bytes"].integer ?? 0)).foregroundStyle(WorkbenchPalette.muted) }
            }
            Text(model.localizer.byteCount(delivery["estimated_bytes"].integer ?? 0)).foregroundStyle(WorkbenchPalette.muted)
        }
    }
    private var asset: some View {
        let metadata = preview["asset"] == .null ? input : preview["asset"]
        return VStack(alignment: .leading, spacing: 10) {
            Text(metadata["title"].string ?? "").fontWeight(.semibold)
            Text(metadata["description"].string ?? "").textSelection(.enabled)
            if let filename = input["inline_source"]["filename"].string ?? preview["inspection"]["original_filename"].string {
                Text(filename)
            } else if let path = input["file_path"].string { Text(URL(fileURLWithPath: path).lastPathComponent) }
            Text(model.localizer.byteCount(preview["inspection"]["size_bytes"].integer ?? metadata["blob"]["size_bytes"].integer ?? 0)).foregroundStyle(WorkbenchPalette.muted)
            Text(metadata["rights_statement"].string ?? "").textSelection(.enabled)
            if let status = metadata["rights_status"].string { Text(model.t("media.rights." + status)) }
            Text(model.t(metadata["redistribution_allowed"].bool == true ? "handoff.redistribution_allowed" : "handoff.redistribution_excluded")).foregroundStyle(WorkbenchPalette.muted)
        }
    }
}
