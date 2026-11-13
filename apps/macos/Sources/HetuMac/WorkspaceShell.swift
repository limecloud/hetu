import AppKit
import SwiftUI
import HetuNative

struct WorkbenchButtonStyle: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var enabled
    @State private var hovered = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 13, weight: primary ? .semibold : .regular))
            .padding(.horizontal, 14).padding(.vertical, 8)
            .foregroundStyle(primary ? Color.white : WorkbenchPalette.ink)
            .background {
                RoundedRectangle(cornerRadius: 8).fill(primary
                    ? LinearGradient(colors: [WorkbenchPalette.actionStart, WorkbenchPalette.actionEnd], startPoint: .topLeading, endPoint: .bottomTrailing)
                    : LinearGradient(colors: [WorkbenchPalette.surface.opacity(hovered || configuration.isPressed ? 1 : 0.6)], startPoint: .top, endPoint: .bottom))
            }
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(primary ? Color.white.opacity(0.15) : WorkbenchPalette.line, lineWidth: 0.5))
            .brightness(configuration.isPressed ? -0.04 : 0)
            .opacity(enabled ? 1 : 0.45)
            .onHover { hovered = $0 }
    }
}

struct WorkspaceShell<Content: View>: View {
    let model: WorkspaceModel
    let selection: String
    @Binding var locale: String
    let onSelect: (String) -> Void
    let onNewDocument: () -> Void
    let onNewWorkspace: () -> Void
    let onOpenWorkspace: () -> Void
    let onLibrary: () -> Void
    let onManageStructure: () -> Void
    let onInspector: () -> Void
    @ViewBuilder let content: () -> Content

    @State private var collapsedVolumes: Set<String> = []

    private var group: String {
        if selection.hasPrefix("draft_") { return "reviews" }
        if let document = model.documents.first(where: { $0.id == selection }) { return document.kind == "drama_script" ? "drama" : "novel" }
        return selection
    }
    private var chapterItems: [DocumentItem] { model.orderedChapters }
    var body: some View {
        VStack(spacing: 0) {
            topbar
            Rectangle().fill(WorkbenchPalette.line).frame(height: 1)
            HStack(spacing: 0) {
                navigation
                Rectangle().fill(WorkbenchPalette.line).frame(width: 1)
                if group == "novel" {
                    chapters
                    Rectangle().fill(WorkbenchPalette.line).frame(width: 1)
                }
                content().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .font(.system(size: 13)).foregroundStyle(WorkbenchPalette.ink)
        .background { WorkbenchBackdrop().ignoresSafeArea() }.tint(WorkbenchPalette.jade)
        .buttonStyle(WorkbenchButtonStyle())
    }
    private var topbar: some View {
        HStack(spacing: 20) {
            HStack(spacing: 9) {
                Image(nsImage: NSApp.applicationIconImage).resizable().scaledToFit().frame(width: 34, height: 34).accessibilityHidden(true)
                Text(model.t("brand.name")).font(.system(size: 18, weight: .semibold))
                if locale != "en" { Text("Hetu Luoshu").font(.system(size: 15)).foregroundStyle(WorkbenchPalette.muted) }
            }
            Rectangle().fill(WorkbenchPalette.line).frame(width: 1, height: 24)
            Menu {
                Button(model.t("library.back"), action: onLibrary)
                Divider()
                Button(model.t("workspace.open"), action: onOpenWorkspace)
                Button(model.t("workspace.new"), action: onNewWorkspace)
            } label: {
                HStack(spacing: 7) {
                    Text(model.title).lineLimit(1)
                    Text(model.t("shell.workspace")).foregroundStyle(WorkbenchPalette.muted)
                }.font(.system(size: 13))
            }.menuStyle(.borderlessButton).fixedSize().accessibilityLabel(model.t("shell.switch_workspace"))
            Spacer(minLength: 12)
            if !model.documentID.isEmpty {
                Label(model.t(model.pendingSave != nil ? "document.pending" : model.dirty ? "document.modified" : "document.saved"), systemImage: model.dirty ? "pencil.line" : "checkmark.circle")
                    .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).lineLimit(1)
            }
            if model.busy { ProgressView().controlSize(.small).accessibilityLabel(model.t("common.working")) }
            Button(locale == "en" ? "中文" : "EN") { locale = locale == "en" ? "zh-CN" : "en" }
                .buttonStyle(.plain).font(.system(size: 12)).help(model.t("language.title"))
            WorkbenchSettingsButton(locale: locale)
            Button(model.t("document.save")) { Task { _ = await model.save() } }
                .buttonStyle(WorkbenchButtonStyle(primary: true))
                .disabled(!model.needsProtection || model.documentID.isEmpty || model.isComposing)
            Button(action: onInspector) { Image(systemName: "sidebar.right") }
                .buttonStyle(.plain).help(model.t("inspector.title")).accessibilityLabel(model.t("inspector.title"))
            Menu {
                Button(model.t("common.refresh")) { Task { await model.refresh() } }
                Button(model.t("workspace.open"), action: onOpenWorkspace)
            } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize().accessibilityLabel(model.t("shell.actions"))
        }.padding(.leading, 82).padding(.trailing, 24).frame(height: 70).background(WorkbenchPalette.surface.opacity(0.32))
    }
    private var navigation: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button(action: onLibrary) { Label(model.t("library.back"), systemImage: "chevron.left").font(.system(size: 12)) }
                .buttonStyle(.plain).foregroundStyle(WorkbenchPalette.muted).padding(.horizontal, 12).padding(.bottom, 16)
            ScrollView {
                VStack(alignment: .leading, spacing: 7) {
                    nav("book", "novel.details", "book.closed")
                    nav("novel", "novel.title", "book")
                    nav("bible", "bible.title", "square.3.layers.3d")
                    nav("drama", "drama.title", "movieclapper")
                    nav("reviews", "shell.review", "checkmark.shield")
                    nav("git", "shell.versions", "arrow.triangle.branch")
                    nav("media", "media.title", "photo.on.rectangle.angled")
                    Rectangle().fill(WorkbenchPalette.line).frame(height: 1).padding(.vertical, 12)
                    Text(model.t("shell.tools")).font(.system(size: 11)).foregroundStyle(WorkbenchPalette.muted).padding(.horizontal, 14)
                    nav("plot", "plot.title", "list.bullet.rectangle")
                    nav("validation", "validation.title", "waveform.path.ecg")
                }
            }.scrollIndicators(.hidden)
            HStack(spacing: 10) {
                BookCoverView(title: model.title, author: "", identity: model.workspaceID, compact: true).frame(width: 32, height: 48)
                VStack(alignment: .leading, spacing: 5) {
                    Text(model.title).font(.system(size: 12, weight: .medium)).lineLimit(2)
                    Text(model.t("shell.motto")).font(.system(size: 10)).foregroundStyle(WorkbenchPalette.muted).lineSpacing(3)
                }
            }.padding(10)
        }.padding(.horizontal, 10).padding(.top, 20).padding(.bottom, 12).frame(width: locale == "en" ? 190 : 170).background(WorkbenchPalette.surface.opacity(0.22))
    }
    private func nav(_ id: String, _ key: String, _ symbol: String) -> some View {
        Button { onSelect(id) } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 17, weight: .regular)).frame(width: 20)
                Text(model.t(key)).font(.system(size: 14, weight: group == id ? .semibold : .regular)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }.foregroundStyle(group == id ? WorkbenchPalette.jade : WorkbenchPalette.ink)
                .padding(.horizontal, 12).padding(.vertical, 11)
        }.buttonStyle(WorkbenchNavigationStyle(selected: group == id)).accessibilityAddTraits(group == id ? .isSelected : [])
    }
    private var chapters: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text(model.title).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                Spacer()
                Button(action: onNewDocument) { Image(systemName: "plus") }.buttonStyle(.plain).accessibilityLabel(model.t("document.new"))
            }.padding(.horizontal, 10)
            Button(action: onNewDocument) { Label(model.t("document.new"), systemImage: "plus").frame(maxWidth: .infinity) }
                .disabled(model.novel["initialized"].bool != true)
            Button(model.t("novel.manage_structure"), action: onManageStructure).buttonStyle(.plain).font(.caption).foregroundStyle(WorkbenchPalette.muted)
                .disabled(model.novel["initialized"].bool != true)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    chapterGroup(nil)
                    ForEach(Array(model.volumes.enumerated()), id: \.offset) { _, volume in
                        DisclosureGroup(volume["title"].string ?? "", isExpanded: Binding(get: { !collapsedVolumes.contains(volume["volume_id"].string ?? "") }, set: { expanded in
                            let id = volume["volume_id"].string ?? ""; if expanded { collapsedVolumes.remove(id) } else { collapsedVolumes.insert(id) }
                        })) { chapterGroup(volume["volume_id"].string) }.padding(.vertical, 5)
                    }
                    let other = model.documents.filter { $0.kind == "novel_outline" || $0.kind == "adaptation_note" }
                    if !other.isEmpty {
                        Divider().padding(.vertical, 10)
                        Text(model.t("novel.notes")).font(.caption).foregroundStyle(WorkbenchPalette.muted)
                        ForEach(other) { chapterRow($0) }
                    }
                }
            }
            Text(model.t("novel.chapter_count", ["count": String(chapterItems.count)])).font(.system(size: 11)).foregroundStyle(WorkbenchPalette.muted).padding(.horizontal, 10)
        }.padding(.horizontal, 15).padding(.top, 25).padding(.bottom, 24).frame(width: 210).background(WorkbenchPalette.surface.opacity(0.42))
    }
    @ViewBuilder private func chapterGroup(_ volume: String?) -> some View {
        ForEach(Array(model.chapters.filter { $0["volume_id"].string == volume }.enumerated()), id: \.offset) { _, chapter in
            if let item = model.documents.first(where: { $0.id == chapter["document_id"].string }) { chapterRow(item) }
        }
    }
    private func chapterRow(_ item: DocumentItem) -> some View {
        Button { onSelect(item.id) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: item.kind == "novel_outline" ? "list.bullet.indent" : "doc.text")
                Text(item.title).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
            }.font(.system(size: 12, weight: selection == item.id ? .semibold : .regular))
                .foregroundStyle(selection == item.id ? WorkbenchPalette.jade : WorkbenchPalette.ink)
                .padding(.horizontal, 9).padding(.vertical, 11)
        }.buttonStyle(WorkbenchNavigationStyle(selected: selection == item.id)).accessibilityAddTraits(selection == item.id ? .isSelected : [])
    }
}
