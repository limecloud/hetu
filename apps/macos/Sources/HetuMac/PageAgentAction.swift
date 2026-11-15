import AppKit
import SwiftUI
import HetuCore
import HetuNative

struct PageAgentButton: View {
    let model: WorkspaceModel
    let page: String
    var object: JSONValue = .object([:])
    var intent: String?
    @State private var showing = false
    var body: some View {
        Button { showing = true } label: { Label(model.t("handoff.action"), systemImage: "sparkles") }
            .accessibilityIdentifier("hetu.ai." + page)
            .sheet(isPresented: $showing, onDismiss: { Task { await model.refresh() } }) {
                PageAgentSheet(model: model, page: page, object: scopedObject, intent: intent)
            }
    }
    private var scopedObject: JSONValue {
        var fields = object.object
        if let reference = model.workReference { fields["work_ref"] = reference.value }
        return .object(fields)
    }
}

private struct PageAgentSheet: View {
    let model: WorkspaceModel
    let page: String
    let object: JSONValue
    let intent: String?
    @Environment(\.dismiss) private var dismiss
    @State private var context: JSONValue = .null
    @State private var proposals: [JSONValue] = []
    @State private var cursor: String?
    @State private var error: String?
    @State private var copied = false
    @State private var access: JSONValue = .null
    @State private var selected: DramaSheet?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(model.t("handoff.title")).font(.system(size: 20, weight: .semibold))
                Spacer()
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            Text(model.title).font(.system(size: 14, weight: .medium))
            if let intent { Text(intent).font(.system(size: 14)).lineLimit(5).textSelection(.enabled) }
            if let error { Text(error).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if context == .null && error == nil { ProgressView() }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if context != .null {
                        Text(model.t("handoff.instruction")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
                        HStack {
                            Button(model.t(copied ? "creative.copied" : "handoff.authorize_copy")) { Task { await copy() } }.buttonStyle(WorkbenchButtonStyle(primary: true))
                            Button(model.t("common.refresh")) { Task { await load() } }
                            if access["authorized"].bool == true {
                                Button(model.t("handoff.revoke")) { Task { await revoke() } }
                            }
                        }
                        if model.needsProtection { Text(model.t("handoff.unsaved")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.warningInk) }
                        if model.writeLocked { Text(model.t("workspace.read_only")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
                        if !context["limitations"].array.isEmpty {
                            DisclosureGroup(model.t("handoff.limits")) {
                                ForEach(context["limitations"].array.compactMap(\.string), id: \.self) { key in
                                    Text(model.t("handoff.limit." + key)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 3)
                                }
                            }.font(.system(size: 14))
                        }
                    }
                    Divider()
                    Text(model.t("handoff.proposals")).font(.system(size: 14, weight: .semibold))
                    if proposals.isEmpty && error == nil { Text(model.t("handoff.no_proposals")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted) }
                    ForEach(Array(proposals.enumerated()), id: \.offset) { _, item in
                        Button { selected = DramaSheet(value: item["proposal_id"]) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(item["summary"].string ?? "").font(.system(size: 14)).lineLimit(3)
                                    Text(model.t("handoff.state." + (item["state"].string ?? "pending"))).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.plain).padding(.vertical, 6)
                    }
                    if cursor != nil { Button(model.t("creative.more")) { Task { await load(more: true) } } }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }.padding(24).frame(width: 640, height: 560)
            .foregroundStyle(WorkbenchPalette.ink).background(WorkbenchPalette.page).buttonStyle(WorkbenchButtonStyle())
            .task { await load() }
            .sheet(item: $selected, onDismiss: { Task { await load() } }) { request in
                AgentOperationReviewSheet(model: model, proposalID: request.value.string ?? "")
            }
    }
    private func load(more: Bool = false) async {
        error = nil
        if !more {
            context = await model.workspaceAction("hetu.handoffs.get", input: ["view_kind": .string(page), "object_ref": object]) { error = $0; _ = $1 } ?? .null
            var input: [String: JSONValue] = ["client_adapter": .string(adapter)]
            if let reference = model.workReference { input["work_ref"] = reference.value }
            access = await model.workspaceAction("hetu.collaboration.workspace_access", input: input) { error = $0; _ = $1 } ?? .null
        }
        var input: [String: JSONValue] = ["limit": .integer(20)]
        if more, let cursor { input["cursor"] = .string(cursor) }
        if let value = await model.workspaceAction("hetu.agent_operations.list", input: input, onFailure: { error = $0; _ = $1 }) {
            proposals = (more ? proposals : []) + value["proposals"].array; cursor = value["next_cursor"].string
        }
    }
    private var adapter: String {
        let selected = model.agentIntegration.association(for: model.workspaceID).client
        return selected == .claudeCode ? "claude-code" : selected == .other || selected == .none ? "generic" : selected.rawValue
    }
    private func revoke() async {
        guard access["management_ref"]["grant_id"].string != nil else { return }
        if await model.workspaceAction("hetu.collaboration.revoke_management", input: ["grant_id": access["management_ref"]["grant_id"], "client_adapter": .string(adapter), "operation_key": .string(UUID().uuidString)], onFailure: { error = $0; _ = $1 }) != nil {
            copied = false; await load()
        }
    }
    private func copy() async {
        do {
            guard let workspace = model.workspace?.url else { throw CoreError.invalidResponse }
            let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/hetu")
            guard FileManager.default.isExecutableFile(atPath: helper.path) else { error = model.t("handoff.cli_missing"); return }
            var input: [String: JSONValue] = ["client_adapter": .string(adapter), "operation_key": .string(UUID().uuidString)]
            if let reference = model.workReference { input["work_ref"] = reference.value }
            guard let grant = await model.workspaceAction("hetu.collaboration.authorize_workspace", input: input, onFailure: { error = $0; _ = $1 }) else { return }
            access = .object(["authorized": .bool(true), "management_ref": grant["management_ref"]])
            let prompt = try PageHandoff.prompt(context: context, workspace: workspace, executable: helper, locale: model.locale,
                suite: model.agentIntegration.association(for: model.workspaceID).suiteID, clientAdapter: adapter, managementRef: grant["management_ref"], authorInstruction: intent)
            NSPasteboard.general.clearContents(); copied = NSPasteboard.general.setString(prompt, forType: .string)
        } catch { self.error = model.localizer.error(error) }
    }
}

private struct AgentOperationReviewSheet: View {
    let model: WorkspaceModel
    let proposalID: String
    @Environment(\.dismiss) private var dismiss
    @State private var proposal: JSONValue = .null
    @State private var error: String?
    @State private var pending: DramaOperation?
    init(model: WorkspaceModel, proposalID: String) {
        self.model = model; self.proposalID = proposalID
        let saved = model.pendingStructureOperations.first { $0.action == "hetu.agent_operations.decide" && $0.input["proposal_id"]?.string == proposalID }
        _pending = State(initialValue: saved.map { DramaOperation(action: $0.action, input: $0.input) })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(model.t("handoff.review")).font(.system(size: 20, weight: .semibold))
                Spacer()
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(pending != nil)
            }
            if let error { Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if proposal != .null {
                Text(proposal["summary"].string ?? "").font(.system(size: 14, weight: .semibold))
                Text(model.t("handoff.state." + (proposal["state"].string ?? "pending"))).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                if proposal["is_expired"].bool == true && proposal["state"].string != "executed" { Text(model.t("handoff.expired")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.warningInk) }
                if proposal["is_current"].bool == false && proposal["state"].string != "executed" { Text(model.t("handoff.stale")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.warningInk) }
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        AgentOperationPreview(model: model, proposal: proposal)
                        ForEach(Array(readableChanges.enumerated()), id: \.offset) { _, change in
                            HStack(alignment: .top, spacing: 20) {
                                comparison(change["before"].string, title: "handoff.before")
                                comparison(change["after"].string, title: "handoff.after")
                            }
                            DisclosureGroup(model.t("handoff.technical")) {
                                Text(change["path"].string ?? "").font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                                Text(change["after"].string ?? "").font(.system(size: 12)).textSelection(.enabled)
                            }.font(.system(size: 12))
                            Divider()
                        }
                        if readableChanges.isEmpty && !AgentOperationPreview.supports(proposal["action"].string ?? "") {
                            if proposal["action"].string == "hetu.creative_tasks.prepare" {
                                Text(model.t("handoff.task_review")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
                                Text(proposal["input"]["brief"].string ?? "").font(.system(size: 14)).textSelection(.enabled)
                                LabeledContent(model.t("handoff.context_count"), value: String(proposal["input"]["input_refs"].array.count))
                            } else {
                                Text(proposal["input"]["title"].string ?? proposal["summary"].string ?? "").font(.system(size: 14)).textSelection(.enabled)
                                if let kind = proposal["input"]["kind"].string,
                                   let key = ["novel_chapter": "novel.chapter", "novel_outline": "novel.outline", "drama_script": "drama.script", "adaptation_note": "drama.note"][kind] {
                                    Text(model.t(key)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                                }
                            }
                        }
                        DisclosureGroup(model.t("handoff.technical")) {
                            Text(pretty(.object(["input": proposal["input"], "preview": proposal["preview"]])))
                                .font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                        }.font(.system(size: 12))
                    }
                }
                HStack {
                    Button(model.t("common.refresh")) { Task { await load() } }.disabled(pending != nil)
                    Spacer()
                    if proposal["state"].string != "executed" && proposal["state"].string != "executing" {
                        Button(model.t("handoff.reject")) { decide("reject") }.disabled(pending != nil || model.writeLocked)
                        Button(model.t("handoff.approve")) { decide("approve") }.buttonStyle(WorkbenchButtonStyle(primary: true))
                            .disabled(pending != nil || model.writeLocked || proposal["is_current"].bool != true || proposal["is_expired"].bool == true || proposal["state"].string == "approved")
                    }
                }
                if proposal["state"].string == "approved" || proposal["state"].string == "executing" { Text(model.t("handoff.return_agent")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
            } else if error == nil { ProgressView() }
            if pending != nil { Button(model.t("drama.retry")) { Task { await perform() } } }
        }.padding(24).frame(width: 900, height: 640).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.ink).background(WorkbenchPalette.page)
            .buttonStyle(WorkbenchButtonStyle()).interactiveDismissDisabled(pending != nil).task { await load() }
    }
    private func comparison(_ text: String?, title: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.t(title)).font(.system(size: 14, weight: .semibold))
            if let text, let bytes = text.data(using: .utf8), let value = try? JSONDecoder().decode(JSONValue.self, from: bytes) {
                humanReadable(value)
            } else {
                Text(text?.isEmpty == false ? text! : model.t("handoff.new_object")).font(.system(size: 14)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var readableChanges: [JSONValue] {
        proposal["changes"].array.filter { change in
            let path = change["path"].string ?? ""
            if path.hasSuffix("/head.json") { return false }
            if path.contains("/documents/") && path.contains("/revisions/") { return !path.hasSuffix(".json") && !(change["after"].string ?? "").isEmpty }
            return true
        }
    }
    @ViewBuilder private func humanReadable(_ value: JSONValue) -> some View {
        if value["link_id"].string != nil {
            Text(model.t("works.relation." + (value["relation"].string ?? "reference"))).font(.system(size: 14, weight: .semibold))
            ForEach([("source", "works.source"), ("target", "works.target")], id: \.0) { field, label in
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.t(label)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                    Text(value[field + "_title"].string ?? model.t("creation.type." + (value[field + "_ref"]["work_ref"]["kind"].string ?? "novel")))
                        .font(.system(size: 14)).textSelection(.enabled)
                    Text(model.t("works.fixed_version", ["revision": String(value[field + "_ref"]["revision_ref"]["revision"].integer ?? 0)]))
                        .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                }
            }
            Text(model.t(value["archived"].bool == true ? "works.archived_link" : "works.active_link")).font(.system(size: 14))
        } else if value["metadata"].object.isEmpty == false {
            let labels = [("title", "workspace.title"), ("author_name", "novel.author"), ("genre", "novel.genre"), ("synopsis", "novel.synopsis"), ("status", "novel.status")]
            ForEach(labels, id: \.0) { field, key in
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.t(key)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                    Text(field == "status" ? model.t("novel.status." + (value["metadata"][field].string ?? "planning")) : value["metadata"][field].string ?? "").font(.system(size: 14)).textSelection(.enabled)
                }
            }
            ForEach(Array(value["chapters"].array.filter { $0["volume_id"] == .null }.enumerated()), id: \.offset) { _, chapter in Text(documentTitle(chapter["document_id"])).font(.system(size: 14)) }
            ForEach(Array(value["volumes"].array.enumerated()), id: \.offset) { _, volume in
                Text(volume["title"].string ?? "").font(.system(size: 14, weight: .semibold))
                ForEach(Array(value["chapters"].array.filter { $0["volume_id"] == volume["volume_id"] }.enumerated()), id: \.offset) { _, chapter in Text(documentTitle(chapter["document_id"])).font(.system(size: 14)) }
            }
        } else if value["blueprint_id"].string != nil {
            ForEach(BibleKind.allCases) { kind in
                ForEach(Array(value[kind.section].array.enumerated()), id: \.offset) { _, entity in
                    Text(entityTitle(model, kind, entity)).font(.system(size: 14, weight: .semibold))
                    HistoricalEntityDetails(model: model, kind: kind, entity: entity, blueprint: value)
                }
            }
        } else if !value["items"].array.isEmpty {
            ForEach(Array(value["items"].array.enumerated()), id: \.offset) { _, item in
                Text(item["title"].string ?? "").font(.system(size: 14, weight: .semibold))
                Text(item["text"].string ?? "").font(.system(size: 14)).textSelection(.enabled)
            }
        } else {
            Text(value["title"].string ?? value["document"]["title"].string ?? model.t("handoff.new_object")).font(.system(size: 14, weight: .medium))
            if let description = value["description"].string, !description.isEmpty { Text(description).font(.system(size: 14)).textSelection(.enabled) }
            if let plan = value["plan"].string, !plan.isEmpty { Text(plan).font(.system(size: 14)).textSelection(.enabled) }
        }
    }
    private func documentTitle(_ id: JSONValue) -> String {
        model.documents.first { $0.id == id.string }?.title ?? proposal["preview"]["document"]["title"].string ?? model.t("handoff.new_object")
    }
    private func pretty(_ value: JSONValue) -> String { (try? value.encoded(pretty: true)).map { String(decoding: $0, as: UTF8.self) } ?? "" }
    private func load() async {
        error = nil
        proposal = await model.workspaceAction("hetu.agent_operations.get", input: ["proposal_id": .string(proposalID)]) { error = $0; _ = $1 } ?? .null
    }
    private func decide(_ decision: String) {
        pending = DramaOperation(action: "hetu.agent_operations.decide", input: ["proposal_id": .string(proposalID), "proposal_sha256": proposal["proposal_sha256"], "expected_state_revision": proposal["state_revision"], "decision": .string(decision), "operation_key": .string(UUID().uuidString)])
        Task { await perform() }
    }
    private func perform() async {
        guard let pending else { return }; error = nil
        if let value = await model.workspaceAction(pending.action, input: pending.input, onFailure: { error = $0; if $1 { self.pending = nil } }) {
            self.pending = nil; proposal = value
        }
    }
}
