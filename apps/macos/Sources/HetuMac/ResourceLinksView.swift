import SwiftUI
import HetuCore
import HetuNative

struct ResourceLinksEditor: View {
    let model: WorkspaceModel
    let catalog: ResourceAssociations
    @Binding var projectID: String
    @Binding var references: [JSONValue]
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker(model.t("resources.project"), selection: $projectID) {
                Text(model.t("resources.project_shared")).tag("")
                ForEach(Array(catalog.projects.enumerated()), id: \.offset) { _, entry in
                    let project = entry["project"]
                    Text(project["title"].string ?? "").tag(project["project_id"].string ?? "")
                }
                if !projectID.isEmpty, !catalog.projects.contains(where: { $0["project"]["project_id"].string == projectID }) {
                    Text(model.t("resources.project_unavailable")).tag(projectID)
                }
            }
            if catalog.cursor != nil { Button(model.t("resources.more_projects")) { Task { await catalog.load(model: model, projectID: projectID, references: references, more: true) } }.disabled(catalog.loading) }
            HStack {
                Text(model.t("resources.entities")).font(.system(size: 14, weight: .semibold))
                Spacer()
                Menu(model.t("resources.link_entity")) {
                    ForEach(catalog.options) { option in
                        Button(option.title + " (" + model.t("entity.kind." + option.kind) + ")") { references.append(option.reference) }
                            .disabled(references.contains { catalog.sameEntity($0, option.reference) } || references.count >= 50)
                    }
                }.disabled(catalog.options.isEmpty)
            }
            if !references.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(references.enumerated()), id: \.offset) { index, reference in
                            HStack {
                                ResourceEntityLabel(model: model, catalog: catalog, reference: reference)
                                Spacer()
                                Button { references.remove(at: index) } label: { Image(systemName: "minus.circle") }
                                    .buttonStyle(.plain).help(model.t("resources.unlink")).accessibilityLabel(model.t("resources.unlink"))
                            }
                        }
                    }
                }.frame(maxHeight: 120)
            }
            if let error = catalog.error {
                Text(error).foregroundStyle(WorkbenchPalette.danger).font(.system(size: 12))
                Button(model.t("common.refresh")) { Task { await catalog.load(model: model, projectID: projectID, references: references) } }.disabled(catalog.loading)
            }
        }
    }
}

struct ResourceLinksView: View {
    let model: WorkspaceModel
    let resource: JSONValue
    @State private var catalog = ResourceAssociations()
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let projectID = resource["project_id"].string {
                LabeledContent(model.t("resources.project")) {
                    Text(catalog.projects.first { $0["project"]["project_id"].string == projectID }?["project"]["title"].string ?? model.t("resources.project_unavailable"))
                }
            }
            if !resource["entity_refs"].array.isEmpty {
                Text(model.t("resources.entities")).font(.system(size: 14, weight: .semibold))
                ForEach(Array(resource["entity_refs"].array.enumerated()), id: \.offset) { _, reference in
                    ResourceEntityLabel(model: model, catalog: catalog, reference: reference)
                }
            }
            if let error = catalog.error { Text(error).foregroundStyle(WorkbenchPalette.danger).font(.system(size: 12)) }
        }.task(id: (resource["resource_id"].string ?? "") + ":" + String(resource["revision"].integer ?? 0)) {
            if resource["project_id"].string != nil || !resource["entity_refs"].array.isEmpty {
                await catalog.load(model: model, projectID: resource["project_id"].string, references: resource["entity_refs"].array)
            }
        }
    }
}

private struct ResourceEntityLabel: View {
    let model: WorkspaceModel
    let catalog: ResourceAssociations
    let reference: JSONValue
    var body: some View {
        HStack(spacing: 8) {
            Text(catalog.title(for: reference) ?? model.t("resources.entity_unavailable"))
            Text(model.t("entity.kind." + (reference["kind"].string ?? "world"))).foregroundStyle(WorkbenchPalette.muted)
            Text(model.t("drama.revision", ["revision": String(reference["blueprint_revision"].integer ?? 0)]))
                .foregroundStyle(WorkbenchPalette.muted)
        }.font(.system(size: 12))
    }
}
