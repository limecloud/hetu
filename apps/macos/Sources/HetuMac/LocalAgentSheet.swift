import AppKit
import SwiftUI
import HetuCore
import HetuNative

struct LocalAgentSheet: View {
    let localizer: Localizer
    let section: String
    var workspaceID: String?
    @Environment(\.dismiss) private var dismiss
    @State private var service = LocalAutomation()
    @State private var plans: [JSONValue] = []
    @State private var selected: String?
    @State private var error: String?
    @State private var copied = false
    @AppStorage("Hetu.ai.defaultClient") private var defaultClient = "none"
    private func t(_ key: String) -> String { localizer.text(key) }
    private var plan: JSONValue { plans.first { $0["operation_id"].string == selected } ?? .null }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(t("local.title")).font(.system(size: 20, weight: .semibold))
                Spacer()
                Button(t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            HStack {
                Button(t(copied ? "creative.copied" : "handoff.copy")) { copy() }.buttonStyle(WorkbenchButtonStyle(primary: true))
                Button(t("common.refresh")) { Task { await load() } }
            }
            if let error { Text(error).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if plans.isEmpty { Text(t("handoff.no_proposals")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted) }
            HSplitView {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(plans.enumerated()), id: \.offset) { _, value in
                            Button { selected = value["operation_id"].string } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(value["fixed"]["summary"].string ?? "").font(.system(size: 14, weight: selected == value["operation_id"].string ? .semibold : .regular))
                                    Text(t("handoff.state." + (value["state"].string ?? "pending"))).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.buttonStyle(.plain)
                        }
                    }.padding(.trailing, 12)
                }.frame(minWidth: 180, idealWidth: 220)
                ScrollView {
                    if plan != .null {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(plan["fixed"]["summary"].string ?? "").font(.system(size: 14, weight: .semibold))
                            if plan["fixed"]["kind"].string == "preferences" {
                                ForEach(plan["fixed"]["patch"].object.keys.sorted(), id: \.self) { field in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(t("local.field." + field)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                                        HStack { Text(value(plan["fixed"]["before"][field])); Image(systemName: "arrow.right"); Text(value(plan["fixed"]["patch"][field])) }.font(.system(size: 14))
                                    }
                                }
                            } else {
                                Text(t("agent.client." + (plan["fixed"]["agent_client"].string ?? "other"))).font(.system(size: 14))
                                Text(t("agent.suite." + (plan["fixed"]["suite_id"].string ?? "general"))).font(.system(size: 14))
                                Text(t(plan["fixed"]["install"].bool == true ? "local.install" : "local.choose")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
                            }
                            if ["pending", "approved", "rejected"].contains(plan["state"].string ?? "") {
                                HStack {
                                    Button(t("handoff.reject")) { Task { await decide(false) } }
                                    Button(t("handoff.approve")) { Task { await decide(true) } }.buttonStyle(WorkbenchButtonStyle(primary: true)).disabled(plan["state"].string == "approved")
                                }.padding(.top, 12)
                            }
                            if plan["state"].string == "approved" || plan["state"].string == "executing" {
                                Text(t("handoff.return_agent")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 16)
                    }
                }.frame(minWidth: 300)
            }
        }.padding(24).frame(width: 760, height: 540).background(WorkbenchPalette.page).foregroundStyle(WorkbenchPalette.ink).buttonStyle(WorkbenchButtonStyle())
            .task { await load() }
            .onReceive(DistributedNotificationCenter.default().publisher(for: LocalAutomation.plansChanged)) { _ in Task { await load() } }
    }
    private func value(_ value: JSONValue) -> String {
        if let text = value.string { return text }
        if let bool = value.bool { return t(bool ? "local.on" : "local.off") }
        return (try? value.encoded()).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
    private func load() async {
        do { plans = try await service.plans(); error = nil; if selected == nil { selected = plans.first?["operation_id"].string } }
        catch { self.error = localizer.error(error) }
    }
    private func decide(_ approve: Bool) async {
        do {
            guard let id = plan["operation_id"].string, let sha = plan["sha256"].string, let revision = plan["revision"].integer else { return }
            _ = try await service.decide(id: id, sha256: sha, revision: revision, approve: approve); await load()
        } catch { self.error = localizer.error(error) }
    }
    private func copy() {
        let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/hetu")
        guard FileManager.default.isExecutableFile(atPath: helper.path) else { error = t("handoff.cli_missing"); return }
        let client = defaultClient == "claudeCode" ? "claude-code" : ["codex", "workbuddy"].contains(defaultClient) ? defaultClient : "generic"
        let command = "'" + helper.path.replacingOccurrences(of: "'", with: "'\\''") + "' --client " + client
        let prompt = localizer.locale == "en"
            ? "Help me configure Hetu Luoshu (section: \(section)). Discover schemas using \(command) collaboration inspect. Read hetu.local_settings.get; use the actual preferences and suite IDs to prepare a complete local_settings.prepare proposal. Ask only for missing intent. I review the exact changes in Settings > AI review. After approval, execute with the same operation_id and sha256, then read the result. Do not manipulate the GUI, read credentials or claim a plugin is loaded in this session because it is installed. Recover unknown outcomes with the same operation reference and key."
            : "请帮助我设置河图洛书（当前区域：\(section)）。先用 \(command) collaboration inspect 发现实际 Schema，再调用 hetu.local_settings.get 读取可交接设置与题材套件。根据我的目标填好完整 local_settings.prepare 方案；仅询问缺少的意图，不要求我重新填表。我会在设置的 AI 审阅中确认确切变更。批准后以同一 operation_id、sha256 和原操作键执行，再回读结果。不操作 GUI，不读取密钥，不把插件安装说成当前会话已加载。结果未知沿原操作引用恢复，不重复安装。"
        let context = workspaceID.map { localizer.locale == "en" ? "\nFor this exact work, workspace_id: \($0). Include this ID in settings reads and the suite proposal; preserve other works." : "\n本次仅设置作品 workspace_id：\($0)。读取关联及准备套件方案时携带此 ID，保留其他作品选择。" } ?? ""
        NSPasteboard.general.clearContents(); copied = NSPasteboard.general.setString(prompt + context, forType: .string)
    }
}
