import SwiftUI
import HetuCore
import HetuNative

private struct ValidationSheet: Identifiable {
    let id = UUID()
    let value: JSONValue
}
struct ValidationWorkbenchView: View {
    let model: WorkspaceModel
    var initialDocumentID = ""
    @State private var documentID = ""
    @State private var plots: [JSONValue] = []
    @State private var plotCursor: String?
    @State private var plotRevision = ""
    @State private var summaries: [JSONValue] = []
    @State private var reportCursor: String?
    @State private var result: JSONValue = .null
    @State private var blueprint: JSONValue = .null
    @State private var error: String?
    @State private var severity = ""
    @State private var certainty = ""
    @State private var rule = ""
    @State private var disposition = ""
    @State private var sourceSheet: ValidationSheet?
    @State private var dispositionSheet: ValidationSheet?
    @State private var operationKey = UUID().uuidString
    private var report: JSONValue { result["report"] }
    private var findings: [JSONValue] { report["findings"].array }
    private var filtered: [JSONValue] {
        findings.filter { finding in
            (severity.isEmpty || finding["severity"].string == severity)
            && (certainty.isEmpty || finding["certainty"].string == certainty)
            && (rule.isEmpty || finding["rule_id"].string == rule)
            && (disposition.isEmpty || currentDisposition(finding)["disposition"].string == disposition)
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            Divider()
            HSplitView {
                reportList.frame(minWidth: 180, idealWidth: 220, maxWidth: 280)
                if report == .null {
                    WorkbenchEmptyState(title: model.t("validation.empty"), detail: model.t("validation.empty_detail"), artwork: "review-desk")
                } else { content.frame(minWidth: 360) }
            }
        }.padding(28).workbenchPage()
        .task { documentID = model.documents.first(where: { $0.id == initialDocumentID })?.id ?? model.documents.first?.id ?? "" }
        .onChange(of: documentID) { _, _ in Task { await loadPlots() } }
        .onChange(of: plotRevision) { _, _ in
            result = .null; blueprint = .null; operationKey = UUID().uuidString
            Task { await loadReports() }
        }
        .sheet(item: $sourceSheet) { sheet in PlotSourceView(model: model, source: sheet.value) }
        .sheet(item: $dispositionSheet) { sheet in
            FindingDispositionSheet(model: model, report: report, finding: sheet.value, current: currentDisposition(sheet.value), history: result["dispositions"].array.first { $0["finding_id"] == sheet.value["finding_id"] }?["history"].array ?? []) {
                Task { await read(report["report_id"].string ?? "") }
            }
        }.disabled(model.busy)
    }
    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            WorkbenchHeading(title: model.t("validation.title"), subtitle: model.t("validation.description"), artwork: report == .null ? "" : "review-desk") {
                Button(model.t("common.refresh")) { Task { await loadPlots(); await loadReports(); if report != .null { await read(report["report_id"].string ?? "") } } }
            }
            HStack {
                Picker(model.t("plot.document"), selection: $documentID) {
                    Text(model.t("document.select")).tag("")
                    ForEach(model.documents) { Text($0.title).tag($0.id) }
                }.frame(maxWidth: 300)
                Picker(model.t("validation.plot_revision"), selection: $plotRevision) {
                    Text(model.t("plot.unspecified")).tag("")
                    ForEach(Array(plots.enumerated()), id: \.offset) { _, item in Text(plotLabel(item)).tag(item["plot_revision_id"].string ?? "") }
                }.frame(maxWidth: 320)
                Button(model.t("validation.run")) {
                    Task {
                        error = nil
                        if let next = await model.runValidation(plotRevision: plotRevision, operationKey: operationKey, onFailure: { error = $0 }) {
                            await install(next); operationKey = UUID().uuidString; await loadReports()
                        }
                    }
                }.disabled(plotRevision.isEmpty || model.busy)
            }
            if plotCursor != nil { Button(model.t("validation.more_plots")) { Task { await loadPlots(more: true) } } }
            if plots.isEmpty { Text(model.t("validation.needs_plot")).font(.caption).foregroundStyle(.secondary) }
        }
    }
    private var reportList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                Text(model.t("validation.reports")).font(.headline)
                if summaries.isEmpty { Text(model.t("validation.no_reports")).foregroundStyle(.secondary) }
                ForEach(Array(summaries.enumerated()), id: \.offset) { _, item in
                    Button { Task { await read(item["report_id"].string ?? "") } } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(dateLabel(item["created_at"].string ?? ""))
                            Text(model.t("validation.summary", ["count": String(item["finding_count"].integer ?? 0)] )).font(.caption)
                            Text(model.t("validation.status." + (item["status"].string ?? "partial"))).font(.caption)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                            .background(report["report_id"] == item["report_id"] ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                    }.buttonStyle(.plain).disabled(model.busy)
                }
                if reportCursor != nil { Button(model.t("plot.more")) { Task { await loadReports(more: true) } } }
            }.padding(.trailing, 10)
        }
    }
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                coverage
                filters
                if filtered.isEmpty { Text(model.t("validation.no_findings")).foregroundStyle(.secondary) }
                ForEach(Array(filtered.enumerated()), id: \.offset) { _, finding in
                    findingRow(finding)
                    Divider()
                }
            }.padding(.leading, 14)
        }
    }
    private var coverage: some View { ValidationCoverageView(model: model, result: result) }
    private var filters: some View {
        VStack(spacing: 6) {
            HStack {
                filterPicker("validation.severity", selection: $severity, values: ["error", "warning", "info"], prefix: "rule.severity.")
                filterPicker("validation.certainty", selection: $certainty, values: ["certain", "heuristic", "unknown", "advisory"], prefix: "validation.certainty.")
            }
            HStack {
                Picker(model.t("validation.rule"), selection: $rule) {
                    Text(model.t("validation.all")).tag("")
                    ForEach(Array(Set(findings.compactMap { $0["rule_id"].string })).sorted(), id: \.self) { Text(ruleName($0)).tag($0) }
                }
                filterPicker("validation.disposition", selection: $disposition, values: ["open", "acknowledged", "false_positive", "accepted_exception"], prefix: "validation.disposition.")
            }
        }
    }
    private func filterPicker(_ title: String, selection: Binding<String>, values: [String], prefix: String) -> some View {
        Picker(model.t(title), selection: selection) {
            Text(model.t("validation.all")).tag("")
            ForEach(values, id: \.self) { Text(model.t(prefix + $0)).tag($0) }
        }
    }
    private func findingRow(_ finding: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Text(model.t(finding["message_key"].string ?? "validation.prerequisites")).font(.headline)
                Spacer()
                Button(model.t("validation.review")) { dispositionSheet = ValidationSheet(value: finding) }.buttonStyle(.borderless).disabled(model.busy)
            }
            Text(model.t("rule.severity." + (finding["severity"].string ?? "info")) + " · " + model.t("validation.certainty." + (finding["certainty"].string ?? "unknown")) + " · " + ruleName(finding["rule_id"].string ?? "")).font(.caption).foregroundStyle(.secondary)
            FindingEvidenceView(model: model, finding: finding, blueprint: blueprint)
            ForEach(Array(finding["missing_prerequisites"].array.enumerated()), id: \.offset) { _, value in Text(model.t("validation.missing." + (value.string ?? "plot_nodes"))).foregroundStyle(.orange).font(.caption) }
            ForEach(Array(finding["source_refs"].array.enumerated()), id: \.offset) { _, source in
                HStack(alignment: .top) {
                    Text(source["quote"].string ?? "").lineLimit(4).textSelection(.enabled)
                    Spacer()
                    Button(model.t("plot.source")) { sourceSheet = ValidationSheet(value: source) }.buttonStyle(.borderless)
                }
            }
            let current = currentDisposition(finding)
            Text(model.t("validation.disposition." + (current["disposition"].string ?? "open"))).font(.caption)
            if let reason = current["reason"].string { Text(reason).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
        }
    }
    private func currentDisposition(_ finding: JSONValue) -> JSONValue {
        result["dispositions"].array.first { $0["finding_id"] == finding["finding_id"] }?["current"] ?? .object(["disposition": .string("open"), "revision": .integer(0)])
    }
    private func ruleName(_ id: String) -> String {
        if id == "builtin.adaptation" { return model.t("validation.adaptation") }
        guard let rule = blueprint["rules"].array.first(where: { $0["rule_id"].string == id }) else { return model.t("validation.rule") }
        let name = model.t("rule.type." + (rule["type"].string ?? "advisory"))
        let index = (blueprint["rules"].array.firstIndex(of: rule) ?? 0) + 1
        return "\(index). \(name)"
    }
    private func dateLabel(_ value: String) -> String { model.localizer.date(value) }
    private func plotLabel(_ item: JSONValue) -> String {
        dateLabel(item["created_at"].string ?? "") + " · " + model.t("plot.summary", ["nodes": String(item["node_count"].integer ?? 0), "confirmed": String(item["confirmed_count"].integer ?? 0)])
    }
    private func loadPlots(more: Bool = false) async {
        guard !documentID.isEmpty else { plots = []; plotRevision = ""; return }
        if let page = await model.listPlots(documentID: documentID, cursor: more ? plotCursor : nil, onFailure: { error = $0 }) {
            plots = more ? plots + page["plots"].array : page["plots"].array
            plotCursor = page["next_cursor"].string
            if !more { plotRevision = plots.first?["plot_revision_id"].string ?? ""; await loadReports() }
        }
    }
    private func loadReports(more: Bool = false) async {
        guard !plotRevision.isEmpty else { summaries = []; reportCursor = nil; return }
        if let page = await model.listReports(plotRevision: plotRevision, cursor: more ? reportCursor : nil, onFailure: { error = $0 }) {
            summaries = more ? summaries + page["reports"].array : page["reports"].array; reportCursor = page["next_cursor"].string
        }
    }
    private func read(_ id: String) async {
        error = nil
        if let next = await model.readReport(id, onFailure: { error = $0 }) { await install(next) }
    }
    private func install(_ next: JSONValue) async {
        let changedReport = report["report_id"] != next["report"]["report_id"]
        result = next
        if changedReport { severity = ""; certainty = ""; rule = ""; disposition = "" }
        blueprint = .null
        if let revision = report["input_snapshot"]["blueprint_revision"].integer,
           let bible = await model.readBibleRevision(revision, onFailure: { error = $0 }) { blueprint = bible["blueprint"] }
    }
}

struct ValidationCoverageView: View {
    let model: WorkspaceModel
    let result: JSONValue
    var sourceTitle: String?
    private var report: JSONValue { result["report"] }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.t("validation.status." + (report["status"].string ?? "partial"))).font(.headline)
            Text(model.t("validation.coverage", ["bytes": String(report["coverage"]["scanned_bytes"].integer ?? 0), "revision": String(report["input_snapshot"]["blueprint_revision"].integer ?? 0), "version": report["rule_set_version"].string ?? ""])).font(.caption).foregroundStyle(.secondary)
            Text(model.t("validation.counts", Dictionary(uniqueKeysWithValues: ["passed", "finding", "unknown", "not_applicable"].map { ($0, String(report["coverage"]["counts"][$0].integer ?? 0)) }))).font(.caption)
            if result["stale"].bool == true { Label(model.t("validation.stale"), systemImage: "clock.badge.exclamationmark").foregroundStyle(.orange) }
            if let stop = report["coverage"]["budget_stop"].string { Text(model.t("validation.budget." + stop)).foregroundStyle(.orange) }
            Text(model.t("validation.coverage_note")).font(.caption).foregroundStyle(.secondary)
            DisclosureGroup(model.t("validation.coverage_details")) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(model.t("validation.rule_coverage", ["enabled": String(report["coverage"]["enabled_rules"].array.count), "executed": String(report["coverage"]["executed_rules"].array.count)]))
                    Text(model.t("validation.unparsed", ["count": String(report["coverage"]["unparsed_ranges"].array.count), "plot_count": String(report["coverage"]["plot_coverage"]["unparsed_ranges"].array.count)]))
                    ForEach(Array(report["coverage"]["scanned_ranges"].array.enumerated()), id: \.offset) { _, range in
                        Text((sourceTitle ?? model.documents.first { $0.id == range["document_id"].string }?.title ?? model.t("entity.unavailable")) + ": \(range["byte_start"].integer ?? 0)…\(range["byte_end"].integer ?? 0) UTF-8")
                    }
                }.font(.caption).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.textSelection(.enabled)
    }
}
