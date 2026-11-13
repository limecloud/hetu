import AppKit
import SwiftUI
import UniformTypeIdentifiers
import HetuCore
import HetuNative

struct CoverWorkbenchSheet: View {
    let model: WorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var session: CoverSession
    @State private var client: AgentClient
    @State private var direction = ""
    @State private var synopsis: String
    @State private var prompt = ""
    @State private var promptLanguage: String
    @State private var coverLanguage: String
    @State private var width = 1024
    @State private var height = 1536
    @State private var count = 1
    @State private var textMode = "background_only"
    @State private var installation = false
    @State private var copied = false
    @State private var importedFile: URL?
    @State private var inspected: JSONValue = .null
    @State private var manualOverlay = false
    @State private var historyRevision = 1
    init(model: WorkspaceModel) {
        self.model = model
        _session = State(initialValue: CoverSession(model: model))
        _client = State(initialValue: model.agentIntegration.association(for: model.workspaceID).client)
        _synopsis = State(initialValue: String((model.novelMetadata["synopsis"].string ?? "").prefix(4000)))
        _promptLanguage = State(initialValue: model.locale)
        _coverLanguage = State(initialValue: model.novelMetadata["language_tag"].string ?? model.locale)
    }
    private var book: JSONValue { .object(["title": .string(model.title), "author_name": model.novelMetadata["author_name"], "synopsis": .string(synopsis), "language_tag": model.novelMetadata["language_tag"]]) }
    private var design: JSONValue { .object(["art_direction": .string(direction), "width": .integer(Int64(width)), "height": .integer(Int64(height)), "candidate_count": .integer(Int64(count)), "text_mode": .string(textMode), "cover_language": .string(coverLanguage)]) }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(model.t("cover.manage")).font(.title2)
                Text(model.title).foregroundStyle(.secondary)
                Spacer()
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(session.pending != nil)
            }
            if let error = session.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if session.pending != nil { Button(model.t("drama.retry")) { Task { await session.retry() } } }
            HSplitView {
                ScrollView { VStack(alignment: .leading, spacing: 16) { currentCover; coverHistory; Divider(); preparation }.padding(.trailing, 16) }.frame(minWidth: 300, idealWidth: 350, maxWidth: 420)
                ScrollView { VStack(alignment: .leading, spacing: 16) { manualImport; Divider(); requestHistory; results }.padding(.leading, 16).frame(maxWidth: .infinity, alignment: .leading) }.frame(minWidth: 390)
            }
        }.padding(24).frame(minWidth: 900, idealWidth: 1100, minHeight: 680, idealHeight: 820)
            .interactiveDismissDisabled(session.pending != nil)
            .task { await session.refresh() }
            .onChange(of: design) { _, _ in session.discardPreview(); copied = false }
            .onChange(of: book) { _, _ in session.discardPreview(); copied = false }
            .onChange(of: promptLanguage) { _, _ in session.discardPreview(); copied = false }
            .sheet(isPresented: $installation) {
                AgentInstallationSheet(settings: model.agentIntegration, workspaceID: model.workspaceID,
                    association: AgentAssociation(client: client, suiteID: model.agentIntegration.association(for: model.workspaceID).suiteID),
                    localizer: model.localizer, onSelection: { client = $0.client })
            }
    }
    @ViewBuilder private var coverHistory: some View {
        if let revision = session.current["cover"]["revision"].integer, revision > 1 {
            DisclosureGroup(model.t("cover.history")) {
                VStack(alignment: .leading, spacing: 10) {
                    Stepper(model.t("cover.revision", ["revision": String(historyRevision)]), value: $historyRevision, in: 1...max(1, Int(revision) - 1))
                    Button(model.t("cover.view_revision")) { Task { await session.inspectRevision(historyRevision) } }.disabled(session.held)
                    if session.history["cover"] != .null {
                        BookCoverView(title: model.title, author: model.novelMetadata["author_name"].string ?? "", identity: model.workspaceID,
                            imageData: session.history["preview"]["base64"].string.flatMap { Data(base64Encoded: $0) },
                            titleOverlay: session.history["cover"]["presentation"]["title_overlay"].string,
                            authorOverlay: session.history["cover"]["presentation"]["author_overlay"].string)
                            .frame(maxWidth: .infinity).frame(height: 210)
                        Text(model.t("cover.revision", ["revision": String(session.history["cover"]["revision"].integer ?? 1)])).font(.caption).foregroundStyle(.secondary)
                        Button(model.t("cover.restore")) { Task { _ = await session.restoreInspectedRevision() } }.disabled(session.held)
                    }
                }.padding(.top, 8)
            }
        }
    }
    private var currentCover: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Text(model.t("cover.current")).font(.headline); Spacer(); Button(model.t("common.refresh")) { Task { await session.refresh(); await model.refresh() } }.disabled(session.held) }
            if session.current["cover"] != .null {
                BookCoverView(title: model.title, author: model.novelMetadata["author_name"].string ?? "", identity: model.workspaceID,
                    imageData: session.current["preview"]["base64"].string.flatMap { Data(base64Encoded: $0) },
                    titleOverlay: session.current["cover"]["presentation"]["title_overlay"].string,
                    authorOverlay: session.current["cover"]["presentation"]["author_overlay"].string)
                    .frame(maxWidth: .infinity).frame(height: 210)
                Text(model.t("cover.revision", ["revision": String(session.current["cover"]["revision"].integer ?? 1)])).font(.caption).foregroundStyle(.secondary)
            } else { Text(model.t("cover.placeholder")).foregroundStyle(.secondary) }
        }
    }
    private var preparation: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.t("cover.external")).font(.headline)
            Picker(model.t("agent.client"), selection: $client) { ForEach(AgentClient.allCases, id: \.self) { Text(model.t($0.titleKey)).tag($0) } }
            Button(model.t("agent.install_title")) { installation = true }.controlSize(.small)
            Text(model.t("cover.direction")).font(.headline)
            TextEditor(text: $direction).frame(height: 80).border(WorkbenchPalette.line, width: 0.5).accessibilityLabel(model.t("cover.direction"))
            outgoingBook
            designFields
            previewButton
            promptPreview
        }.disabled(session.pending != nil)
    }
    private var outgoingBook: some View {
        DisclosureGroup(model.t("cover.outgoing")) {
            LabeledContent(model.t("workspace.title"), value: model.title)
            LabeledContent(model.t("novel.author"), value: model.novelMetadata["author_name"].string ?? "")
            TextEditor(text: $synopsis).frame(height: 100).border(WorkbenchPalette.line, width: 0.5).accessibilityLabel(model.t("novel.synopsis"))
        }
    }
    private var designFields: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker(model.t("cover.text_mode"), selection: $textMode) {
                Text(model.t("cover.background_only")).tag("background_only")
                Text(model.t("cover.title_and_author")).tag("title_and_author")
            }
            HStack { TextField(model.t("cover.width"), value: $width, format: .number); Text("×"); TextField(model.t("cover.height"), value: $height, format: .number) }
            Stepper(model.t("cover.count", ["count": String(count)]), value: $count, in: 1...4)
            Picker(model.t("cover.prompt_language"), selection: $promptLanguage) { Text("简体中文").tag("zh-CN"); Text("English").tag("en") }
            TextField(model.t("cover.cover_language"), text: $coverLanguage)
        }
    }
    private var previewButton: some View {
        Button(model.t("creative.preview_prompt")) { Task {
            await session.previewPrompt(book: book, design: design, language: promptLanguage)
            prompt = session.preview["prompt"].string ?? ""
        } }.disabled(session.held || client == .none || direction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !(64...8192).contains(width) || !(64...8192).contains(height))
    }
    @ViewBuilder private var promptPreview: some View {
        if session.preview != .null {
            Text(model.t("creative.prompt")).font(.headline)
            TextEditor(text: $prompt).frame(height: 180).border(WorkbenchPalette.line, width: 0.5).accessibilityLabel(model.t("creative.prompt"))
            Button(model.t("cover.create_request")) { Task { await session.createRequest(prompt: prompt) } }
                .buttonStyle(WorkbenchButtonStyle(primary: true))
                .disabled(session.held || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
    private var manualImport: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Text(model.t("cover.import")).font(.headline); Spacer(); Button(model.t("cover.choose_file")) { chooseFile() }.disabled(session.held) }
            if let importedFile, inspected != .null {
                Text(importedFile.lastPathComponent).textSelection(.enabled)
                previewImage(inspected["preview"], title: importedFile.lastPathComponent).frame(height: 230)
                Text("\(inspected["width"].integer ?? 0) × \(inspected["height"].integer ?? 0) px").font(.caption).foregroundStyle(.secondary)
                Toggle(model.t("cover.add_text"), isOn: $manualOverlay)
                Button(model.t("cover.use")) { Task { if await session.selectFile(importedFile, inspection: inspected, overlay: manualOverlay) { self.importedFile = nil; inspected = .null } } }.disabled(session.held)
            }
        }
    }
    private var requestHistory: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.t("cover.requests")).font(.headline)
            ForEach(Array(session.requests.enumerated()), id: \.offset) { _, item in
                Button { Task { copied = false; await session.inspect(item["request"]["request_id"].string ?? "") } } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item["request"]["design"]["art_direction"].string ?? "").lineLimit(2)
                        Text(item["request"]["created_at"].string ?? "").font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.disabled(session.held)
            }
            if session.nextCursor != nil { Button(model.t("creative.more")) { Task { await session.loadRequests(append: true) } }.disabled(session.held) }
        }
    }
    @ViewBuilder private var results: some View {
        if let requestID = session.candidates["request"]["request_id"].string {
            Divider()
            Text(model.t("cover.state." + (session.candidates["state"].string ?? "waiting_for_result"))).font(.headline)
            HStack {
                Button(model.t("creative.copy_prompt")) { copyRequest() }.disabled(session.held || client == .none)
                Button(model.t("cover.recheck")) { Task { await session.inspect(requestID) } }.disabled(session.held)
            }
            Text(model.t(copied ? "creative.copied" : "cover.handoff")).font(.caption).foregroundStyle(.secondary)
            if session.candidates["book_changed"].bool == true { Text(model.t("cover.book_changed")).foregroundStyle(.orange) }
            ForEach(Array(session.candidates["candidates"].array.enumerated()), id: \.offset) { _, item in
                candidateView(item)
            }
        }
    }
    private func candidateView(_ item: JSONValue) -> some View {
        let candidate = item["candidate"]
        let generator = candidate["generator"]
        let source = [generator["agent"].string, generator["tool"].string, generator["model"].string].compactMap { $0 }.joined(separator: " / ")
        return VStack(alignment: .leading, spacing: 10) {
            previewImage(item["preview"], title: candidate["filename"].string ?? "").frame(height: 300)
            Text("\(candidate["width"].integer ?? 0) × \(candidate["height"].integer ?? 0) px").font(.caption).foregroundStyle(.secondary)
            if item["target_size_matches"].bool == false { Text(model.t("cover.size_changed")).font(.caption).foregroundStyle(.orange) }
            DisclosureGroup(model.t("cover.source")) {
                Text(candidate["used_prompt"].string ?? "").textSelection(.enabled)
                Text(source).font(.caption).textSelection(.enabled)
            }
            Button(model.t("cover.use")) { Task { _ = await session.selectCandidate(item) } }.disabled(session.held)
        }
    }
    @ViewBuilder private func previewImage(_ value: JSONValue, title: String) -> some View {
        if let encoded = value["base64"].string, let data = Data(base64Encoded: encoded), let image = NSImage(data: data) {
            Image(nsImage: image).resizable().scaledToFit().accessibilityLabel(title)
        }
    }
    private func chooseFile() {
        let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.allowedContentTypes = ["png", "jpg", "jpeg", "webp"].compactMap { UTType(filenameExtension: $0) }
        guard panel.runModal() == .OK, let file = panel.url else { return }
        Task {
            inspected = .null; importedFile = nil
            if let value = await session.read("hetu.covers.inspect_file", input: ["file_path": .string(file.path)]) { inspected = value; importedFile = file }
        }
    }
    private func copyRequest() {
        guard let root = model.workspace?.url, let requestID = session.candidates["request"]["request_id"].string else { return }
        let path = root.appendingPathComponent("packages/visual-prompt/covers/requests/\(requestID).json").path
        let suiteID = model.agentIntegration.association(for: model.workspaceID).suiteID
        let skill = (try? AgentSuiteCatalog.bundled().suites.first { $0.id == suiteID })?.skillName("hetu-cover", client: client) ?? "hetu-cover"
        let instruction = model.locale == "en" ? "Use \(skill). Read the fixed cover request at:" : "请使用 \(skill)，读取以下固定封面请求："
        let text = instruction + "\n" + path + "\nrequest_sha256: " + (session.candidates["request_sha256"].string ?? "") + "\n\n" + (session.candidates["request"]["prompt"].string ?? "")
        NSPasteboard.general.clearContents(); copied = NSPasteboard.general.setString(text, forType: .string)
    }
}
