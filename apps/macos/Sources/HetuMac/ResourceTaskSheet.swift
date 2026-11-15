import AppKit
import SwiftUI
import HetuCore
import HetuNative

struct ResourceTaskSheet: View {
    let model: WorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var session: CreativeTaskSession
    @State private var records: [JSONValue] = []
    @State private var cursor: String?
    @State private var readable: Set<String> = []
    @State private var editable: Set<String> = []
    @State private var allowCreate = true
    @State private var client: AgentClient
    @State private var brief = ""
    @State private var prompt = ""
    @State private var installing = false
    init(model: WorkspaceModel) {
        self.model = model
        _session = State(initialValue: CreativeTaskSession(model: model))
        _client = State(initialValue: model.agentIntegration.association(for: model.workspaceID).client)
    }
    private var held: Bool { model.busy || session.held || model.writeLocked }
    private var closed: Bool { session.task["observation"]["state"].string == "closed" }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(model.t("resources.organize")).font(.system(size: 20, weight: .semibold)); Spacer()
            PageAgentButton(model: model, page: "resources")
                Button(model.t("common.close")) { dismiss() }.disabled(session.pending != nil).keyboardShortcut(.cancelAction)
            }
            if let error = session.error { Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if session.pending != nil { Button(model.t("drama.retry")) { Task { await session.retry() } } }
            HSplitView {
                ScrollView { preparation.padding(.trailing, 16) }.frame(minWidth: 320, idealWidth: 400, maxWidth: 480)
                ScrollView { handoff.frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 16) }.frame(minWidth: 390)
            }
        }.padding(24).frame(minWidth: 960, idealWidth: 1080, minHeight: 680, idealHeight: 800)
        .interactiveDismissDisabled(session.pending != nil)
        .task { await load(); await session.loadTasks() }
        .onChange(of: readable) { _, _ in invalidate() }
        .onChange(of: editable) { _, _ in invalidate() }
        .onChange(of: allowCreate) { _, _ in invalidate() }
        .onChange(of: client) { _, _ in invalidate() }
        .onChange(of: brief) { _, _ in invalidate() }
        .sheet(isPresented: $installing) {
            AgentInstallationSheet(settings: model.agentIntegration, workspaceID: model.workspaceID,
                association: AgentAssociation(client: client, suiteID: model.agentIntegration.association(for: model.workspaceID).suiteID),
                localizer: model.localizer, onSelection: { client = $0.client })
        }
    }
    private var preparation: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("resources.task_scope")).font(.system(size: 14, weight: .semibold))
            Toggle(model.t("resources.allow_create"), isOn: $allowCreate)
            ForEach(Array(records.enumerated()), id: \.offset) { _, item in
                let id = item["resource_id"].string ?? ""
                HStack {
                    Toggle(item["title"].string ?? "", isOn: Binding(get: { readable.contains(id) }, set: { value in
                        if value { readable.insert(id) } else { readable.remove(id); editable.remove(id) }
                    }))
                    Spacer()
                    if readable.contains(id), item["state"].string == "draft" {
                        Toggle(model.t("resources.allow_edit"), isOn: Binding(get: { editable.contains(id) }, set: { value in
                            if value { editable.insert(id) } else { editable.remove(id) }
                        })).fixedSize()
                    }
                }.toggleStyle(.checkbox)
            }
            if cursor != nil { Button(model.t("plot.more")) { Task { await load(more: true) } } }
            Text(model.t("resources.scope_note")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            Picker(model.t("agent.client"), selection: $client) { ForEach(AgentClient.allCases, id: \.self) { Text(model.t($0.titleKey)).tag($0) } }
            Button(model.t("agent.install_title")) { installing = true }
            Text(model.t("creative.request")).font(.system(size: 14, weight: .semibold))
            TextEditor(text: $brief).frame(height: 120).accessibilityLabel(model.t("creative.request"))
            Button(model.t("creative.preview_prompt")) { Task {
                session.startNew()
                let references = records.filter { readable.contains($0["resource_id"].string ?? "") }.map {
                    JSONValue.object(["resource_id": $0["resource_id"], "revision": $0["revision"], "sha256": $0["sha256"]])
                }
                await session.previewResources(references: references, editableIDs: editable.sorted(), allowCreate: allowCreate, client: client, brief: brief)
                prompt = session.preview["prompt"].string ?? ""
            } }.disabled(held || client == .none || brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Divider()
            Text(model.t("creative.history")).font(.system(size: 14, weight: .semibold))
            ForEach(Array(session.tasks.filter { $0["task_kind"].string == "resource_organize" }.enumerated()), id: \.offset) { _, item in
                Button(item["brief"].string ?? "") { Task { await session.loadTask(item["task_ref"]) } }.buttonStyle(.link).lineLimit(2)
            }
            if session.nextCursor != nil { Button(model.t("plot.more")) { Task { await session.loadTasks(append: true) } } }
        }
    }
    @ViewBuilder private var handoff: some View {
        if session.task != .null {
            VStack(alignment: .leading, spacing: 14) {
                Text(session.task["request"]["brief"].string ?? "").font(.system(size: 14, weight: .semibold))
                Text(session.task["request"]["prompt"].string ?? "").textSelection(.enabled)
                HStack {
                    Button(model.t("creative.copy_prompt")) {
                        Task {
                            guard await session.authorizeAccess() else { return }
                            let text = (session.task["request"]["prompt"].string ?? "") + "\nrequest_sha256: " + (session.task["request_sha256"].string ?? "")
                            NSPasteboard.general.clearContents()
                            if NSPasteboard.general.setString(text, forType: .string) { await session.markCopied() }
                        }
                    }.disabled(closed || held)
                    Button(model.t("creative.connection")) { copyConnection() }.disabled(closed)
                    Button(model.t("common.refresh")) { Task { await session.loadTask(session.taskReference) } }
                }
                if let root = model.workspace?.url {
                    LocalTaskViewControls(root: root, scope: .workspace, taskRef: session.taskReference, brief: session.task["request"]["brief"].string ?? "", locale: model.locale, closed: closed)
                }
                if closed { Text(model.t("creative.state.closed")).foregroundStyle(WorkbenchPalette.muted) }
                else { Button(model.t("creative.close_task")) { Task { await session.close(reason: model.t("creative.closed_by_author")) } }.disabled(held) }
                Text(model.t("resources.task_result_note")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            }
        } else if session.preview != .null {
            VStack(alignment: .leading, spacing: 14) {
                TextEditor(text: $prompt).frame(minHeight: 340).accessibilityLabel(model.t("creative.prompt"))
                DisclosureGroup(model.t("creative.outgoing")) {
                    Text(String(decoding: (try? session.preview["input_snapshot"].encoded(pretty: true)) ?? Data(), as: UTF8.self)).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                }
                Button(model.t("creative.prepare")) { Task { await session.prepare(prompt: prompt) } }.buttonStyle(WorkbenchButtonStyle(primary: true)).disabled(held)
            }
        } else { Text(model.t("creative.handoff_note")).foregroundStyle(WorkbenchPalette.muted) }
    }
    private func invalidate() { session.discardPreview(); prompt = "" }
    private func load(more: Bool = false) async {
        var input: [String: JSONValue] = ["limit": .integer(50)]
        if more, let cursor { input["cursor"] = .string(cursor) }
        if let next = await session.read("hetu.resources.list", input: input) { records = more ? records + next["resources"].array : next["resources"].array; cursor = next["next_cursor"].string }
    }
    private func copyConnection() {
        var helper = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/hetu-mcp")
        if !FileManager.default.isExecutableFile(atPath: helper.path) {
            let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false; panel.message = model.t("creative.select_helper")
            guard panel.runModal() == .OK, let url = panel.url else { return }; helper = url
        }
        do {
            guard let client = session.task["request"]["client_adapter"].string else { throw CreativeTaskError.invalidResult }
            let text = try TaskConnection.configuration(executable: helper, clientAdapter: client)
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        } catch { session.showError(error) }
    }
}
