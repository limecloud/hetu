import SwiftUI
import HetuCore
import HetuNative

struct ReviewWorkbenchView: View {
    let model: WorkspaceModel
    var initialDraftID = ""
    let onOpenDocument: (String, String?) -> Void
    @State private var selection = ""
    @State private var stateFilter = ""
    @State private var rows: [JSONValue] = []
    @State private var cursor: String?
    @State private var context: JSONValue = .null
    @State private var reportID = ""
    @State private var comments = ""
    @State private var privateComments = ""
    @State private var coverage = ""
    @State private var error: String?
    @State private var pending: DramaOperation?
    @State private var reportSheet: DramaSheet?
    @State private var rewriteSheet: DramaSheet?
    @State private var compareSheet: DramaSheet?
    @State private var adoptionSheet: DramaSheet?
    private var draft: JSONValue { context["draft"] }
    private var state: String { draft["state"].string ?? "submitted" }
    private var held: Bool { pending != nil || !model.pendingStructureOperations.isEmpty }
    private var selectedReport: JSONValue? { context["reports"].array.first { $0["reference"]["report_id"].string == reportID } }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            WorkbenchHeading(title: model.t("review.title"), subtitle: model.t("review.description"), artwork: context == .null ? "" : "review-desk") {
                Button(model.t("common.refresh")) { Task { await loadRows(); await load() } }.disabled(pending != nil)
            }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if pending != nil { Button(model.t("drama.retry")) { Task { await perform() } } }
            HSplitView {
                VStack(alignment: .leading) {
                    Picker(model.t("review.state"), selection: $stateFilter) {
                        Text(model.t("review.all")).tag("")
                        ForEach(["submitted", "in_review", "approved", "changes_requested", "rejected", "superseded"], id: \.self) { Text(model.t("review.state." + $0)).tag($0) }
                    }
                    List(selection: $selection) {
                        ForEach(Array(rows.enumerated()), id: \.offset) { _, item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item["title"].string ?? model.t("draft.untitled"))
                                Text(model.t("review.state." + (item["state"].string ?? "submitted"))).font(.caption).foregroundStyle(.secondary)
                            }.tag(item["draft_id"].string ?? "")
                        }
                    }
                    .scrollContentBackground(.hidden).tint(WorkbenchPalette.jade)
                    if cursor != nil { Button(model.t("plot.more")) { Task { await loadRows(more: true) } } }
                }.frame(minWidth: 180, idealWidth: 220, maxWidth: 270).disabled(held)
                if context == .null {
                    WorkbenchEmptyState(title: model.t("review.select"), detail: model.t("review.empty_detail"), artwork: "review-desk")
                } else { reviewContent.frame(minWidth: 380) }
            }
        }.padding(28).workbenchPage().disabled(model.busy)
        .task { selection = initialDraftID; await loadRows(); if !selection.isEmpty { await load() } }
        .onChange(of: selection) { _, _ in
            context = .null; comments = ""; privateComments = ""; coverage = ""; reportID = ""; error = nil
            Task { await load() }
        }
        .onChange(of: stateFilter) { _, _ in Task { await loadRows() } }
        .sheet(item: $reportSheet, onDismiss: { Task { await load() } }) { request in ReviewReportSheet(model: model, reportID: request.value.string ?? "") }
        .sheet(item: $rewriteSheet) { request in ReviewRewriteSheet(model: model, original: request.value) { id in selection = id; Task { await loadRows(); await load() } } }
        .sheet(item: $compareSheet) { request in ReviewComparisonSheet(model: model, context: request.value) }
        .sheet(item: $adoptionSheet, onDismiss: { Task { await loadRows(); await load() } }) { request in DraftAdoptionSheet(model: model, context: request.value, onAdopted: onOpenDocument) }
    }
    private var reviewContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(draft["title"].string ?? context["baseline"]["document"]["title"].string ?? model.t("draft.untitled")).font(.headline)
                    Spacer()
                    Text(model.t("review.state." + state)).foregroundStyle(.secondary)
                }
                Text(model.t("review.provenance", ["source": model.t(draft["actor_ref"].string?.hasSuffix("000000000002") == true ? "review.agent" : "review.author"), "date": model.localizer.date(draft["created_at"].string ?? ""), "revision": String(draft["revision"].integer ?? 0)])).font(.caption).foregroundStyle(.secondary)
                if context["stale"].bool == true { Text(model.t("review.stale")).foregroundStyle(.orange) }
                HStack {
                    if state == "submitted" { Button(model.t("review.begin")) { start("hetu.reviews.begin", ["draft_id": draft["draft_id"], "expected_draft_revision": draft["revision"]]) } }
                    if context["evidence_ready"].bool == true && ["submitted", "in_review"].contains(state) {
                        Button(model.t("review.validate")) { start("hetu.reviews.validate", ["draft_id": draft["draft_id"], "expected_draft_revision": draft["revision"], "plot_options": .object([:]), "validation_options": .object([:])]) }
                    }
                    if context["baseline"] != .null { Button(model.t("review.compare")) { compareSheet = DramaSheet(value: context) } }
                    if ["changes_requested", "rejected"].contains(state) { Button(model.t("review.rewrite")) { rewriteSheet = DramaSheet(value: context) } }
                    if ["submitted", "in_review", "approved"].contains(state) { Button(model.t("adoption.title")) { adoptionSheet = DramaSheet(value: context) } }
                    if let doc = draft["approved_document_id"].string { Button(model.t("review.open_document")) { onOpenDocument(doc, nil) } }
                }.disabled(held)
                HStack(alignment: .top, spacing: 28) {
                    Text(context["content"].string ?? "").font(.custom("Songti SC", size: 17)).lineSpacing(10)
                        .textSelection(.enabled).frame(minWidth: 220, maxWidth: .infinity, alignment: .leading).padding(24)
                        .background(WorkbenchPalette.page, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(WorkbenchPalette.line, lineWidth: 0.5))
                    if ["in_review", "approved"].contains(state) { decisionForm.frame(width: 260) }
                }
                Text(model.t("review.report_note")).font(.caption).foregroundStyle(.secondary)
                Picker(model.t("review.report"), selection: $reportID) {
                    Text(model.t("plot.unspecified")).tag("")
                    ForEach(Array(context["reports"].array.enumerated()), id: \.offset) { _, item in
                        Text(model.localizer.date(item["created_at"].string ?? "") + "  " + model.t("validation.status." + (item["status"].string ?? "partial")) + (item["stale"].bool == true ? "  " + model.t("review.old_report") : "")).tag(item["reference"]["report_id"].string ?? "")
                    }
                }.disabled(held)
                if !reportID.isEmpty { Button(model.t("review.view_report")) { reportSheet = DramaSheet(value: .string(reportID)) } }
                if context["reports_next_cursor"].string != nil { Button(model.t("plot.more")) { Task { await load(moreReports: true) } }.disabled(held) }
                if !context["decisions"].array.isEmpty {
                    Divider(); Text(model.t("review.history")).font(.headline)
                    ForEach(Array(context["decisions"].array.reversed().enumerated()), id: \.offset) { _, item in
                        Text(model.t("review.decision." + (item["decision"].string ?? "rejected")) + "  " + model.localizer.date(item["decided_at"].string ?? "")).font(.headline)
                        Text(item["comments"].string ?? "").textSelection(.enabled)
                        if let note = item["private_comments"].string, !note.isEmpty { Text(model.t("review.private") + (model.locale == "en" ? ": " : "：") + note).foregroundStyle(.secondary).textSelection(.enabled) }
                        if let reason = item["coverage_acknowledgement"].string, !reason.isEmpty { Text(model.t("review.coverage") + (model.locale == "en" ? ": " : "：") + reason).font(.caption).textSelection(.enabled) }
                        Divider()
                    }
                }
            }.padding(.leading, 14).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private var decisionForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.t("review.comments"))
            TextEditor(text: $comments).frame(height: 80).border(Color.secondary.opacity(0.2)).accessibilityLabel(model.t("review.comments"))
            TextField(model.t("review.private"), text: $privateComments).textFieldStyle(.roundedBorder)
            TextField(model.t("review.coverage"), text: $coverage).textFieldStyle(.roundedBorder)
            Text(model.t("review.decision_note")).font(.caption).foregroundStyle(.secondary)
            HStack {
                if state == "in_review" {
                    Button(model.t("review.decision.approved")) { decide("approved") }.buttonStyle(WorkbenchButtonStyle(primary: true)).disabled(selectedReport == nil || selectedReport?["stale"].bool != false || context["stale"].bool == true)
                    Button(model.t("review.decision.changes_requested")) { decide("changes_requested") }
                    Button(model.t("review.decision.rejected")) { decide("rejected") }
                } else { Button(model.t("review.decision.withdrawn")) { decide("withdrawn") } }
            }.disabled(comments.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }.disabled(held)
    }
    private func start(_ action: String, _ input: [String: JSONValue]) {
        guard !held else { return }; var fixed = input; fixed["operation_key"] = .string(UUID().uuidString)
        pending = DramaOperation(action: action, input: fixed); Task { await perform() }
    }
    private func decide(_ decision: String) {
        let reference = selectedReport?["reference"]
        start("hetu.reviews.decide", ["draft_id": draft["draft_id"], "expected_draft_revision": draft["revision"], "input_snapshot": context["input_snapshot"], "report_refs": .array(decision == "approved" ? reference.map { [$0] } ?? [] : []), "decision": .string(decision), "comments": .string(comments), "private_comments": .string(privateComments), "coverage_acknowledgement": .string(coverage)])
    }
    private func perform() async {
        guard let fixed = pending else { return }; error = nil
        if let result = await model.workspaceAction(fixed.action, input: fixed.input, onFailure: { error = $0; if $1 { pending = nil } }) {
            pending = nil
            if fixed.action == "hetu.reviews.decide" { comments = ""; privateComments = ""; coverage = "" }
            if let id = result["draft"]["draft_id"].string { selection = id }
            await loadRows(); await load()
        }
    }
    private func loadRows(more: Bool = false) async {
        var input: [String: JSONValue] = ["limit": .integer(50)]
        if !stateFilter.isEmpty { input["state"] = .string(stateFilter) }; if more, let cursor { input["cursor"] = .string(cursor) }
        if let page = await model.workspaceAction("hetu.reviews.list", input: input, onFailure: { error = $0; _ = $1 }) { rows = more ? rows + page["reviews"].array : page["reviews"].array; cursor = page["next_cursor"].string }
    }
    private func load(moreReports: Bool = false) async {
        guard !selection.isEmpty else { context = .null; return }
        let requestedID = selection
        var input: [String: JSONValue] = ["draft_id": .string(requestedID)]
        if moreReports, let cursor = context["reports_next_cursor"].string { input["report_cursor"] = .string(cursor) }
        if var next = await model.workspaceAction("hetu.reviews.get", input: input, onFailure: { error = $0; _ = $1 }) {
            guard requestedID == selection else { return }
            if moreReports { var fields = next.object; fields["reports"] = .array(context["reports"].array + next["reports"].array); next = .object(fields) }
            context = next
            if !next["reports"].array.contains(where: { $0["reference"]["report_id"].string == reportID }) { reportID = next["reports"].array.first?["reference"]["report_id"].string ?? "" }
        }
    }
}

struct ReviewReportSheet: View {
    let model: WorkspaceModel
    let reportID: String
    @Environment(\.dismiss) private var dismiss
    @State private var result: JSONValue = .null
    @State private var blueprint: JSONValue = .null
    @State private var error: String?
    @State private var source: DramaSheet?
    @State private var disposition: DramaSheet?
    @State private var plotSheet: DramaSheet?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("review.view_report")).font(.title2)
            if let error { Text(error).foregroundStyle(.red) }
            if result["stale"].bool == true { Text(model.t("review.old_report")).foregroundStyle(.orange) }
            Button(model.t("review.plot_annotations")) {
                plotSheet = DramaSheet(value: result["report"]["input_snapshot"]["source_revisions"].array.first ?? .null)
            }.disabled(result == .null)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ValidationCoverageView(model: model, result: result, sourceTitle: model.t("review.content"))
                    ForEach(Array(result["report"]["findings"].array.enumerated()), id: \.offset) { _, finding in
                        Text(model.t(finding["message_key"].string ?? "validation.prerequisites")).font(.headline)
                        Text(model.t("rule.severity." + (finding["severity"].string ?? "info")) + "  " + model.t("validation.certainty." + (finding["certainty"].string ?? "unknown"))).font(.caption).foregroundStyle(.secondary)
                        if !finding["missing_prerequisites"].array.isEmpty {
                            Text(finding["missing_prerequisites"].array.compactMap(\.string).map { model.t("validation.missing." + $0) }.joined(separator: "\n")).font(.caption)
                        }
                        FindingEvidenceView(model: model, finding: finding, blueprint: blueprint)
                        ForEach(Array(finding["source_refs"].array.enumerated()), id: \.offset) { _, ref in
                            Button(ref["quote"].string ?? model.t("plot.source")) { source = DramaSheet(value: ref) }.buttonStyle(.link)
                        }
                        Button(model.t("validation.review")) { disposition = DramaSheet(value: finding) }
                        Divider()
                    }
                    Text(model.t("review.unknown_count", ["count": String(result["report"]["coverage"]["counts"]["unknown"].integer ?? 0)])).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
        }.padding(24).frame(width: 740, height: 560).disabled(model.busy).task { await load() }
        .sheet(item: $source) { request in PlotSourceView(model: model, source: request.value) }
        .sheet(item: $plotSheet, onDismiss: { Task { await load() } }) { request in
            VStack {
                PlotWorkbenchView(model: model, fixedSource: request.value, initialPlotRevisionID: result["report"]["input_snapshot"]["plot_revision_id"].string ?? "")
                Button(model.t("common.close")) { plotSheet = nil }.keyboardShortcut(.cancelAction).padding(.bottom, 16)
            }.frame(width: 1020, height: 680)
        }
        .sheet(item: $disposition) { request in
            let current = result["dispositions"].array.first { $0["finding_id"] == request.value["finding_id"] }
            FindingDispositionSheet(model: model, report: result["report"], finding: request.value, current: current?["current"] ?? .object(["revision": .integer(0), "disposition": .string("open")]), history: current?["history"].array ?? []) { Task { await load() } }
        }
    }
    private func load() async {
        if let next = await model.readReport(reportID, onFailure: { error = $0 }) {
            result = next
            if let revision = next["report"]["input_snapshot"]["blueprint_revision"].integer, let bible = await model.readBibleRevision(revision, onFailure: { error = $0 }) { blueprint = bible["blueprint"] }
        }
    }
}

struct ReviewComparisonSheet: View {
    let model: WorkspaceModel
    let context: JSONValue
    @Environment(\.dismiss) private var dismiss
    @State private var mode = "changes"
    @State private var difference: RevisionDifference?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("review.compare")).font(.title2)
            Text(model.t("review.compare_note")).foregroundStyle(.secondary)
            Picker(model.t("review.compare"), selection: $mode) {
                Text(model.t("review.line_changes")).tag("changes")
                Text(model.t("review.side_by_side")).tag("side_by_side")
            }.pickerStyle(.segmented)
            if mode == "changes" {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        if let difference {
                            if !difference.withinBudget { Text(model.t("review.diff_budget")).foregroundStyle(.orange) }
                            else {
                                Text(model.t("review.diff_count", ["count": String(difference.totalChanges)]))
                                ForEach(difference.changes) { change in
                                    HStack(alignment: .top) {
                                        Text(model.t(change.added ? "review.added_line" : "review.removed_line", ["line": String(change.line)])).font(.caption).foregroundStyle(change.added ? .green : .red)
                                        Text(change.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                }
                                if difference.totalChanges > difference.changes.count { Text(model.t("review.diff_limit")).font(.caption) }
                            }
                        } else { ProgressView() }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            } else { HSplitView {
                sourcePane(context["baseline"], label: "review.baseline")
                VStack(alignment: .leading) { Text(model.t("review.content")).font(.headline); ScrollView { Text(context["content"].string ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) } }.frame(minWidth: 300)
            } }
            Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
        }.padding(24).frame(width: 920, height: 600)
        .task {
            let before = context["baseline"]["content"].string ?? "", after = context["content"].string ?? ""
            difference = await Task.detached(priority: .userInitiated) { RevisionDifference.compare(before: before, after: after) }.value
        }
    }
    private func sourcePane(_ value: JSONValue, label: String) -> some View {
        VStack(alignment: .leading) { Text(model.t(label)).font(.headline); ScrollView { Text(value["content"].string ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) } }.frame(minWidth: 300)
    }
}
