import AppKit
import SwiftUI
import HetuCore
import HetuNative

@main
struct HetuMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @AppStorage("Hetu.appearance") private var appearance = "system"
    var body: some Scene {
        WindowGroup(id: "workspace") {
            WorkbenchView().preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
        }
            .defaultSize(width: 1400, height: 900)
            .windowStyle(.hiddenTitleBar)
            .commands {
                CommandGroup(replacing: .newItem) {
                    NewWindowButton().keyboardShortcut("n", modifiers: [.command, .shift])
                    WindowActionButton(key: "workspace.new", command: .newWorkspace).keyboardShortcut("n")
                    WindowActionButton(key: "workspace.open", command: .openWorkspace).keyboardShortcut("o")
                }
                CommandGroup(replacing: .saveItem) { WindowActionButton(key: "document.save", command: .save).keyboardShortcut("s") }
                CommandGroup(after: .toolbar) { WorkbenchAppearanceMenu() }
            }
        Settings { HetuSettingsView() }.windowResizability(.contentSize)
    }
}

private struct WorkbenchAppearanceMenu: View {
    @AppStorage("Hetu.appearance") private var appearance = "system"
    @AppStorage("Hetu.locale") private var locale = "zh-CN"
    var body: some View {
        let localizer = Localizer(locale: locale)
        Picker(localizer.text("appearance.title"), selection: $appearance) {
            ForEach(["system", "light", "dark"], id: \.self) { Text(localizer.text("appearance." + $0)).tag($0) }
        }
    }
}

private struct NewWindowButton: View {
    @Environment(\.openWindow) private var openWindow
    @FocusedValue(\.hetuWindow) private var coordinator
    var body: some View {
        Button((coordinator?.model.localizer ?? Localizer(locale: UserDefaults.standard.string(forKey: "Hetu.locale") ?? "zh-CN")).text("window.new")) { openWindow(id: "workspace") }
    }
}

private enum WindowCommand { case newWorkspace, openWorkspace, save, library }
private struct WindowCoordinatorKey: FocusedValueKey { typealias Value = WindowCoordinator }
extension FocusedValues {
    fileprivate var hetuWindow: WindowCoordinator? {
        get { self[WindowCoordinatorKey.self] }
        set { self[WindowCoordinatorKey.self] = newValue }
    }
}
private struct WindowActionButton: View {
    let key: String
    let command: WindowCommand
    @FocusedValue(\.hetuWindow) private var coordinator
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Button(coordinator?.model.t(key) ?? Localizer(locale: UserDefaults.standard.string(forKey: "Hetu.locale") ?? "zh-CN").text(key)) {
            guard let coordinator else { openWindow(id: "workspace"); return }
            Task { await coordinator.perform(command) }
        }.disabled(coordinator?.model.busy == true || (command == .save && (coordinator?.model.documentID.isEmpty ?? true)))
    }
}

@MainActor private final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) { NSApp.setActivationPolicy(.regular); NSApp.activate(ignoringOtherApps: true) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let coordinators = sender.windows.compactMap { $0.delegate as? WindowCoordinator }
        if coordinators.allSatisfy({ !$0.model.needsProtection && !$0.model.busy }) { return .terminateNow }
        for coordinator in coordinators { coordinator.model.editorSuspended = true }
        Task {
            defer { for coordinator in coordinators { coordinator.model.editorSuspended = false } }
            for coordinator in coordinators { if !(await coordinator.protect()) { sender.reply(toApplicationShouldTerminate: false); return } }
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

@MainActor private final class WindowCoordinator: NSObject, NSWindowDelegate {
    let model: WorkspaceModel
    var presentCreation: (() -> Void)?
    weak var window: NSWindow?
    // NSObject 动态转发入口是 nonisolated；写入来自 MainActor，读取前必须检查主线程。
    nonisolated(unsafe) weak var originalDelegate: (any NSWindowDelegate)?
    private var closing = false
    private var deciding = false
    private var protecting = false
    init(_ model: WorkspaceModel) { self.model = model }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closing { return originalDelegate?.windowShouldClose?(sender) ?? true }
        guard !deciding else { return false }
        deciding = true
        model.editorSuspended = true
        Task {
            defer { model.editorSuspended = false }
            let allowed = await protect()
            deciding = false
            if allowed { closing = true; sender.performClose(nil) }
        }
        return false
    }
    func protect() async -> Bool {
        guard !protecting else { return false }
        protecting = true; defer { protecting = false }
        guard !model.busy, !model.isComposing else { NSSound.beep(); return false }
        guard model.needsProtection else { return true }
        let alert = NSAlert()
        alert.messageText = model.t("unsaved.title", ["title": model.documentTitle])
        alert.informativeText = model.t("unsaved.detail")
        alert.addButton(withTitle: model.t("document.save"))
        alert.addButton(withTitle: model.t("unsaved.keep"))
        alert.addButton(withTitle: model.t("common.cancel"))
        switch alert.runModal() {
        case .alertFirstButtonReturn: return await model.save() && !model.needsProtection
        case .alertSecondButtonReturn: return await model.persistRecovery()
        default: return false
        }
    }
    nonisolated override func responds(to selector: Selector!) -> Bool {
        if super.responds(to: selector) { return true }
        guard Thread.isMainThread else { return false }
        return originalDelegate?.responds(to: selector) ?? false
    }
    nonisolated override func forwardingTarget(for selector: Selector!) -> Any? {
        guard Thread.isMainThread else { return super.forwardingTarget(for: selector) }
        let target = originalDelegate
        if target?.responds(to: selector) == true { return target }
        return super.forwardingTarget(for: selector)
    }
    func perform(_ command: WindowCommand) async {
        if command == .save { _ = await model.save(); return }
        model.editorSuspended = true; defer { model.editorSuspended = false }
        guard await protect() else { return }
        switch command {
        case .library: await model.returnToLibrary()
        case .openWorkspace:
            let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
            panel.message = model.t("workspace.choose")
            if panel.runModal() == .OK, let url = panel.url { _ = await model.open(url) }
        case .newWorkspace:
            presentCreation?()
        case .save: break
        }
    }
}

private struct WindowAttachment: NSViewRepresentable {
    let coordinator: WindowCoordinator
    func makeNSView(context: Context) -> NSView { WindowView(coordinator) }
    func updateNSView(_ nsView: NSView, context: Context) { nsView.window?.title = coordinator.model.title }
    private class WindowView: NSView {
        let coordinator: WindowCoordinator
        init(_ coordinator: WindowCoordinator) { self.coordinator = coordinator; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow(); coordinator.window = window
            if let window {
                window.titleVisibility = .hidden
                window.titlebarAppearsTransparent = true
                window.backgroundColor = WorkbenchPalette.pageColor
                if window.delegate !== coordinator { coordinator.originalDelegate = window.delegate; window.delegate = coordinator }
            }
        }
    }
}

private struct WorkbenchView: View {
    @AppStorage("Hetu.locale") private var selectedLocale = "zh-CN"
    @State private var model: WorkspaceModel
    @State private var coordinator: WindowCoordinator
    @State private var selection = "novel"
    @State private var lastNovelID = ""
    @State private var validationDocumentID = ""
    @State private var inspector = true
    @State private var draft: JSONValue = .null
    @State private var newDocument = false
    @State private var newWorkspace = false
    @State private var manageStructure = false
    @State private var showRecovery = false
    @State private var showConflict = false
    @State private var scriptMapping: DramaSheet?
    @State private var submitReview: DramaSheet?
    @State private var finalization: DramaSheet?
    init() {
        let model = WorkspaceModel()
        _model = State(initialValue: model); _coordinator = State(initialValue: WindowCoordinator(model))
    }
    var body: some View {
        Group {
            if model.workspace == nil {
                AuthorLibraryView(model: model, locale: $selectedLocale,
                    onOpen: { entry in Task { if await coordinator.protect() { _ = await model.openLibraryEntry(entry) } } },
                    onNew: { Task { await coordinator.perform(.newWorkspace) } },
                    onAdd: { Task { await coordinator.perform(.openWorkspace) } })
            }
            else {
                WorkspaceShell(model: model, selection: selection, locale: $selectedLocale,
                    onSelect: { id in Task { await select(id) } },
                    onNewDocument: { newDocument = true },
                    onNewWorkspace: { Task { await coordinator.perform(.newWorkspace) } },
                    onOpenWorkspace: { Task { await coordinator.perform(.openWorkspace) } },
                    onLibrary: { Task { await coordinator.perform(.library) } },
                    onManageStructure: { manageStructure = true },
                    onInspector: { inspector.toggle() }) { detail }
                    .disabled(model.busy)
            }
        }
        .frame(minWidth: 1024, minHeight: 700)
        .navigationTitle(model.title)
        .environment(\.locale, Locale(identifier: model.locale == "en" ? "en" : "zh-Hans"))
        .background(WindowAttachment(coordinator: coordinator))
        .focusedSceneValue(\.hetuWindow, coordinator)
        .alert(model.t("error.title"), isPresented: Binding(get: { model.message != nil }, set: { if !$0 { model.message = nil } })) {
            Button(model.t("common.ok")) { model.message = nil }
        } message: { Text(model.message ?? "") }
        .sheet(isPresented: $newDocument) { NewDocumentSheet(model: model) { id in Task { await select(id) } } }
        .sheet(isPresented: $newWorkspace) { NewWorkspaceSheet(model: model) }
        .sheet(isPresented: $manageStructure) { NovelStructureSheet(model: model) }
        .sheet(isPresented: $showRecovery) { recoverySheet }
        .sheet(isPresented: $showConflict) { conflictSheet }
        .sheet(item: $scriptMapping) { request in ScriptMappingView(model: model, documentID: request.value.string ?? "") }
        .sheet(item: $submitReview) { request in ReviewSubmitSheet(model: model, document: request.value) { id in Task { await select(id) } } }
        .sheet(item: $finalization) { request in DocumentFinalizationSheet(model: model, documentID: request.value.string ?? "") }
        .safeAreaInset(edge: .top) {
            if !model.pendingStructureOperations.isEmpty {
                HStack {
                    Text(model.t("review.pending")).font(.caption)
                    ForEach(Array(model.pendingStructureOperations.enumerated()), id: \.offset) { index, operation in
                        Button(model.t("drama.resume_pending", ["number": String(index + 1)])) {
                            Task {
                                if let result = await model.workspaceAction(operation.action, input: operation.input, onFailure: { model.message = $0; _ = $1 }) {
                                    if let id = result["draft"]["draft_id"].string ?? operation.input["draft_id"]?.string { await select(id) }
                                    else if let doc = result["document"]["document_id"].string { await select(doc) }
                                    else if operation.action.hasPrefix("hetu.git.") { await select("git") }
                                    else if operation.action.hasPrefix("hetu.assets.") || operation.action.hasPrefix("hetu.cues.") { await select("media") }
                                }
                            }
                        }.disabled(model.busy)
                    }
                }.padding(8)
            }
        }
        .onChange(of: model.workspaceID) { _, value in
            selection = ""; lastNovelID = ""; validationDocumentID = ""; draft = .null
            if !value.isEmpty { Task { await select(model.novel["initialized"].bool == true ? "novel" : "book") } }
        }
        .onAppear { model.locale = selectedLocale; coordinator.presentCreation = { newWorkspace = true } }
        .onChange(of: selectedLocale) { _, locale in model.locale = locale }
    }
    @ViewBuilder private var detail: some View {
        if selection == "book" { NovelDetailsView(model: model).id(model.workspaceID) }
        else if selection == "bible" { StoryBibleView(model: model) }
        else if selection == "plot" { PlotWorkbenchView(model: model) }
        else if selection == "validation" { ValidationWorkbenchView(model: model, initialDocumentID: validationDocumentID) }
        else if selection == "drama" { DramaWorkbenchView(model: model) { id in Task { await select(id) } } }
        else if selection == "git" { GitWorkbenchView(model: model).id(model.workspaceID) }
        else if selection == "media" { MediaWorkbenchView(model: model).id(model.workspaceID) }
        else if selection == "reviews" || selection.hasPrefix("draft_") { ReviewWorkbenchView(model: model, initialDraftID: selection.hasPrefix("draft_") ? selection : "") { id, before in Task { await select(id, adoptionUndoBaseline: before) } }.id(selection) }
        else if !model.documentID.isEmpty {
            ManuscriptView(model: model, inspector: inspector,
                onReview: { submitReview = DramaSheet(value: model.loaded) },
                onFinalization: { finalization = DramaSheet(value: .string(model.documentID)) },
                onMapping: { scriptMapping = DramaSheet(value: .string(model.documentID)) },
                onRecovery: { showRecovery = true }, onConflict: { showConflict = true },
                onBible: { Task { await select("bible") } },
                onValidation: { Task { await select("validation") } })
        } else if draft != .null {
            VStack(alignment: .leading, spacing: 12) {
                Text(draft["draft"]["title"].string ?? model.t("draft.untitled")).font(.title2)
                Label(model.t("draft.submitted"), systemImage: "tray").foregroundStyle(.secondary)
                Text(model.t("draft.readonly")).font(.callout).foregroundStyle(.secondary)
                Divider()
                ScrollView { Text(draft["content"].string ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            }.padding(24)
        } else { WorkbenchEmptyState(title: model.t("document.select"), detail: model.t("novel.empty_detail"), artwork: "story-world").workbenchPage() }
    }
    private func select(_ id: String, adoptionUndoBaseline: String? = nil) async {
        guard id != selection || adoptionUndoBaseline != nil else { return }
        if id == "novel", model.documents.contains(where: { $0.id == selection && $0.kind != "drama_script" }) { return }
        model.editorSuspended = true; defer { model.editorSuspended = false }
        guard await coordinator.protect() else { return }
        if id == "validation", !model.documentID.isEmpty { validationDocumentID = model.documentID }
        if id == "novel" {
            let chapter = model.orderedChapters.first(where: { $0.id == lastNovelID }) ?? model.orderedChapters.first ?? model.documents.first(where: { $0.kind == "novel_outline" })
            if let chapter, await model.selectDocument(chapter.id) { selection = chapter.id; lastNovelID = chapter.id }
            else { model.clearDocument(); selection = "novel" }
            draft = .null
        }
        else if ["book", "bible", "plot", "validation", "drama", "reviews", "git", "media"].contains(id) { model.clearDocument(); draft = .null; selection = id }
        else if id.hasPrefix("draft_") {
            model.clearDocument(); draft = .null; selection = id
        } else if await model.selectDocument(id, adoptionUndoBaseline: adoptionUndoBaseline) {
            draft = .null; selection = id
            if model.loaded["document"]["kind"].string != "drama_script" { lastNovelID = id }
        }
    }
    private var recoverySheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.t("recovery.title")).font(.title2)
            Text(model.t("recovery.detail")).foregroundStyle(.secondary)
            ScrollView {
                ForEach(model.recoveryCandidates) { entry in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(entry.updatedAt, format: .dateTime).font(.headline)
                        Text(entry.content).textSelection(.enabled).lineLimit(12).frame(maxWidth: .infinity, alignment: .leading)
                        Button(model.t("recovery.restore")) { Task { if await model.restore(entry) { showRecovery = false } } }
                        Divider()
                    }.padding(.vertical, 8)
                }
            }
            Button(model.t("common.close")) { showRecovery = false }
        }.padding(24).frame(width: 700, height: 520)
    }
    private var conflictSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.t("conflict.title")).font(.title2)
            Text(model.t("conflict.detail")).foregroundStyle(.secondary)
            HStack(alignment: .top) {
                VStack(alignment: .leading) { Text(model.t("conflict.disk")).font(.headline); ScrollView { Text(model.conflict["content"].string ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) } }
                Divider()
                VStack(alignment: .leading) { Text(model.t("conflict.editor")).font(.headline); ScrollView { Text(model.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) } }
            }
            HStack {
                Button(model.t("common.cancel")) { showConflict = false }
                Spacer()
                Button(model.t("conflict.use_baseline")) { Task { await model.acceptConflictBaseline(); showConflict = false } }
            }
        }.padding(24).frame(width: 820, height: 550)
    }
}

private struct NewDocumentSheet: View {
    let model: WorkspaceModel
    let onCreated: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var kind = "novel_chapter"
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(model.t("document.new")).font(.title2)
            Form {
                TextField(model.t("document.title"), text: $title)
                Picker(model.t("document.kind"), selection: $kind) {
                    Text(model.t("novel.chapter")).tag("novel_chapter")
                    Text(model.t("novel.outline")).tag("novel_outline")
                    Text(model.t("drama.script")).tag("drama_script")
                    Text(model.t("drama.note")).tag("adaptation_note")
                }
            }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t("common.create")) {
                    Task { if let id = await model.createDocument(title: title, kind: kind) { dismiss(); onCreated(id) } }
                }.keyboardShortcut(.defaultAction).disabled(model.busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 430)
    }
}

