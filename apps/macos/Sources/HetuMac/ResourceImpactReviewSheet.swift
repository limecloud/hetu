import SwiftUI
import HetuCore
import HetuNative

struct ResourceImpactReviewSheet: View {
    let model: WorkspaceModel
    let impact: ResourceUsageImpact
    @Environment(\.dismiss) private var dismiss
    @State private var session = ResourceImpactSession()
    @State private var compareSource = false
    private var source: JSONValue { impact.usage["target_ref"] }
    private var selection: SourceSelection? {
        guard let start = source["byte_start"].integer, let end = source["byte_end"].integer,
              let byteStart = Int(exactly: start), let byteEnd = Int(exactly: end) else { return nil }
        return SourceSelection(content: session.fixedDocument["content"].string ?? "", byteStart: byteStart, byteEnd: byteEnd, quote: source["quote"].string ?? "")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.t("resources.impact.compare")).font(.system(size: 20, weight: .semibold))
            Text(model.t("resources.impact.compare_note")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            if let error = session.error {
                Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled)
            }
            if session.loading { ProgressView().accessibilityLabel(model.t("common.working")).frame(maxWidth: .infinity, maxHeight: .infinity) }
            else if session.ready {
                Picker(model.t("resources.impact.comparison"), selection: $compareSource) {
                    Text(model.t("resources.impact.reference_versions")).tag(false)
                    Text(model.t("resources.impact.source_versions")).tag(true)
                }.pickerStyle(.segmented).labelsHidden().frame(maxWidth: 320)
                if compareSource && model.documentID == source["document_id"].string && model.needsProtection {
                    Text(model.t("resources.impact.unsaved_note")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.warningInk)
                }
                HSplitView {
                    pane(current: false).frame(minWidth: 280)
                    pane(current: true).frame(minWidth: 280)
                }
            } else { Spacer() }
            HStack {
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t("resources.impact.refresh")) { Task { await session.load(model: model, impact: impact) } }.disabled(session.loading)
            }
        }.padding(24).frame(minWidth: 660, idealWidth: 940, minHeight: 420, idealHeight: 640)
        .font(.system(size: 14)).foregroundStyle(WorkbenchPalette.ink).background(WorkbenchPalette.page)
        .task(id: model.workspaceID) { await session.load(model: model, impact: impact) }
    }
    private func pane(current: Bool) -> some View {
        let resource = current ? session.currentResource : session.fixedResource
        let document = current ? session.currentDocument : session.fixedDocument
        let content = compareSource ? document["content"].string ?? "" : resource["resource"]["body"].string ?? ""
        let name = model.t(current ? "resources.impact.current" : "resources.impact.fixed")
        return VStack(alignment: .leading, spacing: 10) {
            Text(name).font(.system(size: 14, weight: .semibold))
            Text(compareSource ? document["document"]["title"].string ?? "" : resource["resource"]["title"].string ?? "")
                .font(.system(size: 14)).lineLimit(2)
            Text(compareSource ? model.localizer.date(document["revision"]["created_at"].string ?? "") : model.t("drama.revision", ["revision": String(resource["resource"]["revision"].integer ?? 0)]))
                .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            NativeTextEditor(text: content, documentID: "impact-\(current)-\(compareSource)-" + (document["revision"]["revision_id"].string ?? "") + String(resource["resource"]["revision"].integer ?? 0), replacementVersion: 0,
                accessibleName: name, editable: false, selection: compareSource && !current ? selection : nil,
                readingMode: true, presentation: .init(fontFamily: "system", fontSize: 14, lineSpacing: 4, firstLineIndent: false),
                onChange: { _ in }, onComposition: { _ in })
        }.padding(current ? .leading : .trailing, 12)
    }
}
