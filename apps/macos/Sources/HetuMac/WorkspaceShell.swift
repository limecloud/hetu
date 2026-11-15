import AppKit
import SwiftUI
import HetuNative
import HetuCore

struct WorkbenchButtonStyle: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var enabled
    @State private var hovered = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 14, weight: primary ? .semibold : .regular))
            .padding(.horizontal, 14).padding(.vertical, 8)
            .foregroundStyle(primary ? WorkbenchPalette.actionInk : WorkbenchPalette.ink)
            .background {
                RoundedRectangle(cornerRadius: 8).fill(primary
                    ? LinearGradient(colors: [WorkbenchPalette.actionStart, WorkbenchPalette.actionEnd], startPoint: .topLeading, endPoint: .bottomTrailing)
                    : LinearGradient(colors: [WorkbenchPalette.surface.opacity(hovered || configuration.isPressed ? 1 : 0.6)], startPoint: .top, endPoint: .bottom))
            }
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(primary ? WorkbenchPalette.actionInk.opacity(0.15) : WorkbenchPalette.line, lineWidth: 0.5))
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
    @State private var showResources = false
    @State private var showManagement = false
    @State private var showChecks = false
    @State private var showProjectNavigation = true
    @State private var showContents = true
    @State private var contentsPopover = false

    private var group: String {
        if selection.hasPrefix("draft_") { return "reviews" }
        if let document = model.documents.first(where: { $0.id == selection }) { return document.kind == "drama_script" ? "drama" : "novel" }
        return selection
    }
    private var chapterItems: [DocumentItem] { model.orderedChapters }
    var body: some View {
        GeometryReader { geometry in
        let canPinContents = WorkspaceNavigation.canPinContents(width: geometry.size.width, locale: locale, projectNavigation: showProjectNavigation)
        VStack(spacing: 0) {
            topbar(canPinContents: canPinContents)
            Rectangle().fill(WorkbenchPalette.line).frame(height: 0.5)
            HStack(spacing: 0) {
                if showProjectNavigation {
                    navigation
                    Rectangle().fill(WorkbenchPalette.line).frame(width: 0.5)
                }
                if group == "novel" && canPinContents && showContents {
                    chapters
                    Rectangle().fill(WorkbenchPalette.line).frame(width: 0.5)
                }
                content().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .font(.system(size: 14)).foregroundStyle(WorkbenchPalette.ink)
        .background { WorkbenchBackdrop().ignoresSafeArea() }.tint(WorkbenchPalette.jade)
        .buttonStyle(WorkbenchButtonStyle())
        .task(id: model.workspaceID) { await model.monitorWriteAccess() }
        .onChange(of: group, initial: true) { _, page in
            switch WorkspaceNavigation.group(for: page) {
            case .resources: showResources = true
            case .management: showManagement = true
            case .checks: showChecks = true
            case nil: break
            }
        }
        .onChange(of: selection) { _, id in
            contentsPopover = false
            if let chapter = model.chapters.first(where: { $0["document_id"].string == id }), let volume = chapter["volume_id"].string {
                collapsedVolumes.remove(volume)
            }
        }
        }
    }
    private func topbar(canPinContents: Bool) -> some View {
        HStack(spacing: 14) {
            Button { showProjectNavigation.toggle() } label: { Image(systemName: "sidebar.left") }
                .buttonStyle(.plain).help(model.t("shell.project_navigation")).accessibilityLabel(model.t("shell.project_navigation"))
                .accessibilityValue(model.t(showProjectNavigation ? "shell.navigation.shown" : "shell.navigation.hidden"))
            Menu {
                Button(model.t("library.back"), action: onLibrary)
                Divider()
                Button(model.t("workspace.open"), action: onOpenWorkspace)
                Button(model.t("workspace.new"), action: onNewWorkspace)
            } label: {
                HStack(spacing: 7) {
                    Text(model.title).lineLimit(1)
                    Text(model.t("creation.type." + model.workType)).foregroundStyle(WorkbenchPalette.muted)
                }.font(.system(size: 14))
            }.menuStyle(.borderlessButton).frame(maxWidth: 340, alignment: .leading).accessibilityLabel(model.t("shell.switch_workspace"))
            if group == "novel" {
                Button {
                    if canPinContents { showContents.toggle() } else { contentsPopover.toggle() }
                } label: { Image(systemName: "list.bullet.indent") }
                    .buttonStyle(.plain).help(model.t("shell.contents")).accessibilityLabel(model.t("shell.contents"))
                    .accessibilityValue(model.t((canPinContents ? showContents : contentsPopover) ? "shell.navigation.shown" : "shell.navigation.hidden"))
                    .popover(isPresented: $contentsPopover, arrowEdge: .bottom) { chapters.frame(height: 520) }
            }
            Spacer(minLength: 12)
            if !model.documentID.isEmpty || selection == "novel" {
                PageAgentButton(model: model, page: handoffPage, object: handoffObject)
            }
            if model.writeLocked {
                Label(model.t("workspace.read_only"), systemImage: "lock")
                    .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            }
            if !model.documentID.isEmpty {
                Label(model.t(model.pendingSave != nil ? "document.pending" : model.dirty ? "document.modified" : "document.saved"), systemImage: model.dirty ? "pencil.line" : "checkmark.circle")
                    .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).lineLimit(1)
            }
            if model.busy { ProgressView().controlSize(.small).accessibilityLabel(model.t("common.working")) }
            WorkbenchSettingsButton(locale: locale)
            WorkspaceZoomButton(localizer: model.localizer)
            if !model.documentID.isEmpty {
                Button(model.t("document.save")) { Task { _ = await model.save() } }
                    .buttonStyle(WorkbenchButtonStyle(primary: true))
                    .disabled(model.writeLocked || !model.needsProtection || model.isComposing)
                Button(action: onInspector) { Image(systemName: "sidebar.right") }
                    .buttonStyle(.plain).help(model.t("inspector.title")).accessibilityLabel(model.t("inspector.title"))
            }
            Menu {
                Button(locale == "en" ? "中文" : "English") { locale = locale == "en" ? "zh-CN" : "en" }
                Button(model.t("common.refresh")) { Task { await model.refresh() } }
                Button(model.t("workspace.open"), action: onOpenWorkspace)
            } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize().accessibilityLabel(model.t("shell.actions"))
        }.padding(.horizontal, 20).frame(height: 56).background(WorkbenchPalette.surface.opacity(0.32))
    }
    private var handoffPage: String {
        if selection == model.documentID && !model.documentID.isEmpty { return "document" }
        return ["book", "novel", "bible", "drama", "video", "related_works", "reviews", "git", "media", "delivery", "plot", "validation"].contains(group) ? group : "book"
    }
    private var handoffObject: JSONValue {
        guard selection == model.documentID, !model.documentID.isEmpty else { return .object([:]) }
        return .object(["document_id": .string(model.documentID), "revision_id": .string(model.baseRevisionID)])
    }
    private var navigation: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button(action: onLibrary) { Label(model.t("library.back"), systemImage: "chevron.left").font(.system(size: 12)) }
                .buttonStyle(.plain).foregroundStyle(WorkbenchPalette.muted).padding(.horizontal, 12).padding(.bottom, 16)
            ScrollView {
                VStack(alignment: .leading, spacing: 7) {
                    if model.workType == "novel" {
                        nav("book", "novel.details", "book.closed")
                        nav("novel", "novel.title", "book")
                    }
                    if model.workType == "drama" { nav("drama", "drama.title", "doc.text") }
                    if model.workType == "video" { nav("video", "video.title", "film") }
                    nav("reviews", "shell.review", "checkmark.shield")
                    nav("related_works", "works.related", "link")
                    Rectangle().fill(WorkbenchPalette.line).frame(height: 0.5).padding(.vertical, 12)
                    DisclosureGroup(model.t("shell.group.resources"), isExpanded: $showResources) {
                        nav("bible", "bible.title", "square.3.layers.3d")
                        nav("media", "media.title", "photo.on.rectangle.angled")
                    }.font(.system(size: 12)).padding(.horizontal, 8)
                    DisclosureGroup(model.t("shell.group.management"), isExpanded: $showManagement) {
                        nav("git", "shell.versions", "arrow.triangle.branch")
                        nav("delivery", "delivery.title", "square.and.arrow.up")
                    }.font(.system(size: 12)).padding(.horizontal, 8)
                    DisclosureGroup(model.t("shell.group.checks"), isExpanded: $showChecks) {
                        nav("plot", "plot.title", "list.bullet.rectangle")
                        nav("validation", "validation.title", "waveform.path.ecg")
                    }.font(.system(size: 12)).padding(.horizontal, 8)
                }
            }.scrollIndicators(.hidden)
            HStack(spacing: 10) {
                if model.workType == "novel" {
                    BookCoverView(title: model.title, author: "", identity: model.currentWorkID, compact: true).frame(width: 32, height: 48)
                } else {
                    Image(systemName: model.workType == "video" ? "film" : "doc.text").font(.system(size: 20)).foregroundStyle(WorkbenchPalette.muted).frame(width: 32, height: 48)
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text(model.title).font(.system(size: 12, weight: .medium)).lineLimit(2)
                    Text(model.t("creation.type." + model.workType)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                }
            }.padding(10)
        }.padding(.horizontal, 10).padding(.top, 20).padding(.bottom, 12).frame(width: locale == "en" ? 190 : 170).background(WorkbenchPalette.surface.opacity(0.22))
    }
    private func nav(_ id: String, _ key: String, _ symbol: String) -> some View {
        Button { onSelect(id) } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 14, weight: .regular)).frame(width: 20)
                Text(model.t(key)).font(.system(size: 14, weight: group == id ? .semibold : .regular)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }.foregroundStyle(group == id ? WorkbenchPalette.jade : WorkbenchPalette.ink)
                .padding(.horizontal, 12).padding(.vertical, 11)
        }.buttonStyle(WorkbenchNavigationStyle(selected: group == id)).accessibilityAddTraits(group == id ? .isSelected : [])
    }
    private var chapters: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text(model.t("shell.contents")).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                Spacer()
                Menu {
                    Button(model.t("document.new"), action: onNewDocument)
                    Button(model.t("novel.manage_structure"), action: onManageStructure)
                } label: { Image(systemName: "ellipsis") }
                    .menuStyle(.borderlessButton).fixedSize().accessibilityLabel(model.t("shell.actions"))
                    .disabled(model.novel["initialized"].bool != true)
            }.padding(.horizontal, 10)
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
                        Text(model.t("novel.notes")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                        ForEach(other) { chapterRow($0) }
                    }
                }
            }
            Text(model.t("novel.chapter_count", ["count": String(chapterItems.count)])).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).padding(.horizontal, 10)
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
