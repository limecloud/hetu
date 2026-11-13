import AppKit
import SwiftUI
import HetuNative

/// 同一选择器用于设置、建书与安装；所有推荐均须显式选定才改变当前套件。
struct AgentSuitePicker: View {
    let catalog: AgentSuiteCatalog
    @Binding var suiteID: String
    let localizer: Localizer
    var recommendationText = ""
    @State private var expanded = false
    @State private var query = ""
    @State private var platform = ""
    @State private var channel = ""
    @State private var authorInput = ""
    @State private var reply = ""
    @State private var advice: AgentSuiteAdvice?
    @State private var feedback: String?

    private func t(_ key: String) -> String { localizer.text(key) }
    private var matching: [AgentSuite] { catalog.matchingSuites(query: query, platform: platform, channel: channel) }
    private var options: [AgentSuite] {
        // 筛选不静默切换作品已经选择的套件。
        let matchedIDs = Set(matching.map(\.id))
        return catalog.suites.filter { $0.id == suiteID || matchedIDs.contains($0.id) }
    }
    private var contextual: [AgentSuite] {
        recommendationText.isEmpty ? [] : Array(catalog.matchingSuites(query: recommendationText).filter { $0.id != "general" }.prefix(4))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker(t("agent.suite"), selection: $suiteID) {
                ForEach(options) { Text(t($0.titleKey)).tag($0.id) }
            }
            if let suite = catalog.suites.first(where: { $0.id == suiteID }) {
                Text(t("agent.suite_scope") + " " + t(suite.titleKey)).font(.caption).foregroundStyle(.secondary)
            }
            if !contextual.isEmpty {
                Text(t("agent.directory_matches")).font(.caption).foregroundStyle(.secondary)
                ForEach(contextual) { suite in
                    Button(t(suite.titleKey)) { suiteID = suite.id }.controlSize(.small)
                }
            }
            DisclosureGroup(t("agent.suite_find"), isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 10) {
                    TextField(t("agent.suite_search"), text: $query)
                    HStack {
                        Picker(t("agent.platform"), selection: $platform) {
                            Text(t("agent.all_platforms")).tag("")
                            Text("番茄小说").tag("fanqie"); Text("起点中文网").tag("qidian")
                        }
                        Picker(t("agent.channel"), selection: $channel) {
                            Text(t("agent.all_channels")).tag("")
                            Text(t("agent.channel.male")).tag("male")
                            Text(t("agent.channel.female")).tag("female")
                        }
                    }
                    if matching.isEmpty { Text(t("agent.no_suite_match")).font(.caption).foregroundStyle(.secondary) }
                    if !query.isEmpty {
                        ForEach(Array((catalog.categories ?? []).filter {
                            $0.name.localizedCaseInsensitiveContains(query) && (platform.isEmpty || $0.platform == platform)
                                && (channel.isEmpty || $0.channel == channel || $0.channel == "shared")
                        }.prefix(3))) { category in
                            Text(category.path).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Divider()
                    Text(t("agent.external_selection")).font(.callout)
                    Text(t("agent.external_selection_note")).font(.caption).foregroundStyle(.secondary)
                    TextField(t("agent.selection_brief"), text: $authorInput, axis: .vertical).lineLimit(2...4)
                    Button(t("agent.copy_selection_request")) {
                        let text = authorInput.isEmpty ? recommendationText : authorInput
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(catalog.selectionPrompt(authorInput: text), forType: .string)
                        feedback = t("agent.selection_copied")
                    }.controlSize(.small)
                    TextEditor(text: $reply).font(.system(.caption, design: .monospaced)).frame(height: 70)
                        .accessibilityLabel(t("agent.agent_advice"))
                        .onChange(of: reply) { _, _ in advice = nil; feedback = nil }
                    Button(t("agent.read_advice")) {
                        do { advice = try AgentSuiteAdvice.parse(reply, catalog: catalog); feedback = nil }
                        catch { advice = nil; feedback = t("agent.invalid_advice") }
                    }.controlSize(.small).disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if let feedback { Text(feedback).font(.caption).foregroundStyle(.secondary) }
                    ForEach(advice?.recommendations ?? []) { item in
                        if let suite = catalog.suites.first(where: { $0.id == item.suiteID }) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(t(suite.titleKey)).font(.callout)
                                Text(item.reason).font(.caption).textSelection(.enabled)
                                Button(t("agent.use_advice")) { suiteID = item.suiteID }.controlSize(.small)
                            }
                        }
                    }
                }.padding(.top, 8)
            }
        }
    }
}
