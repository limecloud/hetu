import AppKit
import SwiftUI
import HetuNative

struct AuthorLibraryView: View {
    let model: WorkspaceModel
    @Binding var locale: String
    let onOpen: (LibraryEntry) -> Void
    let onNew: () -> Void
    let onAdd: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var search = ""
    @State private var status = "all"
    @AppStorage("Hetu.library.list") private var listMode = false
    private let statuses = ["planning", "writing", "completed", "archived"]
    private var entries: [LibraryEntry] {
        model.libraryEntries.filter {
            (status == "all" || $0.status == status) && (search.isEmpty || [$0.title, $0.authorName, $0.genre].contains { $0.localizedStandardContains(search) })
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
    }
    private var topbar: some View {
        HStack(spacing: 12) {
            Image(nsImage: NSApp.applicationIconImage).resizable().scaledToFit().frame(width: 34, height: 34).accessibilityHidden(true)
            Text(locale == "en" ? "Hetu" : "河图").font(.system(size: 18, weight: .semibold))
            Spacer()
            Button(locale == "en" ? "中文" : "EN") { locale = locale == "en" ? "zh-CN" : "en" }.buttonStyle(.plain)
            WorkbenchSettingsButton(locale: locale)
            Button(model.t("library.add"), action: onAdd)
            Button(model.t("workspace.new"), action: onNew).buttonStyle(WorkbenchButtonStyle(primary: true))
        }.padding(.leading, 82).padding(.trailing, 32).frame(height: 70).background(WorkbenchPalette.surface.opacity(0.32))
    }
    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.t("library.collection")).font(.caption).foregroundStyle(WorkbenchPalette.muted).padding(.horizontal, 12).padding(.bottom, 8)
            filter("all", "library.all")
            ForEach(statuses, id: \.self) { value in filter(value, "novel.status." + value) }
            Spacer()
            Text(model.t("library.local")).font(.caption).foregroundStyle(WorkbenchPalette.muted).lineSpacing(4).padding(12)
        }.padding(16).frame(width: 190).frame(maxHeight: .infinity).background(WorkbenchPalette.surface.opacity(0.22))
    }
    private var libraryContent: some View {
        VStack(alignment: .leading, spacing: 22) {
            libraryBanner
            controls
            if model.libraryEntries.isEmpty {
                VStack(spacing: 16) {
                    LibraryArtwork(name: "library-empty").frame(width: 240, height: 200).clipped()
                    Text(model.t("library.empty")).font(.title3.weight(.semibold))
                    Text(model.t("library.empty_detail")).font(.callout).foregroundStyle(WorkbenchPalette.muted).multilineTextAlignment(.center).frame(maxWidth: 420)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if entries.isEmpty {
                ContentUnavailableView.search(text: search)
            } else { collection }
        }
    }
    private var controls: some View {
        HStack {
            Text(model.t(status == "all" ? "library.all" : "novel.status." + status)).font(.system(size: 15, weight: .semibold))
            Text("\(entries.count)").foregroundStyle(WorkbenchPalette.muted)
            Spacer()
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass").foregroundStyle(WorkbenchPalette.muted).accessibilityHidden(true)
                TextField(model.t("library.search"), text: $search).textFieldStyle(.plain)
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
                BookCoverView(title: entry.title, author: entry.authorName, identity: entry.workspaceID, compact: true).frame(width: 42, height: 63)
                VStack(alignment: .leading, spacing: 6) {
                    Text(entry.title).font(.headline)
                    Text(entry.authorName.isEmpty ? model.t("library.no_author") : entry.authorName).font(.caption).foregroundStyle(WorkbenchPalette.muted)
                }
                Spacer()
                statusBadge(entry.status)
                Text(model.t("novel.chapter_count", ["count": String(entry.chapterCount)])).font(.caption).foregroundStyle(WorkbenchPalette.muted).frame(width: 100, alignment: .trailing)
            }.padding(.horizontal, 16).padding(.vertical, 14).contentShape(Rectangle())
        }.buttonStyle(WorkbenchNavigationStyle()).help(entry.path).accessibilityLabel(entry.title).accessibilityValue(accessibleStatus(entry))
    }
    private func bookCard(_ entry: LibraryEntry) -> some View {
        Button { onOpen(entry) } label: {
            VStack(alignment: .leading, spacing: 10) {
                BookCoverView(title: entry.title, author: entry.authorName, identity: entry.workspaceID).aspectRatio(2.0 / 3.0, contentMode: .fit)
                Text(entry.title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Text(entry.authorName.isEmpty ? model.t("library.no_author") : entry.authorName).font(.caption).foregroundStyle(WorkbenchPalette.muted).lineLimit(1)
                HStack {
                    statusBadge(entry.status)
                    Spacer(minLength: 4)
                    Text(model.t("novel.chapter_count", ["count": String(entry.chapterCount)]))
                }.font(.system(size: 11)).foregroundStyle(WorkbenchPalette.muted)
            }.padding(12).workbenchSurface().contentShape(Rectangle())
        }.buttonStyle(WorkbenchNavigationStyle()).help(entry.path).accessibilityLabel(entry.title).accessibilityValue(accessibleStatus(entry))
    }
    private func accessibleStatus(_ entry: LibraryEntry) -> String {
        model.t("novel.status." + entry.status) + ", " + model.t("novel.chapter_count", ["count": String(entry.chapterCount)])
    }
    private var libraryBanner: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                LibraryArtwork(name: colorScheme == .dark ? "library-garden-dark" : "library-garden-light")
                    .frame(width: geometry.size.width, height: 142).clipped()
                VStack(alignment: .leading, spacing: 12) {
                    Text(model.t("library.title")).font(.system(size: 25, weight: .medium, design: .serif))
                    Text(model.t("library.book_count", ["count": String(model.libraryEntries.count)]))
                        .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                }.padding(.leading, 28)
            }.background(WorkbenchPalette.sidebar).clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(WorkbenchPalette.line.opacity(0.5), lineWidth: 0.5))
        }.frame(height: 142)
    }
    private func filter(_ value: String, _ key: String) -> some View {
        Button { status = value } label: {
            HStack {
                Image(systemName: ["all": "books.vertical", "planning": "lightbulb", "writing": "pencil.line", "completed": "checkmark.seal", "archived": "archivebox"][value] ?? "book")
                    .frame(width: 18).accessibilityHidden(true)
                Text(model.t(key))
                Spacer()
                Text("\(model.libraryEntries.filter { value == "all" || $0.status == value }.count)").font(.caption)
            }.padding(12).foregroundStyle(status == value ? WorkbenchPalette.jade : WorkbenchPalette.ink)
        }.buttonStyle(WorkbenchNavigationStyle(selected: status == value)).accessibilityAddTraits(status == value ? .isSelected : [])
    }
    private func statusBadge(_ value: String) -> some View {
        Text(model.t("novel.status." + value)).font(.system(size: 10, weight: .medium)).foregroundStyle(WorkbenchPalette.jade)
            .padding(.horizontal, 7).padding(.vertical, 4).background(WorkbenchPalette.jadeSoft, in: Capsule())
    }
}

