import SwiftUI
import HetuCore
import HetuNative

struct ManuscriptView: View {
    let model: WorkspaceModel
    let inspector: Bool
    let onReview: () -> Void
    let onFinalization: () -> Void
    let onMapping: () -> Void
    let onRecovery: () -> Void
    let onConflict: () -> Void
    let onBible: () -> Void
    let onValidation: () -> Void
    var writing = WritingPreferences()
    @State private var editSelection = NSRange(location: 0, length: 0)
    @State private var creativeTask = false
    var body: some View {
        GeometryReader { geometry in
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(model.t("shell.manuscript")).lineLimit(1)
                    Spacer(minLength: 10)
                    Text(model.t("shell.word_count", ["count": String(model.statistics.han)])).lineLimit(1)
                    Menu {
                        Button(model.t("creative.title")) { creativeTask = true }.disabled(model.busy || model.isComposing || model.documentID.isEmpty)
                        Button(model.t("finalization.title"), action: onFinalization).disabled(model.needsProtection || model.isComposing || !model.pendingStructureOperations.isEmpty)
                        Button(model.t("review.submit"), action: onReview).disabled(model.needsProtection || model.isComposing || !model.pendingStructureOperations.isEmpty)
                        if model.loaded["document"]["structure_origin"] != .null { Button(model.t("script.mapping"), action: onMapping) }
                    } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize().accessibilityLabel(model.t("shell.document_actions"))
                }.font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).padding(.bottom, 14)
                Rectangle().fill(WorkbenchPalette.line.opacity(0.6)).frame(height: 1)
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(model.documentTitle).font(.custom("Songti SC", size: 28).weight(.semibold)).textSelection(.enabled)
                        Text(model.t(model.loaded["document"]["approved_revision_id"].string == nil ? "finalization.writing" :
                            (!model.dirty && model.loaded["document"]["approved_revision_id"].string == model.baseRevisionID ? "finalization.current" : "finalization.new_writing")))
                            .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                    }
                    Spacer(minLength: 0)
                }.padding(.top, 24).padding(.bottom, 18)
                if !model.recoveryCandidates.isEmpty {
                    notice("recovery.available", action: "recovery.compare", perform: onRecovery)
                }
                if model.conflict != .null {
                    notice("conflict.available", action: "conflict.compare", perform: onConflict)
                }
                NativeTextEditor(text: model.text, documentID: model.documentID, replacementVersion: model.replacementVersion,
                    accessibleName: model.t("editor.body"), editable: !model.editorSuspended, readingMode: true,
                    presentation: writing.presentation(forScript: model.loaded["document"]["source_format"].string == "fountain"),
                    onChange: { [id = model.documentID] value in model.edit(value, documentID: id) }, onComposition: model.setComposition, onSelection: { editSelection = $0 }, undoBaseline: model.adoptionUndoBaseline)
                HStack {
                    Text(model.loaded["document"]["source_format"].string == "fountain" ? "Fountain" : "Markdown")
                    Spacer()
                    Text(model.t("statistics.count", ["han": String(model.statistics.han), "words": String(model.statistics.latinWords), "characters": String(model.statistics.graphemes)]))
                        .lineLimit(1).minimumScaleFactor(0.8)
                }.font(.system(size: 11)).foregroundStyle(WorkbenchPalette.muted).padding(.top, 12)
            }.padding(.horizontal, 30).padding(.top, 26).padding(.bottom, 18).frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(WorkbenchPalette.page, in: RoundedRectangle(cornerRadius: 12))
                .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(WorkbenchPalette.line.opacity(0.7), lineWidth: 0.5).allowsHitTesting(false) }
                .shadow(color: .black.opacity(0.035), radius: 12, x: 0, y: 4).padding(18)
            if inspector && geometry.size.width >= 720 {
                ManuscriptInspectorView(model: model, onBible: onBible, onValidation: onValidation).frame(width: 280)
            }
        }
        }
        .sheet(isPresented: $creativeTask) { CreativeTaskView(model: model, selection: editSelection) }
        .onChange(of: model.documentID) { _, _ in editSelection = NSRange(location: 0, length: 0) }
    }
    private func notice(_ key: String, action: String, perform: @escaping () -> Void) -> some View {
        HStack {
            Image(systemName: "exclamationmark.triangle")
            Text(model.t(key)).font(.system(size: 12))
            Spacer()
            Button(model.t(action), action: perform)
        }.padding(10).background(WorkbenchPalette.warning, in: RoundedRectangle(cornerRadius: 8)).padding(.bottom, 12)
    }
}

private struct ManuscriptInspectorView: View {
    let model: WorkspaceModel
    let onBible: () -> Void
    let onValidation: () -> Void
    @State private var result: JSONValue = .null
    @State private var loading = false
    @State private var error: String?
    @State private var source: DramaSheet?
    private var report: JSONValue { result["report"] }
    private var stale: Bool { result["stale"].bool == true || model.dirty }
    private var taskID: String { model.workspaceID + model.documentID + model.baseRevisionID + String(model.bible["blueprint"]["revision"].integer ?? 0) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(model.t("shell.checks_title")).font(.system(size: 14, weight: .semibold))
                Button(action: onBible) {
                    HStack(alignment: .top, spacing: 11) {
                        Image(systemName: model.locked ? "lock" : "lock.open").font(.system(size: 21))
                        VStack(alignment: .leading, spacing: 6) {
                            Text(model.t(model.locked ? "bible.locked" : "bible.editable")).font(.system(size: 13, weight: .semibold))
                            Text(model.t("shell.canon_note")).font(.system(size: 11)).lineSpacing(3)
                        }
                    }.foregroundStyle(WorkbenchPalette.jade).frame(maxWidth: .infinity, alignment: .leading).padding(15)
                        .background(WorkbenchPalette.jadeSoft, in: RoundedRectangle(cornerRadius: 8))
                }.buttonStyle(.plain)
                VStack(spacing: 0) {
                    inspectorRow("shell.canon_revision", value: String(model.bible["blueprint"]["revision"].integer ?? 0))
                    inspectorRow("shell.characters", value: String(model.bible["blueprint"]["characters"].array.count))
                }
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Label(model.t("validation.title"), systemImage: "checkmark.circle").font(.system(size: 13, weight: .semibold))
                        Spacer()
                        if loading { ProgressView().controlSize(.mini) }
                    }
                    if let error {
                        Text(error).foregroundStyle(.red).font(.system(size: 12))
                    } else if report == .null {
                        Text(model.t("shell.not_checked")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                    } else {
                        Text(model.t(stale ? "validation.stale" : "validation.status." + (report["status"].string ?? "partial")))
                            .font(.system(size: 12)).foregroundStyle(stale ? WorkbenchPalette.warningInk : WorkbenchPalette.muted)
                        ForEach(["passed", "finding", "unknown"], id: \.self) { state in
                            HStack {
                                Text(model.t("shell.coverage." + state))
                                Spacer()
                                Text(String(report["coverage"]["counts"][state].integer ?? 0)).monospacedDigit()
                            }.font(.system(size: 12))
                        }
                    }
                    Button(model.t("shell.open_checks"), action: onValidation).font(.system(size: 12))
                }
                ForEach(Array(report["findings"].array.prefix(3).enumerated()), id: \.offset) { _, finding in
                    VStack(alignment: .leading, spacing: 8) {
                        Label(model.t(finding["message_key"].string ?? "validation.prerequisites"), systemImage: "exclamationmark.triangle")
                            .font(.system(size: 12, weight: .semibold))
                        Text(model.t("validation.certainty." + (finding["certainty"].string ?? "unknown"))).font(.system(size: 11))
                        if let first = finding["source_refs"].array.first {
                            Text(first["quote"].string ?? "").font(.system(size: 12)).lineLimit(4)
                            Button(model.t("plot.source")) { source = DramaSheet(value: first) }.font(.system(size: 12))
                        }
                    }.foregroundStyle(WorkbenchPalette.warningInk).frame(maxWidth: .infinity, alignment: .leading).padding(14)
                        .background(WorkbenchPalette.warning, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(WorkbenchPalette.warningLine, lineWidth: 1))
                }
                VStack(alignment: .leading, spacing: 12) {
                    Label(model.t("shell.reference"), systemImage: "book").font(.system(size: 13, weight: .semibold))
                    Button(action: onBible) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(model.title + "  " + model.t("bible.title")).font(.system(size: 12, weight: .medium))
                            Text(model.t("shell.reference_note")).font(.system(size: 11)).foregroundStyle(WorkbenchPalette.muted)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                Text(model.t("shell.checks_note")).font(.system(size: 11)).foregroundStyle(WorkbenchPalette.muted).lineSpacing(4)
            }.padding(.horizontal, 20).padding(.vertical, 25)
        }.background(WorkbenchPalette.surface.opacity(0.30))
        .task(id: taskID) { await load() }
        .sheet(item: $source) { request in PlotSourceView(model: model, source: request.value) }
    }
    private func inspectorRow(_ key: String, value: String) -> some View {
        Button(action: onBible) {
            HStack {
                Text(model.t(key)); Spacer(); Text(value).monospacedDigit()
                Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(WorkbenchPalette.muted)
            }.font(.system(size: 12)).padding(.vertical, 14)
        }.buttonStyle(.plain).overlay(alignment: .bottom) { Rectangle().fill(WorkbenchPalette.line.opacity(0.5)).frame(height: 1) }
    }
    private func load() async {
        let identity = taskID
        result = .null; error = nil; loading = true
        defer { if identity == taskID { loading = false } }
        guard let workspace = model.workspace else { return }
        do {
            let plots = try await workspace.data("hetu.plot.list", input: ["document_id": .string(model.documentID), "limit": .integer(1)])
            guard let plot = plots["plots"].array.first else { return }
            let reports = try await workspace.data("hetu.reports.list", input: ["plot_revision_id": plot["plot_revision_id"], "limit": .integer(1)])
            guard let report = reports["reports"].array.first else { return }
            let next = try await workspace.data("hetu.reports.get", input: ["report_id": report["report_id"]], allowPartial: true)
            guard identity == taskID, !Task.isCancelled else { return }
            result = next
        } catch {
            guard identity == taskID, !Task.isCancelled else { return }
            self.error = model.localizer.error(error)
        }
    }
}
