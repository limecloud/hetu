import SwiftUI
import HetuCore
import HetuNative

func lifecycleDocumentRef(_ value: JSONValue) -> JSONValue {
    .object(["document_id": value["document"]["document_id"], "revision_id": value["revision"]["revision_id"], "sha256": value["revision"]["sha256"]])
}

struct DocumentFinalizationSheet: View {
    let model: WorkspaceModel
    let documentID: String
    @Environment(\.dismiss) private var dismiss
    @State private var current: JSONValue = .null
    @State private var history: JSONValue = .null
    @State private var report: JSONValue = .null
    @State private var reportReference: JSONValue = .null
    @State private var preview: JSONValue = .null
    @State private var comments = ""
    @State private var coverage = ""
    @State private var error: String?
    @State private var pending: DramaOperation?
    @State private var showWithdraw = false
    @State private var reportSheet: DramaSheet?
    private var held: Bool { pending != nil || !model.pendingStructureOperations.isEmpty }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.t("finalization.title")).font(.title2)
            Text(model.t("finalization.note")).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if pending != nil { Button(model.t("drama.retry")) { Task { await perform() } } }
            if current != .null {
                HStack {
                    Text(current["document"]["title"].string ?? "").font(.headline)
                    Spacer()
                    Text(model.t(stateKey)).foregroundStyle(.secondary)
                }
                evidence
                Group {
                    TextField(model.t("finalization.reason"), text: $comments).textFieldStyle(.roundedBorder)
                    TextField(model.t("review.coverage"), text: $coverage).textFieldStyle(.roundedBorder)
                }.disabled(held)
                if preview != .null {
                    if preview["eligible"].bool == true { Label(model.t("finalization.ready"), systemImage: "checkmark.circle").foregroundStyle(.green) }
                    else { Text(model.localizer.error(CoreError.business(.object(["error": preview["blocker"]])))).foregroundStyle(.orange) }
                }
                actions
            }
            HStack { Spacer(); Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(held) }
        }.padding(24).frame(minWidth: 740, idealWidth: 880, minHeight: 560, idealHeight: 700).disabled(model.busy)
        .interactiveDismissDisabled(held)
        .task { await load() }
        .onChange(of: comments) { _, _ in preview = .null }
        .onChange(of: coverage) { _, _ in preview = .null }
        .sheet(item: $reportSheet, onDismiss: { preview = .null; Task { await refreshReport() } }) { request in ReviewReportSheet(model: model, reportID: request.value.string ?? "") }
        .confirmationDialog(model.t("finalization.withdraw"), isPresented: $showWithdraw) {
            Button(model.t("finalization.withdraw"), role: .destructive) { start("hetu.documents.withdraw_finalization", ["document_id": .string(documentID), "expected_finalization_ref": current["document"]["finalization_ref"], "reason": .string(comments)]) }
        } message: { Text(model.t("finalization.withdraw_note")) }
    }
    private var evidence: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(current["content"].string ?? "").font(.custom("Songti SC", size: 17)).lineSpacing(8).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                Divider()
                if report != .null { reportSummary }
                if !history["adoptions"].array.isEmpty {
                    Text(model.t("finalization.sources")).font(.headline)
                    ForEach(history["adoptions"].array.indices, id: \.self) { index in
                        Text(model.localizer.date(history["adoptions"].array[index]["created_at"].string ?? "") + " · " + model.t("adoption.recorded")).font(.caption)
                    }
                }
                if !history["finalizations"].array.isEmpty { finalizationHistory }
            }.padding(12)
        }.frame(minHeight: 200)
    }
    private var reportSummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.t("validation.status." + (report["status"].string ?? "partial"))).font(.headline)
            Text(model.t("finalization.coverage_counts", ["findings": String(report["findings"].array.count), "unknown": String(report["coverage"]["counts"]["unknown"].integer ?? 0)]))
            Button(model.t("review.view_report")) { reportSheet = DramaSheet(value: report["report_id"]) }
        }
    }
    private var finalizationHistory: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.t("finalization.history")).font(.headline)
            ForEach(history["finalizations"].array.indices.reversed(), id: \.self) { index in
                let item = history["finalizations"].array[index]
                Text(model.t(item["decision"].string == "withdrawn" ? "finalization.withdrawn" : "finalization.confirmed") + " · " + model.localizer.date(item["created_at"].string ?? "")).font(.caption)
                Text(item["comments"].string ?? "").textSelection(.enabled)
            }
        }
    }
    private var actions: some View {
        HStack {
            Button(model.t("finalization.check")) { start("hetu.documents.validate", ["document_ref": lifecycleDocumentRef(current), "plot_options": .object([:]), "validation_options": .object([:])]) }.disabled(held)
            Button(model.t("finalization.preview")) { Task { await prepare() } }.disabled(held || reportReference == .null)
            Spacer()
            if current["document"]["finalization_ref"] != .null {
                Button(model.t("finalization.withdraw"), role: .destructive) { showWithdraw = true }.disabled(held || comments.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Button(model.t("finalization.confirm")) { start("hetu.documents.finalize", ["preview": preview]) }
                .buttonStyle(WorkbenchButtonStyle(primary: true)).disabled(held || preview["eligible"].bool != true || comments.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
    private var stateKey: String {
        guard let approved = current["document"]["approved_revision_id"].string else { return "finalization.writing" }
        return approved == current["revision"]["revision_id"].string ? "finalization.current" : "finalization.new_writing"
    }
    private func load() async {
        if let value = await model.workspaceAction("hetu.documents.get", input: ["document_id": .string(documentID)], onFailure: { error = $0; _ = $1 }) { current = value }
        if let value = await model.workspaceAction("hetu.documents.lifecycle", input: ["document_id": .string(documentID)], onFailure: { error = $0; _ = $1 }) { history = value }
    }
    private func refreshReport() async {
        guard let id = report["report_id"].string,
              let value = await model.workspaceAction("hetu.reports.get", input: ["report_id": .string(id)], onFailure: { error = $0; _ = $1 }) else { return }
        report = value["report"]
        reportReference = value["reference"]
    }
    private func prepare() async {
        error = nil
        let input: [String: JSONValue] = ["document_ref": lifecycleDocumentRef(current), "expected_finalization_ref": current["document"]["finalization_ref"], "report_refs": .array([reportReference]), "comments": .string(comments), "coverage_acknowledgement": .string(coverage)]
        if let value = await model.workspaceAction("hetu.documents.preview_finalization", input: input, onFailure: { error = $0; _ = $1 }) { preview = value["preview"] }
    }
    private func start(_ action: String, _ input: [String: JSONValue]) {
        guard !held else { return }; var fixed = input; fixed["operation_key"] = .string(UUID().uuidString)
        pending = DramaOperation(action: action, input: fixed); Task { await perform() }
    }
    private func perform() async {
        guard let fixed = pending else { return }; error = nil
        if let value = await model.workspaceAction(fixed.action, input: fixed.input, onFailure: { error = $0; if $1 { pending = nil } }) {
            pending = nil; preview = .null
            if fixed.action == "hetu.documents.validate" { report = value["report"]; reportReference = value["reference"] }
            await load()
        }
    }
}
