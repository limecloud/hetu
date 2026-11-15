import SwiftUI
import HetuCore
import HetuNative

struct BookSearchView: View {
    let model: WorkspaceModel
    let onOpen: (String) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var session = BookSearchSession()
    @State private var query = ""
    @State private var replacement = ""
    @State private var allDocuments = false
    @State private var words = false
    @State private var caseSensitive = true
    @State private var selected: String?
    @State private var preview: String?
    @State private var planned: [TextMatch] = []
    @State private var baseline = ""
    @State private var error: String?
    @FocusState private var focused: Bool
    private var searchKey: String { [model.workspaceID, model.documentID, query, String(allDocuments), String(words), String(caseSensitive)].joined(separator: "\u{0}") }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(model.t("search.title")).font(.system(size: 20, weight: .semibold))
                PageAgentButton(model: model, page: "search", object: handoffObject)
                Spacer()
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            HStack {
                TextField(model.t("search.query"), text: $query).textFieldStyle(.roundedBorder).focused($focused)
                Picker(model.t("search.scope"), selection: $allDocuments) {
                    Text(model.t("search.current")).tag(false)
                    Text(model.t("search.book")).tag(true)
                }.frame(width: 180)
            }
            HStack {
                Toggle(model.t("search.words"), isOn: $words)
                Toggle(model.t("search.case"), isOn: $caseSensitive)
                Spacer()
                if session.searching { ProgressView().controlSize(.small) }
                Text(model.t("search.count", ["count": String(session.hits.count), "scanned": String(session.scanned), "total": String(session.total)])).foregroundStyle(WorkbenchPalette.muted)
            }.toggleStyle(.checkbox).font(.system(size: 12))
            if let error = error ?? session.error { Text(error).foregroundStyle(WorkbenchPalette.danger) }
            if session.truncated { Text(model.t("search.partial")).foregroundStyle(WorkbenchPalette.warningInk) }
            List(selection: $selected) {
                ForEach(session.hits) { hit in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(hit.title).fontWeight(.medium)
                            Spacer()
                            Button(model.t("search.locate")) { Task { await locate(hit) } }.buttonStyle(.borderless)
                        }
                        Text(hit.excerpt).lineLimit(2).foregroundStyle(WorkbenchPalette.muted)
                    }.tag(hit.id).padding(.vertical, 4)
                }
            }.frame(minHeight: 200)
            HStack {
                TextField(model.t("search.replacement"), text: $replacement).textFieldStyle(.roundedBorder)
                Button(model.t("search.preview_one")) { prepare(all: false) }.disabled(selectedHit == nil)
                Button(model.t("search.preview_all")) { prepare(all: true) }.disabled(query.isEmpty || session.searching)
            }.disabled(model.isComposing || model.writeLocked || model.documentID.isEmpty)
            if let preview {
                Text(model.t("search.preview_count", ["count": String(planned.count)])).fontWeight(.medium)
                ScrollView { Text(preview).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(height: 140)
                Button(model.t("search.apply")) {
                    guard model.replaceText(snapshot: baseline, matches: planned, replacement: replacement) else { error = model.t("search.stale"); self.preview = nil; return }
                    self.preview = nil; search()
                }.buttonStyle(WorkbenchButtonStyle(primary: true)).disabled(model.busy || model.isComposing || model.writeLocked)
            }
        }.padding(24).frame(minWidth: 760, idealWidth: 900, minHeight: 560, idealHeight: 700)
            .font(.system(size: 14)).tint(WorkbenchPalette.jade)
            .task(id: searchKey) { search() }
            .onAppear { focused = true }
            .onDisappear { session.cancel() }
            .onChange(of: replacement) { _, _ in preview = nil }
    }
    private var selectedHit: BookSearchHit? { session.hits.first { $0.id == selected } }
    private var handoffObject: JSONValue {
        guard let hit = selectedHit else { return .object([:]) }
        var object: [String: JSONValue] = ["document_id": .string(hit.documentID), "revision_id": .string(hit.revisionID)]
        if !(hit.documentID == model.documentID && model.needsProtection), let range = Range(hit.match.range, in: hit.content) {
            object["byte_start"] = .integer(Int64(hit.content[..<range.lowerBound].utf8.count))
            object["byte_end"] = .integer(Int64(hit.content[..<range.upperBound].utf8.count))
            object["quote"] = .string(hit.match.quote)
        }
        return .object(object)
    }
    private func search() { preview = nil; error = nil; session.search(model: model, query: query, allDocuments: allDocuments, words: words, caseSensitive: caseSensitive) }
    private func locate(_ hit: BookSearchHit) async {
        await onOpen(hit.documentID)
        guard model.documentID == hit.documentID, model.selectText(hit.match.range, in: hit.content) else { error = model.t("search.stale"); return }
        dismiss()
    }
    private func prepare(all: Bool) {
        error = nil; preview = nil; baseline = model.text
        if all { planned = TextSearch.matches(in: baseline, query: query, words: words, caseSensitive: caseSensitive) }
        else if let hit = selectedHit, hit.documentID == model.documentID, hit.content == baseline { planned = [hit.match] }
        else { error = model.t("search.current_only"); return }
        guard !planned.isEmpty, planned.count <= 5000,
              let output = TextSearch.replacing(baseline, matches: planned, with: replacement) else { error = model.t("search.no_replacement"); return }
        preview = output
    }
}
