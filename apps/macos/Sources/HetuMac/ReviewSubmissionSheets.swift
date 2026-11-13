import SwiftUI
import HetuCore
import HetuNative

struct ReviewSubmitSheet: View {
    let model: WorkspaceModel
    let document: JSONValue
    let onSubmitted: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var input: [String: JSONValue]?
    @State private var error: String?
    @State private var submitted = false
    @State private var source: JSONValue = .null
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.t("review.submit")).font(.title2)
            Text(document["document"]["title"].string ?? "").font(.headline)
            Text(model.t("review.submit_note")).foregroundStyle(.secondary)
            if source != .null {
                Text(source["revision"]["revision_id"].string ?? "").font(.caption).textSelection(.enabled)
                DisclosureGroup(model.t("review.content")) {
                    ScrollView { Text(source["content"].string ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 200)
                }
            }
            if let input { Text(model.t("drama.source_note", ["revision": String(input["blueprint_revision"]?.integer ?? 0)])).font(.caption) }
            if let revision = input?["skeleton_ref"]?["revision"].integer { Text(model.t("review.skeleton_revision", ["revision": String(revision)])).font(.caption) }
            if let error { Text(error).foregroundStyle(.red) }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                if input == nil { Button(model.t("review.reload_context")) { Task { await prepare(reload: true) } } }
                Spacer()
                Button(model.t(submitted ? "drama.retry" : "review.submit")) { Task { await submit() } }.disabled(input == nil)
            }
        }.padding(24).frame(width: 520).disabled(model.busy).task { await prepare() }
    }
    private func prepare(reload: Bool = false) async {
        error = nil
        if reload {
            guard let current = await model.workspaceAction("hetu.documents.get", input: ["document_id": document["document"]["document_id"]], onFailure: { error = $0; _ = $1 }) else { return }
            source = current
        } else { source = document }
        guard let bible = await model.workspaceAction("hetu.blueprints.get", input: [:], onFailure: { error = $0; _ = $1 }) else { return }
        var next: [String: JSONValue] = ["document_id": source["document"]["document_id"], "base_revision_id": source["revision"]["revision_id"], "blueprint_revision": bible["revision"], "operation_key": .string(UUID().uuidString)]
        if source["document"]["structure_origin"] != .null {
            guard let mapping = await model.workspaceAction("hetu.drama.get_script_mapping", input: ["document_id": source["document"]["document_id"]], onFailure: { error = $0; _ = $1 }),
                  let skeleton = await model.workspaceAction("hetu.drama.get_skeleton", input: ["skeleton_id": mapping["mapping"]["skeleton_ref"]["skeleton_id"]], onFailure: { error = $0; _ = $1 }) else { return }
            next["skeleton_ref"] = .object(["skeleton_id": skeleton["skeleton"]["skeleton_id"], "revision": skeleton["skeleton"]["revision"], "sha256": skeleton["sha256"]])
        }
        input = next
    }
    private func submit() async {
        guard let fixed = input else { return }; submitted = true; error = nil
        if let result = await model.workspaceAction("hetu.drafts.submit_current", input: fixed, onFailure: { error = $0; if $1 { submitted = false; input = nil } }), let id = result["draft"]["draft_id"].string { dismiss(); onSubmitted(id) }
    }
}

struct ReviewRewriteSheet: View {
    let model: WorkspaceModel
    let original: JSONValue
    let onSubmitted: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var content = ""
    @State private var title = ""
    @State private var baseline: [String: JSONValue]?
    @State private var pending: [String: JSONValue]?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("review.rewrite")).font(.title2)
            Text(model.t("review.rewrite_note")).foregroundStyle(.secondary)
            TextField(model.t("document.title"), text: $title).textFieldStyle(.roundedBorder).disabled(pending != nil)
            TextEditor(text: $content).frame(minHeight: 260).border(Color.secondary.opacity(0.2)).accessibilityLabel(model.t("review.rewrite_content")).disabled(pending != nil)
            if let baseline {
                Text(model.t("drama.source_note", ["revision": String(baseline["blueprint_revision"]?.integer ?? 0)])).font(.caption)
                if let revision = baseline["skeleton_ref"]?["revision"].integer { Text(model.t("review.skeleton_revision", ["revision": String(revision)])).font(.caption) }
            }
            if let error { Text(error).foregroundStyle(.red) }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(model.t("review.reload_context")) { Task { await prepare() } }.disabled(pending != nil)
                Spacer()
                Button(model.t(pending == nil ? "review.submit" : "drama.retry")) { Task { await submit() } }.disabled(baseline == nil || content.isEmpty || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 720, height: 500).disabled(model.busy)
        .task { content = original["content"].string ?? ""; title = original["draft"]["title"].string ?? original["baseline"]["document"]["title"].string ?? model.t("draft.untitled"); await prepare() }
    }
    private func prepare() async {
        error = nil; baseline = nil
        let draft = original["draft"]
        guard let bible = await model.workspaceAction("hetu.blueprints.get", input: [:], onFailure: { error = $0; _ = $1 }) else { return }
        var next: [String: JSONValue] = ["package": draft["package"], "source_format": draft["source_format"], "blueprint_revision": bible["revision"], "parent_draft_id": draft["draft_id"], "language_tag": draft["language_tag"]]
        if let target = draft["target_document_id"].string {
            guard let current = await model.workspaceAction("hetu.documents.get", input: ["document_id": .string(target)], onFailure: { error = $0; _ = $1 }) else { return }
            next["target_document_id"] = .string(target); next["base_revision_id"] = current["revision"]["revision_id"]
        }
        if draft["skeleton_ref"] != .null {
            guard let skeleton = await model.workspaceAction("hetu.drama.get_skeleton", input: ["skeleton_id": draft["skeleton_ref"]["skeleton_id"]], onFailure: { error = $0; _ = $1 }) else { return }
            next["skeleton_ref"] = .object(["skeleton_id": skeleton["skeleton"]["skeleton_id"], "revision": skeleton["skeleton"]["revision"], "sha256": skeleton["sha256"]])
        }
        baseline = next
    }
    private func submit() async {
        if pending == nil, var input = baseline { input["title"] = .string(title); input["content"] = .string(content); input["operation_key"] = .string(UUID().uuidString); pending = input }
        guard let fixed = pending else { return }; error = nil
        if let result = await model.workspaceAction("hetu.drafts.submit", input: fixed, onFailure: { error = $0; if $1 { pending = nil } }), let id = result["draft"]["draft_id"].string { dismiss(); onSubmitted(id) }
    }
}
