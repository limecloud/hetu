import AppKit
import SwiftUI
import HetuCore
import HetuNative

struct AuthorLibraryView: View {
    let model: WorkspaceModel
    @Binding var locale: String
    let onOpen: (LibraryEntry) -> Void
    let onNew: () -> Void
    let onAdd: () -> Void
    @State private var agentEntry: AgentEntryPoint?
    @State private var deletionEntry: LibraryEntry?
    @SceneStorage("Hetu.library.search") private var search = ""
    @SceneStorage("Hetu.library.status") private var status = "all"
    @SceneStorage("Hetu.library.kind") private var kind = "all"
    @AppStorage("Hetu.library.list") private var listMode = true
    private let statuses = ["planning", "writing", "completed", "archived"]
    private var entries: [LibraryEntry] {
        model.libraryEntries.filter {
            (kind == "all" || $0.contentType == kind) && (status == "all" || $0.status == status) && (search.isEmpty || [$0.title, $0.authorName, $0.genre].contains { $0.localizedStandardContains(search) })
        }
    }
    var body: some View {
        VStack(spacing: 0) {
            topbar
            Divider()
            HStack(alignment: .top, spacing: 0) {
                sidebar
                Divider()
                libraryContent.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }.foregroundStyle(WorkbenchPalette.ink).background { WorkbenchBackdrop().ignoresSafeArea() }.tint(WorkbenchPalette.jade)
            .buttonStyle(WorkbenchButtonStyle()).disabled(model.busy)
            .task { await model.loadLibrary() }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in Task { await model.loadLibrary() } }
            .sheet(item: $agentEntry) { entry in
                AgentAccessSheet(initialEntry: entry, localizer: model.localizer)
            }
            .sheet(item: $deletionEntry) { entry in
                DeleteWorkSheet(model: model, entry: entry)
            }
    }
    private var topbar: some View {
        HStack(spacing: 12) {
            Image(nsImage: NSApp.applicationIconImage).resizable().scaledToFit().frame(width: 34, height: 34).accessibilityHidden(true)
            Text(model.t("brand.name")).font(.system(size: 20, weight: .semibold))
            Spacer()
            Button(locale == "en" ? "中文" : "EN") { locale = locale == "en" ? "zh-CN" : "en" }.buttonStyle(.plain)
            WorkbenchSettingsButton(locale: locale)
            WorkspaceZoomButton(localizer: model.localizer)
            Button(model.t("library.add"), action: onAdd)
            Button(model.t("workspace.new"), action: onNew).buttonStyle(WorkbenchButtonStyle(primary: true))
        }.padding(.horizontal, 32).frame(height: 70).background(WorkbenchPalette.surface.opacity(0.32))
    }
    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.t("library.collection")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).padding(.horizontal, 12).padding(.bottom, 8)
            filter("all", "library.all")
            ForEach(["novel", "drama", "video"], id: \.self) { value in filter(value, "creation.type." + value) }
            Spacer()
            Button { agentEntry = .mcp } label: {
                Label(model.t("agent.access.title"), systemImage: "sparkles").font(.system(size: 14))
            }.buttonStyle(.plain).padding(12)
        }.padding(16).frame(width: 190).frame(maxHeight: .infinity).background(WorkbenchPalette.surface.opacity(0.22))
    }
    private var libraryContent: some View {
        VStack(alignment: .leading, spacing: 22) {
            if model.libraryEntries.isEmpty { libraryBanner }
            controls
            if model.libraryEntries.isEmpty {
                VStack(spacing: 16) {
                    LibraryArtwork(name: "library-empty").frame(width: 240, height: 200).clipped()
                    Text(model.t("library.empty")).font(.system(size: 20, weight: .semibold))
                    Text(model.t("library.empty_detail")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted).multilineTextAlignment(.center).frame(maxWidth: 420)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if entries.isEmpty {
                ContentUnavailableView {
                    Label(model.t("library.no_matches"), systemImage: "magnifyingglass")
                        .font(.system(size: 20, weight: .semibold))
                } description: {
                    if !search.isEmpty {
                        Text(search).font(.system(size: 14)).lineLimit(2).frame(maxWidth: 420)
                    }
                } actions: {
                    Button(model.t("library.clear_filters")) { search = ""; status = "all"; kind = "all" }
                }
            } else { collection }
        }
    }
    private var controls: some View {
        HStack {
            Text(model.t(kind == "all" ? "library.all" : "creation.type." + kind)).font(.system(size: 14, weight: .semibold))
            Text("\(entries.count)").foregroundStyle(WorkbenchPalette.muted)
            Spacer()
            Picker(model.t("library.status"), selection: $status) {
                Text(model.t("library.all_statuses")).tag("all")
                ForEach(statuses, id: \.self) { Text(model.t("novel.status." + $0)).tag($0) }
            }.labelsHidden().accessibilityLabel(model.t("library.status")).frame(maxWidth: 140)
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass").foregroundStyle(WorkbenchPalette.muted).accessibilityHidden(true)
                TextField(model.t("library.search"), text: $search).textFieldStyle(.plain).accessibilityLabel(model.t("library.search"))
            }.padding(.horizontal, 10).padding(.vertical, 8).frame(width: 240).workbenchSurface(radius: 8)
            Picker(model.t("library.layout"), selection: $listMode) {
                Image(systemName: "square.grid.2x2").tag(false)
                Image(systemName: "list.bullet").tag(true)
            }.pickerStyle(.segmented).labelsHidden().accessibilityLabel(model.t("library.layout")).frame(width: 76)
            Button { Task { await model.loadLibrary() } } label: { Image(systemName: "arrow.clockwise") }.help(model.t("common.refresh"))
        }
    }
    private var collection: some View {
        ScrollView {
            if listMode {
                LazyVStack(spacing: 0) {
                    ForEach(entries) { entry in
                        libraryRow(entry)
                        Divider()
                    }
                }.workbenchSurface()
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 174, maximum: 192), spacing: 24)], alignment: .leading, spacing: 28) {
                    ForEach(entries) { entry in bookCard(entry) }
                }.padding(1)
            }
        }
    }
    private func libraryRow(_ entry: LibraryEntry) -> some View {
        Button { onOpen(entry) } label: {
            HStack(spacing: 18) {
                WorkLibraryThumbnail(entry: entry, compact: true).frame(width: 48, height: 64)
                VStack(alignment: .leading, spacing: 6) {
                    Text(entry.title).font(.system(size: 14, weight: .semibold))
                    workSubtitle(entry)
                }
                Spacer()
                statusBadge(entry.status)
                if entry.contentType == "novel" {
                    Text(model.t("novel.chapter_count", ["count": String(entry.chapterCount)])).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).frame(width: 100, alignment: .trailing)
                }
                ObjectTimestampsView(localizer: model.localizer, record: .object([
                    "created_at": entry.createdAt.map(JSONValue.string) ?? .null,
                    "updated_at": entry.updatedAt.map(JSONValue.string) ?? .null
                ])).frame(width: 210)
            }.padding(.horizontal, 16).padding(.vertical, 14).contentShape(Rectangle())
        }.buttonStyle(WorkbenchNavigationStyle()).help(propertySummary(entry)).accessibilityLabel(entry.title).accessibilityValue(accessibleStatus(entry))
            .contextMenu { deletionMenu(entry) }
    }
    private func bookCard(_ entry: LibraryEntry) -> some View {
        Button { onOpen(entry) } label: {
            VStack(alignment: .leading, spacing: 10) {
                WorkLibraryThumbnail(entry: entry).frame(height: 220)
                Text(entry.title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                workSubtitle(entry)
                HStack {
                    statusBadge(entry.status)
                    Spacer(minLength: 4)
                    if entry.contentType == "novel" {
                        Text(model.t("novel.chapter_count", ["count": String(entry.chapterCount)]))
                    }
                }.font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                Text(model.t("properties.updated") + " " + (entry.updatedAt.map(model.localizer.date) ?? model.t("properties.not_recorded")))
                    .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).lineLimit(1)
            }.padding(12).workbenchSurface().contentShape(Rectangle())
        }.buttonStyle(WorkbenchNavigationStyle()).help(propertySummary(entry)).accessibilityLabel(entry.title).accessibilityValue(accessibleStatus(entry))
            .contextMenu { deletionMenu(entry) }
    }
    @ViewBuilder private func deletionMenu(_ entry: LibraryEntry) -> some View {
        Button { Task { await model.removeLibraryEntry(entry) } } label: {
            Label(model.t("library.remove_registration"), systemImage: "minus.circle")
        }
        Button(role: .destructive) { deletionEntry = entry } label: {
            Label(model.t("library.delete.menu"), systemImage: "trash")
        }
    }
    private func workSubtitle(_ entry: LibraryEntry) -> some View {
        HStack(spacing: 8) {
            Text(model.t("creation.type." + entry.contentType))
            if !entry.authorName.isEmpty { Text(entry.authorName) }
        }.font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).lineLimit(1)
    }
    private func accessibleStatus(_ entry: LibraryEntry) -> String {
        let type = model.t("creation.type." + entry.contentType)
        let count = entry.contentType == "novel" ? ", " + model.t("novel.chapter_count", ["count": String(entry.chapterCount)]) : ""
        return type + ", " + model.t("novel.status." + entry.status) + count + ", " + propertySummary(entry)
    }
    private func propertySummary(_ entry: LibraryEntry) -> String {
        [model.t("properties.created") + " " + (entry.createdAt.map(model.localizer.date) ?? model.t("properties.not_recorded")),
         model.t("properties.updated") + " " + (entry.updatedAt.map(model.localizer.date) ?? model.t("properties.not_recorded")),
         model.t("properties.last_opened") + " " + (entry.lastOpenedAt.map { $0.formatted(date: .numeric, time: .standard) } ?? model.t("properties.not_recorded")), entry.path].joined(separator: "\n")
    }
    private var libraryBanner: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.t("agent.access.headline")).font(.system(size: 20, weight: .semibold))
            Text(model.t("agent.access.roles")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 0) {
                ForEach(AgentEntryPoint.allCases) { entry in
                    Button { agentEntry = entry } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(entry.rawValue).font(.system(size: 14, weight: .semibold)).foregroundStyle(WorkbenchPalette.jade)
                            Text(model.t(entry.summaryKey)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                            Spacer(minLength: 4)
                            Image(systemName: "arrow.up.right").font(.system(size: 12)).accessibilityHidden(true)
                        }.padding(.vertical, 10).padding(.horizontal, 12).contentShape(Rectangle())
                    }.buttonStyle(.plain).help(model.t(entry.detailKey))
                        .accessibilityLabel(entry.rawValue + ", " + model.t(entry.summaryKey))
                    if entry != AgentEntryPoint.allCases.last {
                        Rectangle().fill(WorkbenchPalette.line).frame(width: 0.5, height: 24).accessibilityHidden(true)
                    }
                }
            }.background(WorkbenchPalette.surface, in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(WorkbenchPalette.line, lineWidth: 0.5))
        }.padding(20).background(WorkbenchPalette.sidebar, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(WorkbenchPalette.line, lineWidth: 0.5))
    }
    private func filter(_ value: String, _ key: String) -> some View {
        Button { kind = value } label: {
            HStack {
                Image(systemName: ["all": "square.grid.2x2", "novel": "book", "drama": "doc.text", "video": "film"][value] ?? "book")
                    .frame(width: 18).accessibilityHidden(true)
                Text(model.t(key))
                Spacer()
                Text("\(model.libraryEntries.filter { value == "all" || $0.contentType == value }.count)").font(.system(size: 12))
            }.padding(12).foregroundStyle(kind == value ? WorkbenchPalette.jade : WorkbenchPalette.ink)
        }.buttonStyle(WorkbenchNavigationStyle(selected: kind == value)).accessibilityAddTraits(kind == value ? .isSelected : [])
    }
    private func statusBadge(_ value: String) -> some View {
        Text(model.t("novel.status." + value)).font(.system(size: 12, weight: .medium)).foregroundStyle(WorkbenchPalette.jade)
            .padding(.horizontal, 7).padding(.vertical, 4).background(WorkbenchPalette.jadeSoft, in: Capsule())
    }
}

