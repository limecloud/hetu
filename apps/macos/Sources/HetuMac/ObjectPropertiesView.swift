import SwiftUI
import HetuCore
import HetuNative

struct ObjectPropertyRow: View {
    let title: String
    let value: String
    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Text(title).foregroundStyle(WorkbenchPalette.muted).fixedSize(horizontal: true, vertical: false)
            Spacer(minLength: 0)
            Text(value).multilineTextAlignment(.trailing).textSelection(.enabled)
        }.font(.system(size: 12)).frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
    }
}

struct ObjectTimestampsView: View {
    let localizer: Localizer
    let record: JSONValue
    var updatedLabel = "properties.updated"
    var body: some View {
        VStack(spacing: 10) {
            ObjectPropertyRow(title: localizer.text("properties.created"), value: display(record["created_at"]))
            ObjectPropertyRow(title: localizer.text(updatedLabel), value: display(record["updated_at"]))
        }
    }
    private func display(_ value: JSONValue) -> String {
        value.string.flatMap { $0.isEmpty ? nil : localizer.date($0) } ?? localizer.text("properties.not_recorded")
    }
}

struct DocumentPropertiesView: View {
    let model: WorkspaceModel
    @State private var lifecycle: JSONValue = .null
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("properties.document")).font(.system(size: 14, weight: .semibold))
            ObjectTimestampsView(localizer: model.localizer, record: .object([
                "created_at": model.loaded["document"]["created_at"], "updated_at": model.loaded["revision"]["created_at"]
            ]), updatedLabel: "properties.saved")
            if model.dirty { Text(model.t("properties.unsaved")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.warningInk) }
            ObjectPropertyRow(title: model.t("properties.format"), value: model.loaded["document"]["source_format"].string == "fountain" ? "Fountain" : "Markdown")
            ObjectPropertyRow(title: model.t("document.language"), value: model.loaded["document"]["language_tag"].string ?? model.locale)
            ObjectPropertyRow(title: model.t("properties.size"), value: model.localizer.byteCount(model.loaded["revision"]["size_bytes"].integer ?? 0))
            ObjectPropertyRow(title: model.t("properties.source"), value: revisionSource)
            if let id = model.loaded["document"]["finalization_ref"]["finalization_id"].string,
               let final = lifecycle["finalizations"].array.first(where: { $0["finalization_id"].string == id }),
               let date = final["created_at"].string {
                ObjectPropertyRow(title: model.t("properties.finalized"), value: model.localizer.date(date))
            }
        }.task(id: model.workspaceID + model.documentID + (model.loaded["document"]["finalization_ref"]["finalization_id"].string ?? "")) {
            lifecycle = .null
            guard model.loaded["document"]["finalization_ref"] != .null, let workspace = model.workspace else { return }
            let scope = model.workspaceID, document = model.documentID
            do {
                let value = try await workspace.data("hetu.documents.lifecycle", input: ["document_id": .string(document)])
                guard scope == model.workspaceID, document == model.documentID, !Task.isCancelled else { return }
                lifecycle = value
            } catch { if scope == model.workspaceID, document == model.documentID { model.report(error) } }
        }
    }
    private var revisionSource: String {
        let revision = model.loaded["revision"]
        if !revision["contribution_refs"].array.isEmpty { return model.t("properties.adopted") }
        if revision["origin_kind"].string == "agent" { return model.t("review.agent") }
        if revision["origin_kind"].string == "author" { return model.t("review.author") }
        return model.t("properties.not_recorded")
    }
}
