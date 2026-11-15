import SwiftUI
import HetuCore
import HetuNative

struct RelatedWorksView: View {
    let model: WorkspaceModel
    let onOpen: (WorkReference) -> Void
    @State private var session = RelatedWorksSession()
    @State private var includeArchived = false
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            WorkbenchHeading(title: model.t("works.related"), artwork: "") {
                PageAgentButton(model: model, page: "related_works", object: handoffObject,
                    intent: session.selectedID == nil ? nil : model.t("works.link_intent"))
                Menu {
                    Button(model.t("common.refresh")) { Task { await load() } }
                    if session.selectedID == nil {
                        Toggle(model.t("works.show_archived"), isOn: $includeArchived)
                    }
                } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).fixedSize()
                .accessibilityLabel(model.t("works.actions"))
                .help(model.t("works.actions"))
                .disabled(session.loading || session.detailLoading)
            }
            if let error = session.error { errorText(error) }
            if session.selectedID != nil { detail }
            else { list }
        }
        .padding(24).workbenchPage()
        .task(id: model.currentWorkID) { await load() }
        .onChange(of: includeArchived) { _, _ in Task { await load() } }
    }
    private var handoffObject: JSONValue {
        guard session.detail != .null else { return .object([:]) }
        return .object(["link_id": session.detail["link"]["link_id"], "link_revision": session.detail["link"]["revision"]])
    }
    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if session.items.isEmpty && !session.loading && session.error == nil {
                    Text(model.t("works.no_links")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
                }
                ForEach(session.items) { item in
                    Button { Task { await select(item.id) } } label: {
                        HStack(alignment: .center, spacing: 16) {
                            Image(systemName: icon(item.reference)).frame(width: 24)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(item.title ?? model.t("creation.type." + item.reference.kind)).font(.system(size: 14, weight: .semibold))
                                Text(model.t("works.relation." + (item.value["link"]["relation"].string ?? "reference")))
                                    .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                                status(item.value)
                            }
                            Spacer(minLength: 16)
                            Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                        }.padding(.vertical, 18).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("hetu.work-link." + item.id)
                    Rectangle().fill(WorkbenchPalette.line).frame(height: 0.5)
                }
                if session.nextCursor != nil { Button(model.t("plot.more")) { Task { await load(more: true) } }.disabled(session.loading).padding(.top, 16) }
                if session.loading { ProgressView().controlSize(.small).padding(.top, 16) }
            }
        }
    }
    private var detail: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Button { session.back() } label: { Label(model.t("works.back_to_links"), systemImage: "chevron.left") }
                Spacer()
                if let id = session.selectedID, let revision = session.detail["link"]["revision"].integer,
                   let current = session.detail["current_link_ref"]["revision"].integer {
                    Menu {
                        if revision > 1 { Button(model.t("works.earlier_link")) { Task { await select(id, revision: revision - 1) } } }
                        if revision < current {
                            Button(model.t("works.later_link")) { Task { await select(id, revision: revision + 1) } }
                            Button(model.t("works.current_link")) { Task { await select(id) } }
                        }
                    } label: { Text(model.t("works.link_revision", ["revision": String(revision)])) }
                    .menuStyle(.borderlessButton).fixedSize()
                    .disabled(session.detailLoading || current == 1)
                }
            }.font(.system(size: 14))
            if session.detailLoading { ProgressView().controlSize(.small) }
            if let error = session.detailError {
                errorText(error)
                Button(model.t("common.refresh")) { Task { if let id = session.selectedID { await select(id) } } }
            }
            if let item = try? RelatedWork(session.detail) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(item.title ?? model.t("creation.type." + item.reference.kind)).font(.system(size: 20, weight: .semibold)).textSelection(.enabled)
                            status(item.value)
                        }
                        VStack(alignment: .leading, spacing: 12) {
                            endpoint(session.detail["link"]["source_ref"], title: session.detail["link"]["source_title"].string, label: "works.source")
                            endpoint(session.detail["link"]["target_ref"], title: session.detail["link"]["target_title"].string, label: "works.target")
                        }
                        if !session.detail["related_error"].object.isEmpty {
                            errorText(CoreError.business(.object(["error": session.detail["related_error"]])))
                        }
                        if session.detail["related_work"] != .null {
                            let record = session.detail["related_work"]["record"]
                            let summary = record["metadata"]["synopsis"].string ?? record["description"].string ?? record["brief"].string ?? ""
                            if !summary.isEmpty {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(model.t("works.fixed_profile")).font(.system(size: 14, weight: .semibold))
                                    Text(summary).font(.system(size: 14)).lineSpacing(6).textSelection(.enabled)
                                }
                            }
                            Button(model.t("works.open_current")) { onOpen(item.reference) }
                        }
                        DisclosureGroup(model.t("works.link_properties")) {
                            VStack(alignment: .leading, spacing: 8) {
                                property("properties.created", value: model.localizer.date(session.detail["link"]["created_at"].string ?? ""))
                                property("properties.updated", value: model.localizer.date(session.detail["link"]["updated_at"].string ?? ""))
                            }.padding(.top, 8)
                        }.font(.system(size: 14))
                    }.frame(maxWidth: 800, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
                }
            } else { Spacer(minLength: 0) }
        }
    }
    @ViewBuilder private func status(_ value: JSONValue) -> some View {
        if value["link"]["archived"].bool == true {
            Text(model.t("works.archived_link")).foregroundStyle(WorkbenchPalette.muted).font(.system(size: 12))
        }
        if value["related_status"].string == "requires_authorization" {
            Text(model.t("works.requires_authorization")).foregroundStyle(WorkbenchPalette.muted).font(.system(size: 12))
        } else if value["related_status"].string == "unavailable" {
            Text(model.t("works.basis_unavailable")).foregroundStyle(WorkbenchPalette.warningInk).font(.system(size: 12))
        } else if value["related_has_newer_revision"].bool == true {
            Text(model.t("works.newer_source")).foregroundStyle(WorkbenchPalette.warningInk).font(.system(size: 12))
        } else if value["related_current_archived"].bool == true {
            Text(model.t("works.related_archived")).foregroundStyle(WorkbenchPalette.muted).font(.system(size: 12))
        }
    }
    private func endpoint(_ fixed: JSONValue, title: String?, label: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(model.t(label)).foregroundStyle(WorkbenchPalette.muted).frame(width: 104, alignment: .leading)
            VStack(alignment: .leading, spacing: 4) {
                Text(title ?? model.t("creation.type." + (fixed["work_ref"]["kind"].string ?? "novel"))).fontWeight(.medium)
                Text(model.t("works.fixed_version", ["revision": String(fixed["revision_ref"]["revision"].integer ?? 0)]))
                    .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            }
        }.font(.system(size: 14)).textSelection(.enabled)
    }
    private func property(_ key: String, value: String) -> some View {
        LabeledContent(model.t(key), value: value).font(.system(size: 12))
    }
    private func icon(_ reference: WorkReference) -> String { reference.kind == "novel" ? "book" : reference.kind == "drama" ? "doc.text" : "film" }
    private func errorText(_ error: any Error) -> some View {
        Text(model.localizer.error(error)).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled)
    }
    private func load(more: Bool = false) async {
        guard let reference = model.workReference, let workspace = model.workspace else { session.reset(); return }
        await session.load(in: workspace, reference: reference, includeArchived: includeArchived, more: more)
    }
    private func select(_ id: String, revision: Int64? = nil) async {
        guard let reference = model.workReference, let workspace = model.workspace else { return }
        await session.select(id, revision: revision, in: workspace, reference: reference)
    }
}
