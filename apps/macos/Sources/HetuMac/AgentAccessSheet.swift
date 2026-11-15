import SwiftUI
import HetuNative
import AppKit

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
    @State private var copied = false

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
                    Button(t(copied ? "creative.copied" : "handoff.copy_start")) {
                        let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/hetu")
                        guard FileManager.default.isExecutableFile(atPath: helper.path) else { return }
                        let command = "'" + helper.path.replacingOccurrences(of: "'", with: "'\\''") + "' --client " + (settings.defaultClient == .claudeCode ? "claude-code" : settings.defaultClient == .none || settings.defaultClient == .other ? "generic" : settings.defaultClient.rawValue)
                        let prompt = localizer.locale == "en"
                            ? "Use hetu-setup and the appropriate creation skill to help me start a novel, screenplay or video project in Hetu Luoshu. Discover the actual actions with \(command) collaboration inspect. Start with the discovered preparation action for the chosen work type, preserve management_ref and the reserved target_path, fill the preparation data in this conversation, then create the work through CLI/MCP and continue within the available authorized actions. Do not require an empty upstream novel or screenplay. Do not ask me to fill the GUI form, operate the GUI, scan other works, or adopt/finalize text. If I have not provided a goal, ask what I want to create. Report the exact created location and capability gaps."
                            : "请使用 hetu-setup 和对应创作 Skill，协助我在河图洛书筹备小说、剧本或视频。先用 \(command) collaboration inspect 发现真实动作，从所选类型对应的公开筹备动作开始，保留 management_ref 和预留 target_path，在当前对话填好筹备资料，再通过 CLI/MCP 创建作品，并在已有授权和实际能力内继续。不要求先建空小说或空剧本，不要求我回 GUI 填表，不操作 GUI，不扫描其他作品，不采纳或定稿正文。我还没说目标时，先问这次想创作什么。返回确切保存位置，并说明当前机器能力的缺口。"
                        NSPasteboard.general.clearContents(); copied = NSPasteboard.general.setString(prompt, forType: .string)
                    }.buttonStyle(WorkbenchButtonStyle(primary: true))
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
