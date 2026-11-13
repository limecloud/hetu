import SwiftUI
import HetuCore
import HetuNative

struct FindingEvidenceView: View {
    let model: WorkspaceModel
    let finding: JSONValue
    let blueprint: JSONValue
    private var evidence: JSONValue { finding["evidence"] }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(evidence["conflicts"].array.enumerated()), id: \.offset) { _, conflict in
                Text(model.t("validation.fact_evidence", ["name": name(conflict["subject_ref"]), "predicate": model.t("fact.predicate." + (conflict["predicate"].string ?? "identity")), "asserted": factValue(conflict["asserted_value"], predicate: conflict["predicate"].string ?? ""), "expected": factValue(conflict["expected_value"], predicate: conflict["predicate"].string ?? ""), "time": name(conflict["at_event"])]))
            }
            if let capability = evidence["forbidden_capability"].string {
                Text(model.t("validation.world_evidence", ["location": name(evidence["location_ref"]), "capability": capability]))
            }
            if evidence["asserted_before"] != .null {
                Text(model.t("validation.order_evidence", ["before": name(evidence["asserted_before"]), "after": name(evidence["asserted_after"])]))
            }
            if let term = evidence["term"].string { Text(model.t("validation.term_evidence", ["term": term])) }
            if let text = evidence["text"].string { Text(text) }
            if let markers = evidence["marker_count"].integer {
                Text(model.t("validation.mental_evidence", ["markers": String(markers), "characters": String(evidence["non_whitespace_characters"].integer ?? 0)]))
                Text(model.t("validation.mental_note")).foregroundStyle(.secondary).font(.caption)
            }
            if !evidence["missing_entity_types"].array.isEmpty {
                Text(model.t("validation.reference_evidence", ["types": evidence["missing_entity_types"].array.compactMap(\.string).map { model.t("entity.kind." + $0) }.joined(separator: ", ")]))
            }
        }.font(.callout).textSelection(.enabled)
    }
    private func name(_ value: JSONValue) -> String { displayName(model, reference: value.string ?? "", blueprint: blueprint) }
    private func factValue(_ value: JSONValue, predicate: String) -> String {
        if predicate == "life_state" { return model.t("fact.life." + (value.string ?? "alive")) }
        if predicate == "primary_faction" { return name(value) }
        return value.string ?? value.integer.map(String.init) ?? ""
    }
}
struct FindingDispositionSheet: View {
    let model: WorkspaceModel
    let report: JSONValue
    let finding: JSONValue
    let current: JSONValue
    let history: [JSONValue]
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var disposition = "acknowledged"
    @State private var reason = ""
    @State private var error: String?
    @State private var operationKey = UUID().uuidString
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.t("validation.review")).font(.title2)
            Text(model.t(finding["message_key"].string ?? "validation.prerequisites")).font(.headline)
            Text(model.t("validation.disposition_note")).foregroundStyle(.secondary)
            if !history.isEmpty {
                DisclosureGroup(model.t("validation.history")) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(history.enumerated()), id: \.offset) { _, item in
                                Text(model.t("validation.disposition." + (item["disposition"].string ?? "open"))).font(.headline)
                                Text(model.t("validation.history_author") + " · " + model.localizer.date(item["created_at"].string ?? "")).font(.caption).foregroundStyle(.secondary)
                                Text(item["reason"].string ?? "").textSelection(.enabled)
                                Divider()
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(maxHeight: 140)
                }
            }
            Picker(model.t("validation.disposition"), selection: $disposition) {
                ForEach(["open", "acknowledged", "false_positive", "accepted_exception"].filter { $0 != "accepted_exception" || finding["exception_policy"].string == "author_review" }, id: \.self) { Text(model.t("validation.disposition." + $0)).tag($0) }
            }
            Text(model.t("validation.reason"))
            TextEditor(text: $reason).frame(height: 100).border(Color.secondary.opacity(0.2)).accessibilityLabel(model.t("validation.reason"))
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t("common.save")) {
                    Task {
                        error = nil
                        if await model.recordDisposition(report: report, findingID: finding["finding_id"].string ?? "", expectedRevision: current["revision"].integer ?? 0, disposition: disposition, reason: reason, operationKey: operationKey, onFailure: { error = $0 }) { onSaved(); dismiss() }
                    }
                }.disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 640).disabled(model.busy)
        .onAppear { disposition = current["disposition"].string == "open" ? "acknowledged" : current["disposition"].string ?? "acknowledged"; reason = current["reason"].string ?? "" }
    }
}
