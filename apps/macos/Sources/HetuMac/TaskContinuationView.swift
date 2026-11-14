import AppKit
import SwiftUI
import HetuCore
import HetuNative

/// 原生与建书筹备复用同一成果反馈；写入由所属会话持久恢复。
struct TaskContinuationView: View {
    let task: JSONValue
    let locale: String
    let held: Bool
    let read: (String, [String: JSONValue]) async -> JSONValue?
    let save: ([String: JSONValue]) async -> JSONValue?
    @State private var selectedTarget: JSONValue = .null
    @State private var selectedTitle = ""
    @State private var comment = ""
    @State private var saved: JSONValue = .null
    @State private var feedback: JSONValue = .null
    @State private var working: JSONValue = .null
    @State private var workingPage: JSONValue = .null
    @State private var copied = false
    @State private var busy = false
    private var localizer: Localizer { Localizer(locale: locale) }
    private var taskRef: JSONValue { .object(["scope_ref": task["request"]["scope_ref"], "task_id": task["request"]["task_id"], "request_revision": task["request"]["request_revision"]]) }
    private var closed: Bool { task["observation"]["state"].string == "closed" }
    private var workingCopies: [JSONValue] { workingPage == .null ? task["working_copies"].array : workingPage["working_copies"].array }
    private var workingCursor: JSONValue { workingPage == .null ? task["working_copies_next_cursor"] : workingPage["next_cursor"] }
    private var continuationRef: JSONValue {
        if saved != .null { return saved["feedback_ref"] }
        return comment.isEmpty && task["last_feedback"]["intent"].string == "request_changes" ? task["feedback_head"] : .null
    }
    private var targets: [(String, JSONValue)] {
        let candidates = task["submission"]["candidates"].array.map { item in
            (item["title"].string ?? "", JSONValue.object(["kind": .string("candidate"), "candidate_ref": .object(["task_ref": taskRef, "submission_id": task["submission"]["submission_id"], "candidate_id": item["candidate_id"]])]))
        }
        let copies = workingCopies.map { item in
            ((item["title"].string ?? "") + " (" + localizer.text("creative.continue.working") + ")", JSONValue.object(["kind": .string("working_copy"), "working_copy_ref": item["current_revision_ref"]]))
        }
        let current = candidates + copies
        return selectedTarget != .null && !current.contains(where: { $0.1 == selectedTarget }) ? current + [(selectedTitle, selectedTarget)] : current
    }
    private func targetID(_ target: JSONValue) -> String { target["kind"].string == "candidate" ? (target["candidate_ref"]["candidate_id"].string ?? "") : (target["working_copy_ref"]["working_revision_id"].string ?? "") }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TaskContextView(taskRef: taskRef, locale: locale, held: held, read: read)
            if !workingCopies.isEmpty {
                DisclosureGroup(localizer.text("creative.continue.working")) {
                    ForEach(Array(workingCopies.enumerated()), id: \.offset) { _, copy in
                        Button(copy["title"].string ?? "") { Task {
                            busy = true; defer { busy = false }
                            if let result = await read("hetu.working_copies.get", ["task_ref": taskRef, "working_copy_ref": copy["current_revision_ref"]]) { working = result }
                        } }.buttonStyle(.link).disabled(held || busy)
                    }
                    if workingCursor.string != nil {
                        Button(localizer.text("creative.continue.more")) { Task { await loadMoreWorkingCopies() } }.disabled(held || busy)
                    }
                    if working != .null {
                        Text(working["revision"]["content"].string ?? "").font(.system(size: 14)).textSelection(.enabled)
                    }
                    Text(localizer.text("creative.continue.reference_only")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                }
            }
            if !targets.isEmpty {
                Divider()
                Text(localizer.text("creative.continue.title")).font(.system(size: 14, weight: .semibold))
                Picker(localizer.text("creative.continue.target"), selection: Binding(get: { targetID(selectedTarget) }, set: { id in
                    if let item = targets.first(where: { targetID($0.1) == id }) { selectedTarget = item.1; selectedTitle = item.0 }
                })) {
                    ForEach(targets.indices, id: \.self) { index in Text(targets[index].0).tag(targetID(targets[index].1)) }
                }.disabled(held || busy || closed)
                TextEditor(text: $comment).font(.system(size: 14)).frame(height: 75)
                    .overlay(Rectangle().stroke(WorkbenchPalette.muted.opacity(0.2), lineWidth: 0.5))
                    .accessibilityLabel(localizer.text("creative.continue.title")).disabled(held || busy || closed)
                HStack {
                    Button(localizer.text("creative.continue.save")) { Task { await saveFeedback() } }
                        .disabled(held || busy || closed || comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || comment.count > 4000)
                    if continuationRef != .null {
                        Button(localizer.text("creative.continue.copy")) {
                            guard let prompt = try? TaskContinuation.prompt(task: task, feedbackRef: continuationRef, locale: locale) else { return }
                            NSPasteboard.general.clearContents(); copied = NSPasteboard.general.setString(prompt, forType: .string)
                        }.disabled(held || busy || closed)
                    }
                }
                if continuationRef != .null { Text(localizer.text(copied ? "creative.continue.copied" : "creative.continue.saved")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
            }
            if !feedback["feedback"].array.isEmpty {
                DisclosureGroup(localizer.text("creative.continue.history")) {
                    ForEach(Array(feedback["feedback"].array.enumerated()), id: \.offset) { _, item in
                        Text(item["feedback"]["public_comment"].string ?? "").textSelection(.enabled)
                        Text(localizer.text(item["reported_result_refs"].array.isEmpty ? "creative.continue.waiting" : "creative.continue.received")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                    }
                    if feedback["next_cursor"].string != nil { Button(localizer.text("creative.continue.more")) { Task { await loadFeedback(more: true) } }.disabled(held || busy) }
                }
            }
        }
        .task(id: task["observation"]["revision"]) {
            workingPage = .null
            if selectedTarget == .null, let first = targets.first { selectedTarget = first.1; selectedTitle = first.0 }
            await loadFeedback()
        }
        .onChange(of: comment) { _, _ in saved = .null; copied = false }
        .onChange(of: selectedTarget) { _, _ in saved = .null; copied = false }
    }
    private func loadMoreWorkingCopies() async {
        guard !busy, workingCursor.string != nil else { return }
        busy = true; defer { busy = false }
        let previous = workingCopies
        if let result = await read("hetu.working_copies.list", ["task_ref": taskRef, "cursor": workingCursor, "limit": .integer(20)]) {
            var fields = result.object
            fields["working_copies"] = .array(previous + result["working_copies"].array)
            workingPage = .object(fields)
        }
    }
    private func loadFeedback(more: Bool = false) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        var input: [String: JSONValue] = ["task_ref": taskRef, "limit": .integer(20)]
        if more { input["after_cursor"] = feedback["next_cursor"] }
        if var result = await read("hetu.task_feedback.list", input) {
            if more { var fields = result.object; fields["feedback"] = .array(feedback["feedback"].array + result["feedback"].array); result = .object(fields) }
            feedback = result
        }
    }
    private func saveFeedback() async {
        guard selectedTarget != .null, !busy else { return }
        busy = true
        let input: [String: JSONValue] = ["task_ref": taskRef, "target_refs": .array([selectedTarget]),
            "expected_feedback_head": feedback == .null ? task["feedback_head"] : feedback["feedback_head"], "intent": .string("request_changes"),
            "public_comment": .string(comment), "selected_refs": .array([]), "operation_key": .string(UUID().uuidString)]
        let result = await save(input)
        busy = false
        if let result { saved = result; copied = false; await loadFeedback() }
    }
}
