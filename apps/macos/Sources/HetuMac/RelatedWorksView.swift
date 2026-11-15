import SwiftUI
import HetuCore
import HetuNative

struct RelatedWorksView: View {
    let model: WorkspaceModel
    let onOpen: (WorkReference) -> Void
    @State private var links: [JSONValue] = []
    @State private var titles: [String: String] = [:]
    @State private var cursor: String?
    @State private var error: String?
    @State private var loading = false
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            WorkbenchHeading(title: model.t("works.related"), artwork: "") {
                PageAgentButton(model: model, page: "related_works")
                Button(model.t("common.refresh")) { Task { await load() } }.disabled(loading)
            }
            if let error { Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if links.isEmpty && !loading && error == nil {
                Text(model.t("works.no_links")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
            }
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(links.enumerated()), id: \.offset) { _, item in
                        let fixed = item["direction"].string == "incoming" ? item["link"]["source_ref"] : item["link"]["target_ref"]
                        if let reference = try? WorkReference(fixed["work_ref"]) {
                            HStack(spacing: 16) {
                                Image(systemName: reference.kind == "novel" ? "book" : reference.kind == "drama" ? "doc.text" : "film").frame(width: 24)
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(titles[reference.id] ?? model.t("creation.type." + reference.kind)).font(.system(size: 14, weight: .semibold))
                                    Text(model.t("works.relation." + (item["link"]["relation"].string ?? "reference")) + " / " + model.t("works.fixed_version", ["revision": String(fixed["revision_ref"]["revision"].integer ?? 0)]))
                                        .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                                    if item["related_has_newer_revision"].bool == true { Text(model.t("works.newer_source")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.warningInk) }
                                }
                                Spacer()
                                Button(model.t("works.open_current")) { onOpen(reference) }
                            }.padding(.vertical, 18)
                            Divider()
                        }
                    }
                    if cursor != nil { Button(model.t("plot.more")) { Task { await load(more: true) } }.disabled(loading) }
                }
            }
            if loading { ProgressView().controlSize(.small) }
        }.padding(24).workbenchPage().task(id: model.currentWorkID) { await load() }
    }
    private func load(more: Bool = false) async {
        guard !loading, let reference = model.workReference, let workspace = model.workspace else { return }
        loading = true; error = nil; defer { loading = false }
        do {
            var input: [String: JSONValue] = ["work_ref": reference.value, "limit": .integer(50)]
            if more, let cursor { input["cursor"] = .string(cursor) }
            let data = try await workspace.data("hetu.work_links.list", input: input)
            guard model.workReference == reference else { return }
            var labels = more ? titles : [:]
            for item in data["links"].array {
                let fixed = item["direction"].string == "incoming" ? item["link"]["source_ref"] : item["link"]["target_ref"]
                let related = try WorkReference(fixed["work_ref"])
                let read = try await workspace.data("hetu.works.get", input: ["work_ref": related.value, "revision": fixed["revision_ref"]["revision"]])
                guard read["summary"]["fixed_ref"] == fixed else { throw CoreError.invalidResponse }
                labels[related.id] = read["summary"]["title"].string
            }
            links = more ? links + data["links"].array : data["links"].array; titles = labels; cursor = data["next_cursor"].string
        } catch { self.error = model.localizer.error(error) }
    }
}
