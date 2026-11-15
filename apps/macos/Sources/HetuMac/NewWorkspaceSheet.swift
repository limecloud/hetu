import AppKit
import SwiftUI
import HetuCore
import HetuNative

struct NewWorkspaceSheet: View {
    let model: WorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var session: CreationProjectSession
    @State private var client: AgentClient
    @State private var suiteID = "general"
    @State private var useAgent = false
    @State private var taskKind = "book_concept"
    @State private var prompt = ""
    @State private var installation = false
    @State private var closing = false
    @State private var copied = false
    @State private var openingBook = false
    @State private var showDetails = false
    @State private var machineCreation = false
    private let catalog = try? AgentSuiteCatalog.bundled()

    init(model: WorkspaceModel) {
        self.model = model
        _session = State(initialValue: CreationProjectSession(locale: model.locale))
        _client = State(initialValue: model.agentIntegration.defaultClient)
    }
    private var held: Bool { session.busy || session.held || openingBook }
    private var closedTask: Bool { session.task["observation"]["state"].string == "closed" }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(model.t("workspace.new")).font(.system(size: 20, weight: .semibold))
                Spacer()
                Button(model.t("handoff.action")) { machineCreation = true }
                if session.busy || openingBook { ProgressView().controlSize(.small) }
            }
            Picker(model.t("creation.work_type"), selection: Binding(get: { session.workType }, set: { session.setWorkProfile(workType: $0); prompt = "" })) {
                Text(model.t("creation.type.novel")).tag("novel")
                Text(model.t("creation.type.drama")).tag("drama")
            }.pickerStyle(.segmented).frame(maxWidth: 320).disabled(held || session.completed)
            if let error = session.error { Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if session.conflict != .null {
                DisclosureGroup(model.t("creation.compare_disk")) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(session.conflict["project"]["brief"].string ?? "").textSelection(.enabled)
                            ForEach([("title", "workspace.title"), ("author_name", "novel.author"), ("genre", "novel.genre"), ("synopsis", "novel.synopsis"), ("outline", "creation.outline")], id: \.0) { field, key in
                                LabeledContent(model.t(key)) { Text(session.conflict["project"]["selected_fields"][field]["value"].string ?? "").textSelection(.enabled) }
                            }
                        }
                    }.frame(maxHeight: 160)
                    Button(model.t("creation.use_latest_baseline")) { session.acceptConflictBaseline() }.disabled(held)
                }
            }
            if session.pending != nil {
                HStack {
                    Text(model.t("creation.recovery_note")).font(.system(size: 14))
                    Button(model.t("creation.recover")) { Task { await session.recover(); await openCreatedBook() } }.disabled(session.busy || openingBook)
                }
            }
            Picker(model.t("creation.method"), selection: $useAgent) {
                Text(model.t("creation.manual")).tag(false)
                Text(model.t("creation.external")).tag(true)
            }.pickerStyle(.segmented).disabled(held)
            GeometryReader { geometry in
                ScrollView {
                    if useAgent && geometry.size.width >= 900 {
                        HStack(alignment: .top, spacing: 32) {
                            creationFields.frame(width: 340)
                            collaboration.frame(maxWidth: .infinity, alignment: .leading)
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 24) {
                            creationFields
                            if useAgent { Divider(); collaboration }
                        }.frame(maxWidth: useAgent ? .infinity : 640, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            Divider()
            HStack {
                Button(model.t("common.close")) { if session.dirty { closing = true } else { dismiss() } }.keyboardShortcut(.cancelAction).disabled(session.busy || openingBook)
                Spacer()
                Button(model.t("creation.save")) { Task { if await session.save() { rememberClient() } } }.disabled(held || session.completed || session.conflict != .null)
                Button(session.workType == "drama" ? model.t("creation.create_drama") : model.t("creation.create")) { Task { await create() } }.keyboardShortcut(.defaultAction)
                    .buttonStyle(WorkbenchButtonStyle(primary: true))
                    .disabled(held || session.completed || session.conflict != .null || session.value("title").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(minWidth: 660, idealWidth: 1040, minHeight: 480, idealHeight: 700)
            .interactiveDismissDisabled(session.dirty || session.busy || session.held || openingBook)
            .task { await session.loadProjects() }
            .onChange(of: session.brief) { _, _ in prompt = "" }
            .onChange(of: client) { _, _ in prompt = "" }
            .onChange(of: suiteID) { _, _ in prompt = "" }
            .onChange(of: taskKind) { _, _ in prompt = "" }
            .confirmationDialog(model.t("creation.close_question"), isPresented: $closing) {
                Button(model.t("creation.save_close")) { Task { if await session.save() { rememberClient(); dismiss() } } }
                Button(model.t("creation.leave_unsaved"), role: .destructive) { dismiss() }
                Button(model.t("common.cancel"), role: .cancel) {}
            }
            .sheet(isPresented: $installation) {
                AgentInstallationSheet(settings: model.agentIntegration, association: AgentAssociation(client: client, suiteID: suiteID), localizer: model.localizer,
                    onSelection: { client = $0.client; suiteID = $0.suiteID })
            }
            .sheet(isPresented: $machineCreation) { AgentAccessSheet(initialEntry: .skills, localizer: model.localizer) }
    }
    private var creationFields: some View {
        VStack(alignment: .leading, spacing: 20) {
            authorFields
            DisclosureGroup(model.t("creation.saved")) { savedProjects }
        }
    }
    private var authorFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(session.workType == "drama" ? model.t("creation.drama_details") : model.t("creation.details")).font(.system(size: 14, weight: .semibold))
            TextField(session.workType == "drama" ? model.t("creation.optional_drama_title") : model.t("creation.optional_title"), text: field("title")).accessibilityLabel(model.t("workspace.title"))
            if session.workType == "drama" {
                Picker(model.t("drama.project_mode"), selection: Binding(get: { session.dramaMode }, set: { session.setWorkProfile(dramaMode: $0); prompt = "" })) {
                    Text(model.t("drama.mode.original")).tag("original")
                    Text(model.t("drama.mode.adaptation")).tag("adaptation")
                }
            }
            DisclosureGroup(model.t("creation.more_details"), isExpanded: $showDetails) {
                VStack(alignment: .leading, spacing: 12) {
                    if session.workType == "novel" {
                        TextField(model.t("novel.author"), text: field("author_name"))
                        TextField(model.t("novel.genre"), text: field("genre"))
                    }
                    Picker(model.t("novel.language"), selection: Binding(get: { session.languageTag }, set: { session.setWorkProfile(languageTag: $0); prompt = "" })) {
                        Text("简体中文").tag("zh-CN"); Text("English").tag("en")
                    }
                    Text(model.t("novel.synopsis")).font(.system(size: 14, weight: .semibold))
                    TextEditor(text: field("synopsis")).frame(height: 100).accessibilityLabel(model.t("novel.synopsis"))
                    Text(model.t("creation.outline")).font(.system(size: 14, weight: .semibold))
                    TextEditor(text: field("outline")).frame(height: 140).accessibilityLabel(model.t("creation.outline"))
                }.padding(.top, 8)
            }
            if session.value("title").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(model.t("creation.title_note")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            }
        }.disabled(held || session.completed)
    }
    private var savedProjects: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button(model.t("workspace.open")) { openProjectFolder() }.disabled(held || session.dirty)
            }
            ForEach(session.projects) { entry in
                Button { Task {
                    await session.open(entry.url)
                    let association = model.agentIntegration.association(for: session.projectID)
                    client = association.client; suiteID = association.suiteID; useAgent = client != .none; prompt = ""
                    showDetails = hasAdditionalFields
                } } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.title.isEmpty ? model.t("creation.untitled") : entry.title).lineLimit(1)
                        if !entry.brief.isEmpty { Text(entry.brief).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).lineLimit(2) }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain).disabled(held || session.dirty)
            }
        }
    }
    private var collaboration: some View {
        VStack(alignment: .leading, spacing: 14) {
            if useAgent {
                Text(model.t("creation.ideas")).font(.system(size: 14, weight: .semibold))
                TextEditor(text: Binding(get: { session.brief }, set: { session.brief = $0 })).frame(height: 90).accessibilityLabel(model.t("creation.ideas"))
                agentPreparation
                if session.preview != .null && !prompt.isEmpty {
                    TextEditor(text: $prompt).font(.system(.body, design: .monospaced)).frame(minHeight: 220).accessibilityLabel(model.t("creative.prompt"))
                    DisclosureGroup(model.t("creative.outgoing")) {
                        Text(String(decoding: (try? session.preview["input_snapshot"].encoded(pretty: true)) ?? Data(), as: UTF8.self))
                            .font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                    }
                    Button(model.t("creative.prepare")) { Task { await session.prepare(prompt: prompt); rememberClient() } }.disabled(held)
                }
                if session.task != .null { taskResult }
                taskHistory
            }
        }
    }
    private var agentPreparation: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker(model.t("agent.work_client"), selection: $client) {
                ForEach(AgentClient.allCases, id: \.self) { Text(model.t($0.titleKey)).tag($0) }
            }
            if let catalog {
                AgentSuitePicker(catalog: catalog, suiteID: $suiteID, localizer: model.localizer,
                    recommendationText: [session.value("genre"), session.brief].filter { !$0.isEmpty }.joined(separator: " "))
            }
            HStack {
                Picker(model.t("creation.task"), selection: $taskKind) {
                    Text(model.t("creation.concept")).tag("book_concept")
                    Text(model.t("creation.outline")).tag("outline")
                    Text(model.t("creation.cover")).tag("cover")
                }
                Button(model.t("agent.install_title")) { installation = true }.disabled(client == .none)
            }
            Button(model.t("creative.preview_prompt")) { Task {
                await session.previewTask(kind: taskKind, client: client, suiteID: suiteID)
                prompt = session.preview["prompt"].string ?? ""; rememberClient()
            } }.disabled(client == .none || session.brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Text(model.t("creative.handoff_note")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
        }.disabled(held || session.completed)
    }
    private var taskHistory: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            HStack {
                Text(model.t("creative.history")).font(.system(size: 14, weight: .semibold))
                Spacer()
                Button(model.t("creative.refresh")) { Task { await session.reload() } }
            }
            ForEach(Array(session.tasks.enumerated()), id: \.offset) { _, item in
                Button(item["brief"].string ?? model.t("creation.untitled")) { Task { await session.loadTask(item["task_ref"]) } }.buttonStyle(.plain)
            }
            if session.nextCursor != nil { Button(model.t("creative.more")) { Task { await session.loadMoreTasks() } } }
        }.disabled(held)
    }
    private var taskResult: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            Text(model.t("creative.state." + (session.task["observation"]["state"].string ?? "ready"))).font(.system(size: 14, weight: .semibold))
            HStack {
                Button(model.t("creative.copy_prompt")) { copyPrompt() }.disabled(closedTask)
                Button(model.t("creative.connection")) { copyConnection() }.disabled(closedTask)
                Button(model.t("creative.import_result")) { Task { await session.taskAction("hetu.creative_tasks.inspect_inbox") } }.disabled(closedTask)
                Button(model.t("creative.refresh")) { Task { await session.loadTask(session.taskReference) } }
            }.disabled(held)
            if copied { Text(model.t("creative.copied")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
            if let root = session.workspace?.url {
                LocalTaskViewControls(root: root, scope: .creationProject, taskRef: session.taskReference,
                    brief: session.task["request"]["brief"].string ?? "", locale: model.locale, closed: closedTask)
            }
            if session.task["observation"]["submission_refs"].array.count > 1 {
                Menu(model.t("creative.batches")) {
                    ForEach(Array(session.task["observation"]["submission_refs"].array.enumerated()), id: \.offset) { index, item in
                        Button(String(index + 1)) { Task { await session.loadTask(session.taskReference, submissionID: item["submission_id"].string) } }
                    }
                }.disabled(held)
            }
            if session.task["submission"]["complete"].bool == false {
                Text(session.task["submission"]["missing_items"].array.compactMap(\.string).joined(separator: "\n")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
            }
            ForEach(Array(session.task["submission"]["candidates"].array.enumerated()), id: \.offset) { _, candidate in candidateView(candidate) }
            TaskContinuationView(task: session.task, locale: model.locale, held: held,
                read: { await session.collaborationRead($0, input: $1) }, save: { await session.saveFeedback($0) })
                .id(session.task["request"]["task_id"].string)
            if !closedTask {
                Button(model.t("creative.close_task"), role: .destructive) { Task { await session.taskAction("hetu.creative_tasks.close") } }.disabled(held)
            }
        }
    }
    private func candidateView(_ candidate: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(candidate["title"].string ?? "").font(.system(size: 14, weight: .semibold))
            if let content = candidate["content"].string { Text(content).textSelection(.enabled) }
            if let preview = session.task["image_previews"].array.first(where: { $0["candidate_id"] == candidate["candidate_id"] }),
               let raw = preview["base64"].string, let data = Data(base64Encoded: raw), let image = NSImage(data: data) {
                Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 240).accessibilityLabel(candidate["title"].string ?? model.t("creation.cover"))
            }
            if candidate["kind"].string == "image" { Text(model.t("creation.cover_note")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
            else if candidate["content"].string != nil {
                Menu(model.t("creation.fill_field")) {
                    ForEach([("title", "workspace.title"), ("author_name", "novel.author"), ("genre", "novel.genre"), ("synopsis", "novel.synopsis"), ("outline", "creation.outline")], id: \.0) { field, key in
                        Button(model.t(key)) { session.select(candidate, field: field); prompt = ""; if field != "title" { showDetails = true } }
                    }
                }.disabled(held || session.completed)
            }
        }.padding(.vertical, 8)
    }
    private var hasAdditionalFields: Bool { ["author_name", "genre", "synopsis", "outline"].contains { !session.value($0).isEmpty } }
    private func field(_ name: String) -> Binding<String> { Binding(get: { session.value(name) }, set: { session.set(name, value: $0); prompt = "" }) }
    private func rememberClient() { model.agentIntegration.associate(AgentAssociation(client: client, suiteID: suiteID), with: session.projectID) }
    private func copyPrompt() {
        Task {
            guard await session.authorizeAccess() else { return }
            let text = (session.task["request"]["prompt"].string ?? "") + "\nrequest_sha256: " + (session.task["request_sha256"].string ?? "")
            NSPasteboard.general.clearContents(); copied = NSPasteboard.general.setString(text, forType: .string)
            if copied { await session.taskAction("hetu.creative_tasks.mark_copied") }
        }
    }
    private func copyConnection() {
        var helper = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/hetu-mcp")
        if !FileManager.default.isExecutableFile(atPath: helper.path) {
            let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.message = model.t("creative.select_helper")
            guard panel.runModal() == .OK, let url = panel.url else { return }; helper = url
        }
        do {
            guard let client = session.task["request"]["client_adapter"].string else { throw CreativeTaskError.invalidResult }
            let text = try TaskConnection.configuration(executable: helper, clientAdapter: client)
            NSPasteboard.general.clearContents(); _ = NSPasteboard.general.setString(text, forType: .string)
        } catch { session.showError(error) }
    }
    private func openProjectFolder() {
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.message = model.t("creation.open")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            await session.open(url)
            let association = model.agentIntegration.association(for: session.projectID)
            client = association.client; suiteID = association.suiteID; useAgent = client != .none; prompt = ""
            showDetails = hasAdditionalFields
        }
    }
    private func create() async {
        let panel = NSSavePanel(); panel.title = model.t("workspace.location"); panel.nameFieldStringValue = session.value("title").trimmingCharacters(in: .whitespacesAndNewlines)
        panel.canCreateDirectories = true; panel.isExtensionHidden = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if await session.createNovel(at: url, language: session.languageTag) != nil { await openCreatedBook() }
    }
    private func openCreatedBook() async {
        guard let path = session.created["target_path"].string, let id = session.created["created_workspace_ref"]["workspace_id"].string else { return }
        openingBook = true; defer { openingBook = false }
        if await model.open(URL(fileURLWithPath: path), expectedWorkspaceID: id) {
            model.agentIntegration.associate(AgentAssociation(client: client, suiteID: suiteID), with: id)
            await session.acknowledgeCreatedWorkspace()
            if session.pending == nil { dismiss() }
        }
    }
}
