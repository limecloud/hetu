import SwiftUI
import HetuCore
import HetuNative

struct AuthorNotesView: View {
    let model: WorkspaceModel
    let initialSelection: NSRange
    @Environment(\.dismiss) private var dismiss
    @State private var tab = "annotations"
    @State private var record: JSONValue = .null
    @State private var items: [JSONValue] = []
    @State private var text = ""
    @State private var title = ""
    @State private var level = "book"
    @State private var target = ""
    @State private var selection = NSRange(location: 0, length: 0)
    @State private var revisions: [JSONValue] = []
    @State private var cursor: String?
    @State private var historical: JSONValue = .null
    @State private var error: String?
    @State private var changed = false
    @State private var confirmClose = false
    @State private var source = ""
    @State private var sourceRevision = ""
    @State private var pending: (action: String, input: [String: JSONValue])?
    private var held: Bool { model.busy || pending != nil }
    private var dirty: Bool { changed || !text.isEmpty || !title.isEmpty }
    private var canAppend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        (tab != "annotations" || (selection.length > 0 && !model.needsProtection)) &&
        (tab != "outlines" || level == "book" || !target.isEmpty)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(model.t("notes.title")).font(.system(size: 20, weight: .semibold))
                Spacer()
                PageAgentButton(model: model, page: "notes")
                Button(model.t("common.close")) { if dirty { confirmClose = true } else { dismiss() } }.keyboardShortcut(.cancelAction).disabled(held)
            }
            Picker(model.t("notes.title"), selection: $tab) {
                Text(model.t("notes.annotations")).tag("annotations")
                Text(model.t("notes.outlines")).tag("outlines")
                Text(model.t("notes.history")).tag("history")
            }.pickerStyle(.segmented).disabled(dirty || held)
            if let error { Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if pending != nil { Button(model.t("drama.retry")) { Task { await persist() } } }
            if tab == "history" { history }
            else {
                Group {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(items.indices, id: \.self) { index in
                            VStack(alignment: .leading, spacing: 6) {
                                if tab == "annotations" {
                                    Text(items[index]["source_ref"]["quote"].string ?? "").foregroundStyle(WorkbenchPalette.muted).lineLimit(3)
                                    PageAgentButton(model: model, page: "notes", object: PageHandoff.sourceObject(items[index]["source_ref"]), intent: items[index]["text"].string)
                                    HStack {
                                        Toggle(model.t("notes.resolved"), isOn: Binding(get: { items[index]["resolved"].bool == true }, set: { value in update(index, "resolved", .bool(value)) }))
                                        if items[index]["source_ref"]["revision_id"].string != model.baseRevisionID { Text(model.t("notes.old_source")).foregroundStyle(WorkbenchPalette.warningInk) }
                                    }
                                } else { Text(outlineLabel(items[index])).fontWeight(.medium) }
                                TextEditor(text: Binding(get: { items[index]["text"].string ?? "" }, set: { update(index, "text", .string($0)) })).frame(minHeight: 65)
                                Button(model.t("common.remove")) { items.remove(at: index); changed = true }.buttonStyle(.borderless)
                                Divider()
                            }
                        }
                    }
                }
                if tab == "annotations" {
                    if model.needsProtection { Button(model.t("notes.save_first")) { Task { if await model.save() { source = model.savedText; sourceRevision = model.baseRevisionID; selection = NSRange(location: 0, length: 0) } } } }
                    NativeTextEditor(text: source, documentID: "note-source-" + sourceRevision, replacementVersion: 0, accessibleName: model.t("notes.select_quote"), editable: false,
                        onChange: { _ in }, onComposition: { _ in }, onSelection: { selection = $0 }).frame(height: 125)
                } else {
                    HStack {
                        Picker(model.t("notes.level"), selection: $level) {
                            Text(model.t("notes.book")).tag("book"); Text(model.t("notes.volume")).tag("volume"); Text(model.t("notes.chapter")).tag("chapter")
                        }
                        if level != "book" {
                            Picker(model.t("notes.target"), selection: $target) {
                                Text(model.t("document.select")).tag("")
                                if level == "volume" { ForEach(Array(model.volumes.enumerated()), id: \.offset) { _, volume in Text(volume["title"].string ?? "").tag(volume["volume_id"].string ?? "") } }
                                else { ForEach(model.orderedChapters) { Text($0.title).tag($0.id) } }
                            }
                        }
                        TextField(model.t("document.title"), text: $title).textFieldStyle(.roundedBorder)
                    }
                }
                TextEditor(text: $text).frame(height: 85).overlay { Rectangle().stroke(WorkbenchPalette.line, lineWidth: 0.5) }.accessibilityLabel(model.t("notes.content"))
                HStack {
                    Button(model.t("notes.add")) { append() }.disabled(!canAppend)
                    Spacer()
                    Button(model.t("common.save")) { Task { await persist() } }.buttonStyle(WorkbenchButtonStyle(primary: true)).disabled(!dirty || ((!text.isEmpty || !title.isEmpty) && !canAppend))
                }
                }.disabled(held)
            }
        }.padding(24).frame(minWidth: 800, idealWidth: 940, minHeight: 650, idealHeight: 790).font(.system(size: 14))
            .task(id: tab) { await load() }
            .interactiveDismissDisabled(dirty || held)
            .confirmationDialog(model.t("notes.unsaved"), isPresented: $confirmClose) {
                Button(model.t("common.save")) { Task { await persist(); if !dirty { dismiss() } } }.disabled((!text.isEmpty || !title.isEmpty) && !canAppend)
                Button(model.t("notes.discard"), role: .destructive) { dismiss() }
                Button(model.t("common.cancel"), role: .cancel) {}
            }
    }
    private var history: some View {
        HSplitView {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(revisions.enumerated()), id: \.offset) { _, item in
                        Button { Task { await readRevision(item) } } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(model.localizer.date(item["created_at"].string ?? ""))
                                Text(item["revision_id"].string == model.loaded["document"]["approved_revision_id"].string ? model.t("finalization.current") : model.localizer.byteCount(item["size_bytes"].integer ?? 0)).foregroundStyle(WorkbenchPalette.muted)
                            }
                        }.buttonStyle(.plain)
                    }
                    if cursor != nil { Button(model.t("plot.more")) { Task { await loadHistory(more: true) } } }
                }.padding(8)
            }.frame(minWidth: 180, maxWidth: 220)
            VStack(alignment: .leading, spacing: 10) {
                if historical != .null {
                    PageAgentButton(model: model, page: "document", object: .object(["document_id": historical["document"]["document_id"], "revision_id": historical["revision"]["revision_id"]]))
                    NativeTextEditor(text: historical["content"].string ?? "", documentID: historical["revision"]["revision_id"].string ?? "", replacementVersion: 0, accessibleName: model.t("notes.history"), editable: false, onChange: { _ in }, onComposition: { _ in })
                    DisclosureGroup(model.t("notes.difference")) {
                        let difference = RevisionDifference.compare(before: historical["content"].string ?? "", after: model.text)
                        ScrollView { VStack(alignment: .leading) { ForEach(difference.changes) { Text(($0.added ? "+ " : "− ") + $0.text).foregroundStyle($0.added ? WorkbenchPalette.jade : WorkbenchPalette.danger).textSelection(.enabled) } } }.frame(maxHeight: 160)
                    }
                    Button(model.t("notes.restore")) {
                        _ = model.replaceBuffer(snapshot: model.text, with: historical["content"].string ?? "")
                    }.disabled(model.needsProtection || model.isComposing || model.writeLocked)
                } else { Text(model.t("notes.select_revision")).foregroundStyle(WorkbenchPalette.muted) }
            }.frame(minWidth: 460)
        }
    }
    private func update(_ index: Int, _ key: String, _ value: JSONValue) { var item = items[index].object; item[key] = value; items[index] = .object(item); changed = true }
    private func outlineLabel(_ item: JSONValue) -> String {
        let id = item["target_id"].string ?? ""
        let target = item["level"].string == "volume" ? model.volumes.first { $0["volume_id"].string == id }?["title"].string : model.documents.first { $0.id == id }?.title
        return (target ?? model.t("notes.book")) + "  " + (item["title"].string ?? "")
    }
    private func append() {
        if tab == "annotations" {
            guard let span = SourceSpan(content: source, selection: selection) else { return }
            items.append(.object(["id": .string("note_" + UUID().uuidString.lowercased()), "text": .string(text), "resolved": .bool(false), "source_ref": .object(["document_id": .string(model.documentID), "revision_id": .string(sourceRevision), "byte_start": .integer(Int64(span.byteStart)), "byte_end": .integer(Int64(span.byteEnd)), "quote": .string(span.quote)])]))
        } else {
            items.append(.object(["id": .string("outline_" + UUID().uuidString.lowercased()), "text": .string(text), "title": .string(title.isEmpty ? model.t("notes." + level) : title), "level": .string(level), "target_id": level == "book" ? .null : .string(target)]))
        }
        text = ""; title = ""; changed = true
    }
    private func load() async {
        source = model.savedText; sourceRevision = model.baseRevisionID; selection = initialSelection
        if tab == "history" { await loadHistory(more: false); return }
        guard let workspace = model.workspace else { return }
        do {
            record = try await workspace.data(tab == "annotations" ? "hetu.annotations.list" : "hetu.outlines.get", input: tab == "annotations" ? ["document_id": .string(model.documentID)] : [:])
            items = record["items"].array; changed = false; error = nil
        } catch { self.error = model.localizer.error(error) }
    }
    private func persist() async {
        if pending == nil {
            if !text.isEmpty || !title.isEmpty {
                guard canAppend else { return }
                append()
            }
            var input: [String: JSONValue] = ["expected": .object(["revision": record["revision"], "sha256": record["sha256"]]), "items": .array(items), "operation_key": .string(UUID().uuidString)]
            if tab == "annotations" { input["document_id"] = .string(model.documentID) }
            pending = ("hetu." + tab + ".save", input)
        }
        guard let fixed = pending else { return }
        if let result = await model.workspaceAction(fixed.action, input: fixed.input, onFailure: { error = $0; if !$1 { pending = nil } }) { record = result; changed = false; pending = nil; error = nil }
    }
    private func loadHistory(more: Bool) async {
        guard let workspace = model.workspace else { return }
        do {
            var input: [String: JSONValue] = ["document_id": .string(model.documentID), "limit": .integer(50)]
            if more, let cursor { input["cursor"] = .string(cursor) }
            let value = try await workspace.data("hetu.documents.history", input: input)
            revisions = more ? revisions + value["revisions"].array : value["revisions"].array; cursor = value["next_cursor"].string
        } catch { self.error = model.localizer.error(error) }
    }
    private func readRevision(_ item: JSONValue) async {
        guard let workspace = model.workspace else { return }
        do { historical = try await workspace.data("hetu.documents.get", input: ["document_id": .string(model.documentID), "revision_id": item["revision_id"]]) }
        catch { self.error = model.localizer.error(error) }
    }
}
