import SwiftUI
import HetuCore
import HetuNative

/// 仅记录作者对固定计划的决定；生成继续由外部 Agent 执行。
struct ModelPlanReviewView: View {
    let task: JSONValue
    let locale: String
    let held: Bool
    let read: (String, [String: JSONValue]) async -> JSONValue?
    let approve: ([String: JSONValue]) async -> JSONValue?
    @State private var plans: [JSONValue] = []
    @State private var busy = false
    @State private var failed = false
    private var localizer: Localizer { Localizer(locale: locale) }
    private var taskRef: JSONValue {
        .object(["scope_ref": task["request"]["scope_ref"], "task_id": task["request"]["task_id"], "request_revision": task["request"]["request_revision"]])
    }
    private var closed: Bool { task["observation"]["state"].string == "closed" }
    var body: some View {
        Group {
            if !plans.isEmpty || busy || failed {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(localizer.text("models.plans")).font(.system(size: 14, weight: .semibold))
                        Spacer()
                        Button(localizer.text("models.refresh")) { Task { await refresh() } }.disabled(held || busy)
                    }
                    if busy { ProgressView().controlSize(.small) }
                    if failed { Text(localizer.text("models.plans_failed")).foregroundStyle(WorkbenchPalette.danger) }
                    ForEach(Array(plans.enumerated()), id: \.offset) { _, record in
                        planRow(record)
                    }
                }
            }
        }
        .task(id: task["request"]["task_id"]) { plans = []; await refresh() }
    }
    private func planRow(_ record: JSONValue) -> some View {
        let plan = record["plan"]
        let provider = plan["billing_mode"].string == "provider"
        return VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text(plan["title"].string ?? "").font(.system(size: 14, weight: .medium))
            Text(plan["payload"]["model_id"].string ?? "").font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
            Text(plan["connection"]["origin"].string ?? "").font(.system(size: 12)).textSelection(.enabled)
            if provider {
                Text(localizer.text("models.provider_billing")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            } else {
                Text((plan["estimated_credits"].string ?? "") + " Credits").font(.system(size: 12))
            }
            DisclosureGroup(localizer.text("models.outgoing")) {
                Text(plan["payload"]["prompt"].string ?? plan["payload"]["input"].string ?? "").textSelection(.enabled)
                if let instructions = plan["payload"]["instructions"].string, !instructions.isEmpty {
                    Text(instructions).textSelection(.enabled)
                }
                Text(plan["plan_id"].string ?? "").font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
            }
            if record["submitted"].bool == true {
                Text(localizer.text("models.submitted")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            } else if record["approval"] != .null {
                Text(localizer.text("models.approved")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            } else {
                Text(localizer.text(provider ? "models.provider_approval_note" : "models.approval_note")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                Button(localizer.text(provider ? "models.provider_approve" : "models.approve")) {
                    Task { await approvePlan(record) }
                }.disabled(held || busy || closed)
            }
        }
    }
    @MainActor private func refresh() async {
        guard !busy, !held else { return }
        busy = true; defer { busy = false }
        if let value = await read("hetu.model_tasks.list", ["task_ref": taskRef]) {
            plans = value["plans"].array; failed = false
        } else { failed = true }
    }
    @MainActor private func approvePlan(_ record: JSONValue) async {
        guard !busy, !held, !closed else { return }
        busy = true
        var input: [String: JSONValue] = ["task_ref": taskRef, "plan_id": record["plan"]["plan_id"], "plan_sha256": record["plan_sha256"], "operation_key": .string(UUID().uuidString)]
        if record["plan"]["billing_mode"].string == "provider" { input["provider_billing_accepted"] = .bool(true) }
        else { input["max_credits"] = record["plan"]["estimated_credits"] }
        let result = await approve(input)
        busy = false
        if result != nil { await refresh() }
    }
}
