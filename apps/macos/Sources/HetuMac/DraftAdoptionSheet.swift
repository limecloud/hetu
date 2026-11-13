import SwiftUI
import HetuCore
import HetuNative

struct DraftAdoptionSheet: View {
    let model: WorkspaceModel
    let context: JSONValue
    let onAdopted: (String, String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var targetID: String
    @State private var title: String
    @State private var volumeID = ""
    @State private var target: JSONValue = .null
    @State private var novel: JSONValue = .null
    @State private var sourceRange = NSRange(location: 0, length: 0)
    @State private var targetRange = NSRange(location: 0, length: 0)
    @State private var selections: [JSONValue] = []
    @State private var useReplacement = false
    @State private var replacement = ""
    @State private var result: JSONValue = .null
    @State private var error: String?
    @State private var pending: DramaOperation?
    init(model: WorkspaceModel, context: JSONValue, onAdopted: @escaping (String, String?) -> Void) {
        self.model = model; self.context = context; self.onAdopted = onAdopted
        _targetID = State(initialValue: context["draft"]["target_document_id"].string ?? "")
        _title = State(initialValue: context["draft"]["title"].string ?? "")
    }
    private var draft: JSONValue { context["draft"] }
    private var source: String { context["content"].string ?? "" }
    private var original: String { target["content"].string ?? "" }
    private var isScript: Bool { draft["package"].string == "drama" }
    private var held: Bool { pending != nil || !model.pendingStructureOperations.isEmpty }
    private var targetReady: Bool { targetID.isEmpty ? (isScript || novel["initialized"].bool == true) : target != .null }
    private var documents: [DocumentItem] {
        model.documents.filter {
            $0.value["source_format"] == draft["source_format"] &&
            ($0.kind == "drama_script") == isScript &&
            (draft["target_document_id"].string == nil || $0.id == draft["target_document_id"].string)
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("adoption.title")).font(.title2)
            Text(model.t("adoption.note")).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if pending != nil { Button(model.t("drama.retry")) { Task { await perform() } } }
            targetControls.disabled(held)
            HSplitView {
                textPane(source, id: "source-" + (draft["draft_id"].string ?? ""), label: "adoption.reference", selection: $sourceRange)
                textPane(original, id: "target-" + targetID + (target["revision"]["revision_id"].string ?? ""), label: "adoption.original", selection: $targetRange)
            }.frame(minHeight: 180).disabled(held || !targetReady)
            selectionControls.disabled(held || !targetReady)
            selectedChanges
            if result != .null { previewContent }
            actions
        }.padding(24).frame(minWidth: 820, idealWidth: 1000, minHeight: 580, idealHeight: 740).disabled(model.busy)
        .interactiveDismissDisabled(held)
        .task { await loadTarget() }
        .onChange(of: targetID) { _, _ in selections = []; Task { await loadTarget() } }
        .onChange(of: title) { _, _ in result = .null }
        .onChange(of: volumeID) { _, _ in result = .null }
    }
    private var selectedChanges: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(selections.indices, id: \.self) { index in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(model.t("adoption.change", ["number": String(index + 1)])).font(.caption).foregroundStyle(.secondary)
                            Text(selections[index]["source"]["quote"].string ?? "").lineLimit(2)
                            if let changed = selections[index]["replacement"].string {
                                Text(model.t("adoption.author_replacement") + changed).lineLimit(2).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Button(model.t("common.remove")) { selections.remove(at: index); result = .null }.disabled(held)
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.frame(maxHeight: selections.isEmpty ? 0 : 100)
    }
    private var actions: some View {
        HStack {
            Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(held)
            Spacer()
            Button(model.t("adoption.replace_all_preview")) { selectWholeDraft() }.disabled(held || !targetReady || source.isEmpty)
            Button(model.t("adoption.preview")) { Task { await prepare() } }.disabled(held || selections.isEmpty || !targetReady)
            Button(model.t("adoption.confirm")) { adopt() }.buttonStyle(WorkbenchButtonStyle(primary: true))
                .disabled(held || result["preview"] == .null)
        }
    }
    private var targetControls: some View {
        HStack {
            Picker(model.t("adoption.destination"), selection: $targetID) {
                if draft["target_document_id"].string == nil { Text(model.t(isScript ? "adoption.new_script" : "adoption.new_chapter")).tag("") }
                ForEach(documents) { item in Text(item.title).tag(item.id) }
            }.frame(maxWidth: 360)
            Button(model.t("adoption.reload")) { Task { await loadTarget() } }
            if targetID.isEmpty {
                TextField(model.t(isScript ? "adoption.script_title" : "adoption.chapter_title"), text: $title).textFieldStyle(.roundedBorder)
                if !isScript {
                    Picker(model.t("adoption.volume"), selection: $volumeID) {
                        Text(model.t("adoption.unassigned")).tag("")
                        ForEach(Array(novel["novel"]["volumes"].array.enumerated()), id: \.offset) { _, item in Text(item["title"].string ?? "").tag(item["volume_id"].string ?? "") }
                    }.frame(maxWidth: 240)
                }
            }
        }
    }
    private var selectionControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(model.t("adoption.selection_hint")).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Toggle(model.t("adoption.edit_selected"), isOn: $useReplacement).toggleStyle(.checkbox)
                Button(model.t("adoption.add_selection")) { addSelection() }.disabled(sourceRange.length == 0 || selections.count >= 100)
            }
            if useReplacement {
                TextEditor(text: $replacement).frame(height: 65).border(Color.secondary.opacity(0.2)).accessibilityLabel(model.t("adoption.replacement"))
            }
        }
    }
    private var previewContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.t("adoption.effect")).font(.headline)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let baseline = result["baseline"]["content"].string, baseline != original {
                        Text(model.t("adoption.baseline_changed")).foregroundStyle(.orange)
                        DisclosureGroup(model.t("adoption.submission_baseline")) { Text(baseline).textSelection(.enabled) }
                    }
                    Text(result["content"].string ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }.padding(8)
            }.frame(maxHeight: 180)
        }
    }
    private func textPane(_ content: String, id: String, label: String, selection: Binding<NSRange>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.t(label)).font(.headline)
            NativeTextEditor(text: content, documentID: id, replacementVersion: 0, accessibleName: model.t(label), editable: false,
                             onChange: { _ in }, onComposition: { _ in }, onSelection: { selection.wrappedValue = $0 })
        }.frame(minWidth: 300)
    }
    private func loadTarget() async {
        result = .null; target = .null; targetRange = NSRange(location: 0, length: 0); error = nil
        if targetID.isEmpty {
            if !isScript, let value = await model.workspaceAction("hetu.novels.get", input: [:], onFailure: failed) {
                novel = value
                if value["initialized"].bool != true { error = model.t("adoption.initialize_novel") }
            }
        } else if let value = await model.workspaceAction("hetu.documents.get", input: ["document_id": .string(targetID)], onFailure: failed) { target = value }
    }
    private func rangeValue(_ span: SourceSpan) -> JSONValue {
        .object(["byte_start": .integer(Int64(span.byteStart)), "byte_end": .integer(Int64(span.byteEnd)), "quote": .string(span.quote)])
    }
    private func addSelection() {
        guard let sourceSpan = SourceSpan(content: source, selection: sourceRange),
              let targetSpan = SourceSpan(content: original, selection: targetRange, allowEmpty: true) else { error = model.t("adoption.invalid_selection"); return }
        var item = ["source": rangeValue(sourceSpan), "target": rangeValue(targetSpan)]
        if useReplacement { item["replacement"] = .string(replacement) }
        selections.append(.object(item)); result = .null; error = nil
    }
    private func selectWholeDraft() {
        guard let sourceSpan = SourceSpan(content: source, selection: NSRange(location: 0, length: source.utf16.count)),
              let targetSpan = SourceSpan(content: original, selection: NSRange(location: 0, length: original.utf16.count), allowEmpty: true) else { return }
        selections = [.object(["source": rangeValue(sourceSpan), "target": rangeValue(targetSpan)])]
        result = .null; Task { await prepare() }
    }
    private func prepare() async {
        error = nil; result = .null
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !targetID.isEmpty else { error = model.t("adoption.title_required"); return }
        let newDocument: JSONValue = targetID.isEmpty ? .object(["title": .string(title), "volume_id": volumeID.isEmpty ? .null : .string(volumeID), "novel_expected": isScript ? .null : .object(["revision": novel["revision"], "sha256": novel["sha256"]])]) : .null
        let input: [String: JSONValue] = ["draft_ref": .object(["draft_id": draft["draft_id"], "revision": draft["revision"], "sha256": draft["content_sha256"]]),
            "target_ref": targetID.isEmpty ? .null : lifecycleDocumentRef(target), "new_document": newDocument, "selected_ranges": .array(selections)]
        if let value = await model.workspaceAction("hetu.drafts.preview_adoption", input: input, onFailure: failed) { result = value }
    }
    private func adopt() {
        guard !held, result["preview"] != .null else { return }
        pending = DramaOperation(action: "hetu.drafts.adopt", input: ["preview": result["preview"], "operation_key": .string(UUID().uuidString)])
        Task { await perform() }
    }
    private func perform() async {
        guard let operation = pending else { return }; error = nil
        if let value = await model.workspaceAction(operation.action, input: operation.input, onFailure: { message, terminal in
            error = message
            if terminal { pending = nil; result = .null }
        }), let id = value["document"]["document_id"].string {
            pending = nil; dismiss(); onAdopted(id, original)
        }
    }
    private func failed(_ message: String, _ terminal: Bool) { error = message }
}
