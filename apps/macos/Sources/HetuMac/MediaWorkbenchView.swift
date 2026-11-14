import AppKit
import AVKit
import SwiftUI
import HetuCore
import HetuNative

struct MediaWorkbenchView: View {
    let model: WorkspaceModel
    @State private var section = "resources"
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Picker(model.t("media.content"), selection: $section) {
                Text(model.t("resources.title")).tag("resources")
                Text(model.t("media.files")).tag("files")
            }.pickerStyle(.segmented).frame(maxWidth: 320).padding(.horizontal, 24).padding(.top, 16)
            if section == "resources" { ResourceWorkbenchView(model: model) }
            else { MediaFilesWorkbenchView(model: model) }
        }
    }
}

private struct MediaFilesWorkbenchView: View {
    let model: WorkspaceModel
    @State private var tab = "cues"
    @State private var kind = ""
    @State private var includeArchived = false
    @State private var records: [JSONValue] = []
    @State private var cursor: String?
    @State private var selected: String?
    @State private var result: JSONValue = .null
    @State private var error: String?
    @State private var editor: DramaSheet?
    @State private var source: DramaSheet?
    private var object: String { tab == "assets" ? "asset" : "cue" }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            WorkbenchHeading(title: model.t("media.title"), subtitle: model.t("media.description"), artwork: result == .null ? "" : "media-collection") {
                Button(model.t("common.refresh")) { Task { await load() } }
                Button(model.t(tab == "assets" ? "media.import" : "media.new_cue")) { editor = DramaSheet(value: .null) }
                    .buttonStyle(WorkbenchButtonStyle(primary: true))
                    .disabled(!model.pendingStructureOperations.isEmpty)
            }
            HStack {
                Picker(model.t("media.content"), selection: $tab) {
                    Text(model.t("media.cues")).tag("cues")
                    Text(model.t("media.assets")).tag("assets")
                }.pickerStyle(.segmented).labelsHidden().frame(maxWidth: 260)
                Picker(model.t("media.kind"), selection: $kind) {
                    Text(model.t("media.all")).tag("")
                    Text(model.t("media.kind.music")).tag("music")
                    Text(model.t("media.kind.visual")).tag("visual")
                }.frame(maxWidth: 220)
                if tab == "cues" { Toggle(model.t("media.include_archived"), isOn: $includeArchived) }
            }
            if let error { Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            Divider()
            HSplitView {
                VStack(spacing: 8) {
                    if records.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "tray").font(.system(size: 20, weight: .semibold)).foregroundStyle(WorkbenchPalette.jade).accessibilityHidden(true)
                            Text(model.t("media.empty")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
                        }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    else {
                        List {
                            ForEach(Array(records.enumerated()), id: \.offset) { _, record in
                                Button { Task { await choose(record[object + "_id"].string ?? "") } } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(record["title"].string ?? "").fontWeight(selected == record[object + "_id"].string ? .semibold : .regular)
                                        Text(model.t("media.kind." + (record["kind"].string ?? "visual"))).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                                        if let rights = record["rights_status"].string {
                                            Text(model.t("media.rights." + rights)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                                        }
                                        if record["archived"].bool == true { Text(model.t("media.archived")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
                                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 3).contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityAddTraits(selected == record[object + "_id"].string ? [.isSelected] : [])
                            }
                        }.scrollContentBackground(.hidden)
                    }
                    if cursor != nil { Button(model.t("media.more")) { Task { await load(more: true) } }.padding(.bottom, 8) }
                }.frame(minWidth: 190, idealWidth: 240, maxWidth: 320)
                if result == .null { WorkbenchEmptyState(title: model.t("media.select"), detail: model.t("media.empty_detail"), artwork: "media-collection") }
                else { detail.frame(minWidth: 340, maxWidth: .infinity, maxHeight: .infinity) }
            }
        }.padding(28).workbenchPage().disabled(model.busy)
        .task(id: "\(tab)-\(kind)-\(includeArchived)") { selected = nil; result = .null; await load() }
        .sheet(item: $editor) { item in
            if tab == "assets" {
                AssetEditorSheet(model: model, initial: item.value) { id in Task { await load(); await choose(id) } }
            } else {
                CueEditorSheet(model: model, initial: item.value, defaultKind: kind.isEmpty ? "visual" : kind) { id in Task { await load(); await choose(id) } }
            }
        }
        .sheet(item: $source) { item in PlotSourceView(model: model, source: item.value) }
    }
    private var detail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                let record = result[object]
                HStack {
                    Text(record["title"].string ?? "").font(.system(size: 20, weight: .semibold))
                    Spacer()
                    Button(model.t("media.edit")) { editor = DramaSheet(value: result) }
                        .disabled(result["is_head"].bool == false || !model.pendingStructureOperations.isEmpty)
                }
                Text(model.t("drama.revision", ["revision": String(record["revision"].integer ?? 1)])).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                HStack {
                    Button(model.t("media.previous")) { Task { await choose(selected ?? "", revision: (record["revision"].integer ?? 1) - 1) } }
                        .disabled((record["revision"].integer ?? 1) <= 1)
                    if result["is_head"].bool == false {
                        Text(model.t("media.historical")).foregroundStyle(WorkbenchPalette.warningInk).font(.system(size: 12))
                        Button(model.t("media.latest")) { Task { await choose(selected ?? "") } }
                    }
                }
                if tab == "assets" { assetDetail(record) } else { cueDetail(record) }
                Divider()
                ObjectTimestampsView(localizer: model.localizer, record: record, updatedLabel: "properties.metadata_updated")
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 8)
        }
    }
    private func assetDetail(_ record: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("media.rights." + (record["rights_status"].string ?? "unknown"))).font(.system(size: 14, weight: .semibold))
            Text(model.t(result["delivery_eligible"].bool == true ? "media.delivery_allowed" : "media.delivery_excluded"))
                .foregroundStyle(result["delivery_eligible"].bool == true ? WorkbenchPalette.muted : .orange)
            if result["is_head"].bool == false {
                Text(model.t("media.current_rights", ["rights": model.t("media.rights." + (result["current_rights_status"].string ?? "unknown"))])).foregroundStyle(WorkbenchPalette.warningInk)
            }
            Text(record["rights_statement"].string ?? "").textSelection(.enabled)
            LabeledContent(model.t("media.original_filename"), value: record["original_filename"].string ?? "")
            LabeledContent(model.t("media.file_size"), value: model.localizer.byteCount(record["blob"]["size_bytes"].integer ?? 0))
            LabeledContent(model.t("media.file_type"), value: record["blob"]["media_type"].string ?? "")
            Text(model.t("media.source_type." + (record["source"]["source_type"].string ?? "author_supplied")))
            Text(record["source"]["creator_statement"].string ?? "").textSelection(.enabled)
            if let uri = record["source"]["source_uri"].string { Text(uri).font(.system(size: 12)).textSelection(.enabled) }
            Text(model.t("media.signature_note")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            Text("SHA-256: " + (record["blob"]["sha256"].string ?? "")).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
            if let url = model.workspace?.url.appendingPathComponent(record["blob"]["path"].string ?? "") {
                MediaPreview(url: url, mediaType: record["blob"]["media_type"].string ?? "", size: record["blob"]["size_bytes"].integer ?? 0, localizer: model.localizer).id(url.path)
            }
        }
    }
    private func cueDetail(_ record: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if record["archived"].bool == true { Text(model.t("media.archived")).foregroundStyle(WorkbenchPalette.muted) }
            Text(record["description"].string ?? "").textSelection(.enabled)
            Text(model.t("media.narrative_refs")).font(.system(size: 14, weight: .semibold))
            if !result["stale_sources"].array.isEmpty { Text(model.t("media.sources_stale")).foregroundStyle(WorkbenchPalette.warningInk) }
            ForEach(Array(record["narrative_refs"].array.enumerated()), id: \.offset) { _, ref in
                Button { source = DramaSheet(value: ref) } label: { Text(ref["quote"].string ?? "").lineLimit(3) }.buttonStyle(.link)
            }
            Text(model.t("media.linked_assets")).font(.system(size: 14, weight: .semibold))
            if result["assets"].array.isEmpty { Text(model.t("media.no_assets")).foregroundStyle(WorkbenchPalette.muted) }
            ForEach(Array(result["assets"].array.enumerated()), id: \.offset) { _, asset in
                VStack(alignment: .leading, spacing: 4) {
                    Text(asset["title"].string ?? "")
                    Text(model.t("media.rights." + (asset["rights_status"].string ?? "unknown"))).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                    if asset["metadata_stale"].bool == true { Text(model.t("media.asset_stale")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.warningInk) }
                }
            }
        }
    }
    private func load(more: Bool = false) async {
        error = nil
        if !more { records = []; cursor = nil; result = .null }
        var input: [String: JSONValue] = ["limit": .integer(50)]
        if !kind.isEmpty { input["kind"] = .string(kind) }
        if tab == "cues" { input["include_archived"] = .bool(includeArchived) }
        if more, let cursor { input["cursor"] = .string(cursor) }
        guard let data = await model.workspaceAction("hetu.\(tab).list", input: input, onFailure: { error = $0; _ = $1 }) else { return }
        records += data[tab].array; cursor = data["next_cursor"].string
        if !more, let selected { await choose(selected) }
    }
    private func choose(_ id: String, revision: Int64? = nil) async {
        error = nil; result = .null; selected = id
        var input: [String: JSONValue] = [object + "_id": .string(id)]
        if let revision { input["revision"] = .integer(revision) }
        result = await model.workspaceAction("hetu.\(tab).get", input: input, onFailure: { error = $0; _ = $1 }) ?? .null
    }
}

private struct MediaPreview: View {
    let url: URL
    let mediaType: String
    let size: Int64
    let localizer: Localizer
    @State private var player: AVPlayer?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if mediaType.hasPrefix("image/"), size <= 20 * 1024 * 1024, let image = NSImage(contentsOf: url) {
                Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: 260).accessibilityLabel(localizer.text("media.preview"))
            } else if let player {
                VideoPlayer(player: player).frame(height: mediaType.hasPrefix("video/") ? 260 : 90).accessibilityLabel(localizer.text("media.preview"))
            } else { Text(localizer.text("media.preview_unavailable")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
        }.task {
            if mediaType.hasPrefix("audio/") || mediaType.hasPrefix("video/") { player = AVPlayer(url: url) }
        }.onDisappear { player?.pause(); player = nil }
    }
}
