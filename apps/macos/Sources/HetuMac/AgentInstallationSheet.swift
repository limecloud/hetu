import AppKit
import SwiftUI
import HetuNative

struct AgentInstallationSheet: View {
    let settings: AgentIntegrationSettings
    let workspaceID: String?
    let localizer: Localizer
    let onSelection: ((AgentAssociation) -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var client: AgentClient
    @State private var suiteID: String
    @State private var executable = AgentSuiteInstaller.findCodex()
    @State private var installing = false
    @State private var feedback: String?
    @State private var succeeded = false
    @State private var workbuddyDirectory = AgentPackageInspector.defaultWorkbuddyDirectory
    private let catalog = try? AgentSuiteCatalog.bundled()
    init(settings: AgentIntegrationSettings, workspaceID: String? = nil, association: AgentAssociation? = nil, localizer: Localizer, onSelection: ((AgentAssociation) -> Void)? = nil) {
        self.settings = settings; self.workspaceID = workspaceID; self.localizer = localizer; self.onSelection = onSelection
        let value = association ?? workspaceID.map { settings.association(for: $0) } ?? AgentAssociation(client: settings.defaultClient, suiteID: "general")
        _client = State(initialValue: value.client); _suiteID = State(initialValue: value.suiteID)
    }
    private func t(_ key: String) -> String { localizer.text(key) }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(t("agent.install_title")).font(.title2)
            Picker(t("agent.work_client"), selection: $client) {
                ForEach(AgentClient.allCases, id: \.self) { Text(t($0.titleKey)).tag($0) }
            }.disabled(installing)
            if let catalog {
                Picker(t("agent.suite"), selection: $suiteID) {
                    ForEach(catalog.suites) { Text(t($0.titleKey)).tag($0.id) }
                }.disabled(installing)
            }
            Text(t(client == .codex ? "agent.install_scope.codex" : client == .workbuddy ? "agent.install_scope.workbuddy" : "agent.install_scope.other"))
                .font(.callout).foregroundStyle(WorkbenchPalette.muted).lineSpacing(4)
            if client == .codex {
                if let executable { LabeledContent(t("agent.codex_cli")) { Text(executable.path).font(.caption).textSelection(.enabled) } }
                else { Label(t("agent.install_error.clientUnavailable"), systemImage: "exclamationmark.triangle").font(.callout) }
                Button(t("agent.choose_cli")) {
                    let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false
                    if panel.runModal() == .OK { executable = panel.url }
                }.disabled(installing)
            } else if client == .workbuddy {
                LabeledContent(t("agent.install_directory")) { Text(workbuddyDirectory.appendingPathComponent("skills").path).font(.caption).textSelection(.enabled) }
                Button(t("agent.choose_workbuddy")) {
                    let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true
                    panel.message = t("agent.choose_workbuddy_note")
                    if panel.runModal() == .OK, let url = panel.url { workbuddyDirectory = url }
                }.disabled(installing)
            }
            if installing { ProgressView(t("agent.installing")).controlSize(.small) }
            if let feedback {
                Label(feedback, systemImage: succeeded ? "checkmark.circle" : "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(succeeded ? WorkbenchPalette.jade : WorkbenchPalette.muted)
            }
            HStack {
                Button(t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(installing)
                Spacer()
                Button(t(client == .codex ? "agent.install_codex" : "agent.install_files")) { Task { await install() } }
                    .keyboardShortcut(.defaultAction).disabled(installing || ![.codex, .workbuddy].contains(client) || catalog == nil || (client == .codex && executable == nil))
            }
        }.padding(24).frame(width: 580).interactiveDismissDisabled(installing)
            .onChange(of: client) { _, _ in feedback = nil; succeeded = false }
            .onChange(of: suiteID) { _, _ in feedback = nil; succeeded = false }
    }
    private func install() async {
        guard let catalog, let suite = catalog.suites.first(where: { $0.id == suiteID }), !installing else { return }
        guard [.codex, .workbuddy].contains(client) else { feedback = t("agent.install_error.clientUnavailable"); return }
        installing = true; feedback = nil; succeeded = false
        defer { installing = false }
        let installer = AgentSuiteInstaller(codexExecutable: executable)
        let targetClient = client, configDirectory = workbuddyDirectory
        do {
            let receipt = try await Task.detached(priority: .userInitiated) {
                try targetClient == .codex ? installer.installCodex(suite: suite, catalog: catalog) : installer.installWorkBuddy(suite: suite, catalog: catalog, configDirectory: configDirectory)
            }.value
            settings.selectPackageDirectory(receipt.directory, client: client, suiteID: suiteID)
            let association = AgentAssociation(client: client, suiteID: suiteID)
            if let workspaceID { settings.associate(association, with: workspaceID) }
            onSelection?(association)
            succeeded = true; feedback = t(client == .codex ? "agent.install_success" : "agent.install_files_success")
        } catch { feedback = (error as? AgentInstallError).map { t($0.key) } ?? t("agent.install_error.commandFailed") }
    }
}
