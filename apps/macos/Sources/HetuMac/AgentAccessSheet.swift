import SwiftUI
import HetuNative

enum AgentEntryPoint: String, CaseIterable, Identifiable {
    case mcp = "MCP", cli = "CLI", skills = "Skills"
    var id: String { rawValue }
    var summaryKey: String {
        switch self {
        case .mcp: "agent.access.mcp_summary"
        case .cli: "agent.access.cli_summary"
        case .skills: "agent.access.skills_summary"
        }
    }
    var detailKey: String {
        switch self {
        case .mcp: "agent.access.mcp_detail"
        case .cli: "agent.access.cli_detail"
        case .skills: "agent.access.skills_detail"
        }
    }
}

struct AgentAccessSheet: View {
    let localizer: Localizer
    @Environment(\.dismiss) private var dismiss
    @State private var entry: AgentEntryPoint
    @State private var settings = AgentIntegrationSettings()

    init(initialEntry: AgentEntryPoint, localizer: Localizer) {
        self.localizer = localizer
        _entry = State(initialValue: initialEntry)
    }

    private func t(_ key: String) -> String { localizer.text(key) }
    private var guideURL: URL {
        let language = localizer.locale == "en" ? "en/" : ""
        return URL(string: "https://hetu.limeai.run/" + language + "docs/agents/#" + entry.rawValue.lowercased())!
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text(t("agent.access.title")).font(.system(size: 20, weight: .semibold))
                Spacer()
                Button(t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            Picker(t("agent.access.title"), selection: $entry) {
                ForEach(AgentEntryPoint.allCases) { value in Text(value.rawValue).tag(value) }
            }.pickerStyle(.segmented)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(t(entry.detailKey)).font(.system(size: 14)).fixedSize(horizontal: false, vertical: true)
                    Text(t("agent.access.scope")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                    Link(t("agent.access.guide"), destination: guideURL).font(.system(size: 14))
                    Rectangle().fill(WorkbenchPalette.line).frame(height: 0.5).accessibilityHidden(true)
                    AgentIntegrationView(settings: settings, workspaceID: nil, localizer: localizer)
                    DisclosureGroup(t("agent.access.why_title")) {
                        Text(t("agent.access.why_body")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted).padding(.top, 8)
                    }.font(.system(size: 14))
                }.padding(2)
            }
        }.padding(24).frame(width: 620, height: 600)
            .foregroundStyle(WorkbenchPalette.ink).background(WorkbenchPalette.page).tint(WorkbenchPalette.jade)
            .buttonStyle(WorkbenchButtonStyle())
    }
}
