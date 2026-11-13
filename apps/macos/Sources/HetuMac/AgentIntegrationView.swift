import AppKit
import SwiftUI
import HetuNative

struct AgentIntegrationView: View {
    let settings: AgentIntegrationSettings
    let workspaceID: String?
    let localizer: Localizer
    @State private var previewSuite = "general"
    @State private var inspection: AgentPackageInspection?
    @State private var refreshID = UUID()
    @State private var showSkills = true
    @State private var showGuide = false
    @State private var showInstallation = false
    private let catalog = try? AgentSuiteCatalog.bundled()
    private func t(_ key: String) -> String { localizer.text(key) }
    private var association: AgentAssociation {
        workspaceID.map { settings.association(for: $0) } ?? AgentAssociation(client: settings.defaultClient, suiteID: previewSuite)
    }
    private var suite: AgentSuite? { catalog?.suites.first { $0.id == association.suiteID } }
    private var selectedDirectory: URL? { settings.packageDirectory(client: association.client, suiteID: association.suiteID) }
    private var probeID: String { "\(workspaceID ?? "settings")/\(association.client.rawValue)/\(association.suiteID)/\(selectedDirectory?.path ?? "")/\(refreshID)" }
    private func change(_ value: AgentAssociation) {
        if let workspaceID { settings.associate(value, with: workspaceID) }
        else { settings.defaultClient = value.client; previewSuite = value.suiteID }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label(t("agent.title"), systemImage: "puzzlepiece.extension").font(.headline)
                Spacer()
                Button { refreshID = UUID() } label: { Label(t("agent.refresh"), systemImage: "arrow.clockwise") }
                    .disabled(association.client == .none)
            }
            Picker(t(workspaceID == nil ? "agent.default_client" : "agent.work_client"), selection: Binding(get: { association.client }, set: { change(AgentAssociation(client: $0, suiteID: association.suiteID)) })) {
                ForEach(AgentClient.allCases, id: \.self) { Text(t($0.titleKey)).tag($0) }
            }.frame(maxWidth: 440)
            if let catalog {
                AgentSuitePicker(catalog: catalog, suiteID: Binding(get: { association.suiteID }, set: { change(AgentAssociation(client: association.client, suiteID: $0)) }), localizer: localizer)
            } else { Label(t("agent.catalog_error"), systemImage: "exclamationmark.triangle").foregroundStyle(WorkbenchPalette.muted) }
            if association.client == .none {
                Text(t("agent.manual_note")).font(.callout).foregroundStyle(WorkbenchPalette.muted)
            } else if let inspection {
                inspectionDetails(inspection)
            } else { ProgressView(t("agent.checking")).controlSize(.small) }
            if let suite, let catalog {
                DisclosureGroup(t("agent.skills"), isExpanded: $showSkills) {
                    VStack(spacing: 0) {
                        ForEach(catalog.skills, id: \.self) { skill in
                            HStack(spacing: 10) {
                                Image(systemName: inspection?.foundSkills.contains(skill) == true ? "checkmark.circle" : "circle.dashed")
                                    .foregroundStyle(inspection?.foundSkills.contains(skill) == true ? WorkbenchPalette.jade : WorkbenchPalette.muted)
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(t("agent.skill." + skill)).font(.callout)
                                    Text(skill).font(.caption).foregroundStyle(WorkbenchPalette.muted)
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 2) {
                                    Text(t(inspection?.foundSkills.contains(skill) == true ? "agent.skill_found" : "agent.skill_unverified"))
                                    if inspection?.foundSkills.contains(skill) == true, let version = inspection?.version {
                                        Text(localizer.text("agent.skill_version", ["version": version]))
                                    }
                                }.font(.caption).foregroundStyle(WorkbenchPalette.muted)
                            }.padding(.vertical, 7)
                            if skill != catalog.skills.last { Divider() }
                        }
                    }.padding(.top, 8)
                }
                ViewThatFits(in: .horizontal) {
                    HStack { packageActions(catalog: catalog, suite: suite) }
                    VStack(alignment: .leading, spacing: 8) { packageActions(catalog: catalog, suite: suite) }
                }.controlSize(.small)
            }
            Text(t(workspaceID == nil ? "agent.default_note" : "agent.work_note")).font(.caption).foregroundStyle(WorkbenchPalette.muted)
        }
        .task(id: probeID) { await inspect() }
        .sheet(isPresented: $showGuide) {
            VStack(alignment: .leading, spacing: 18) {
                Text(t("agent.package_guide")).font(.title2)
                Text(t(association.client == .codex ? "agent.guide.codex" : "agent.guide.other")).lineSpacing(5)
                Text(t("agent.guide.scope")).font(.callout).foregroundStyle(WorkbenchPalette.muted)
                if let catalog, let suite { Text(catalog.directory(for: suite).path).font(.caption).textSelection(.enabled) }
                Link(t("agent.official_guide"), destination: URL(string: "https://developers.openai.com/plugins/build/plugins")!)
                HStack { Spacer(); Button(t("common.ok")) { showGuide = false }.keyboardShortcut(.defaultAction) }
            }.padding(24).frame(width: 540)
        }
        .sheet(isPresented: $showInstallation, onDismiss: { refreshID = UUID() }) {
            AgentInstallationSheet(settings: settings, workspaceID: workspaceID, association: association, localizer: localizer, onSelection: change)
        }
    }
    @ViewBuilder private func packageActions(catalog: AgentSuiteCatalog, suite: AgentSuite) -> some View {
        Button(t("agent.install_title")) { showInstallation = true }
        Button(t("agent.package_guide")) { showGuide = true }
        Button(t("agent.bundled_package")) { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: catalog.directory(for: suite).path) }
        if association.client != .none {
            Button(t("agent.choose_package")) { choosePackage() }
            if selectedDirectory != nil {
                Button(t("agent.auto_detect")) { settings.selectPackageDirectory(nil, client: association.client, suiteID: suite.id) }
            }
        }
    }
    @ViewBuilder private func inspectionDetails(_ value: AgentPackageInspection) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            LabeledContent(t("agent.installation"), value: t("agent.state." + value.state.rawValue))
            LabeledContent(t("agent.version"), value: value.version ?? t("agent.unknown"))
            if let lockVersion = value.lockVersion {
                LabeledContent(t("agent.lock_version"), value: lockVersion)
                if lockVersion != value.version { Label(t("agent.lock_differs"), systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(WorkbenchPalette.muted) }
            }
            if let expected = value.expectedVersion {
                LabeledContent(t("agent.bundled_version"), value: expected)
                if value.versionDiffers { Label(t("agent.version_differs"), systemImage: "info.circle").font(.callout).foregroundStyle(WorkbenchPalette.muted) }
            }
            if association.client == .codex { LabeledContent(t("agent.registration"), value: t("agent.registration." + value.registration.rawValue)) }
            if let directory = value.directory {
                LabeledContent(t("agent.source")) {
                    Button { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: directory.path) } label: {
                        Text(directory.path).lineLimit(2).truncationMode(.middle).font(.caption)
                    }.buttonStyle(.link).help(directory.path)
                }
            }
            LabeledContent(t("agent.checked_at"), value: value.checkedAt.formatted(date: .omitted, time: .shortened))
            LabeledContent(t("agent.session"), value: t("agent.unverified"))
            LabeledContent(t("agent.mcp"), value: t("agent.unverified"))
            Text(t("agent.evidence_note")).font(.caption).foregroundStyle(WorkbenchPalette.muted)
        }.font(.callout).frame(maxWidth: 640)
    }
    private func choosePackage() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.message = t("agent.choose_package_note")
        if panel.runModal() == .OK, let directory = panel.url {
            settings.selectPackageDirectory(directory, client: association.client, suiteID: association.suiteID)
        }
    }
    private func inspect() async {
        inspection = nil
        guard let catalog, let suite, association.client != .none else { return }
        let client = association.client, directory = selectedDirectory
        let result = await Task.detached(priority: .utility) {
            AgentPackageInspector().inspect(suite: suite, catalog: catalog, client: client, selectedDirectory: directory)
        }.value
        guard !Task.isCancelled else { return }
        inspection = result
    }
}
