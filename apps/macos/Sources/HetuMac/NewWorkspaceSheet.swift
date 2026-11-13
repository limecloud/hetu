import AppKit
import SwiftUI
import HetuNative

struct NewWorkspaceSheet: View {
    let model: WorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var client: AgentClient
    @State private var suiteID = "general"
    @State private var installation = false
    @State private var creating = false
    @FocusState private var titleFocused: Bool
    private let catalog = try? AgentSuiteCatalog.bundled()
    init(model: WorkspaceModel) {
        self.model = model
        _client = State(initialValue: model.agentIntegration.defaultClient)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(model.t("workspace.new")).font(.title2)
            Form {
                TextField(model.t("workspace.title"), text: $title).focused($titleFocused)
                Picker(model.t("agent.work_client"), selection: $client) {
                    ForEach(AgentClient.allCases, id: \.self) { Text(model.t($0.titleKey)).tag($0) }
                }
                if let catalog {
                    Picker(model.t("agent.suite"), selection: $suiteID) {
                        ForEach(catalog.suites) { Text(model.t($0.titleKey)).tag($0.id) }
                    }.disabled(client == .none)
                }
            }.formStyle(.grouped)
            if client == .none {
                Text(model.t("agent.manual_note")).font(.callout).foregroundStyle(.secondary)
            } else {
                Button(model.t("agent.install_title")) { installation = true }
                Text(model.t("agent.work_note")).font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t("common.create")) { Task { await create() } }.keyboardShortcut(.defaultAction)
                    .buttonStyle(WorkbenchButtonStyle(primary: true))
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 540).disabled(creating).interactiveDismissDisabled(creating)
        .onAppear { titleFocused = true }
        .sheet(isPresented: $installation) {
            AgentInstallationSheet(settings: model.agentIntegration,
                association: AgentAssociation(client: client, suiteID: suiteID), localizer: model.localizer,
                onSelection: { client = $0.client; suiteID = $0.suiteID })
        }
    }
    private func create() async {
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !creating else { return }
        let panel = NSSavePanel(); panel.title = model.t("workspace.location"); panel.nameFieldStringValue = name
        panel.canCreateDirectories = true; panel.isExtensionHidden = false; panel.canSelectHiddenExtension = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        creating = true; defer { creating = false }
        if await model.open(url, title: name) {
            model.agentIntegration.associate(AgentAssociation(client: client, suiteID: suiteID), with: model.workspaceID)
            dismiss()
        }
    }
}
