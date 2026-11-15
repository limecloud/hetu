import SwiftUI
import HetuCore
import HetuNative

struct VideoWorkbenchView: View {
    let model: WorkspaceModel
    @Binding var selected: String
    @State private var result: JSONValue = .null
    @State private var error: String?
    @State private var loading = false
    @State private var showDirectory = true
    @State private var directoryPopover = false
    private var episode: JSONValue { result["episodes"].array.first { $0["episode"]["video_episode_id"].string == selected } ?? .null }
    var body: some View {
        GeometryReader { geometry in
        let pinDirectory = WorkspaceNavigation.canPinDirectory(width: geometry.size.width, directoryWidth: 260.5, occupiedWidth: 88)
        VStack(alignment: .leading, spacing: 16) {
            WorkbenchHeading(title: model.title, artwork: "") {
                Button {
                    if pinDirectory { showDirectory.toggle() } else { directoryPopover.toggle() }
                } label: { Image(systemName: "list.bullet.indent") }
                    .help(model.t("drama.episode_select")).accessibilityLabel(model.t("drama.episode_select"))
                    .accessibilityValue(model.t((pinDirectory ? showDirectory : directoryPopover) ? "shell.navigation.shown" : "shell.navigation.hidden"))
                    .popover(isPresented: $directoryPopover) { episodeDirectory.frame(width: 260, height: 520) }
                PageAgentButton(model: model, page: "video")
                Button(model.t("common.refresh")) { Task { await load() } }.disabled(loading)
            }
            if let error { Text(error).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if loading && result == .null { ProgressView() }
            else if result["episodes"].array.isEmpty {
                VStack(alignment: .leading, spacing: 16) {
                    Text(model.t("video.no_episodes")).font(.system(size: 20, weight: .semibold))
                    if let brief = result["project"]["brief"].string, !brief.isEmpty {
                        Text(brief).font(.system(size: 14)).textSelection(.enabled)
                    }
                    PageAgentButton(model: model, page: "video", intent: model.t("video.start_intent"))
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            } else {
                HSplitView {
                    if pinDirectory && showDirectory { episodeDirectory.frame(minWidth: 160, idealWidth: 200, maxWidth: 260) }
                    VStack(alignment: .leading, spacing: 16) {
                        Text(episode["episode"]["title"].string ?? "").font(.system(size: 20, weight: .semibold))
                        Text(episode["episode"]["brief"].string ?? "").font(.system(size: 14)).textSelection(.enabled)
                        Text(model.t("video.no_media")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
                        PageAgentButton(model: model, page: "video", object: .object(["video_episode_id": .string(selected)]), intent: model.t("video.continue_intent", ["title": episode["episode"]["title"].string ?? ""]))
                        Spacer()
                        ObjectTimestampsView(localizer: model.localizer, record: episode["episode"])
                    }.padding(20).frame(minWidth: pinDirectory && showDirectory ? 720 : 0, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
        }.padding(24).workbenchPage().task(id: model.currentWorkID) { await load() }
        }
    }
    private var episodeDirectory: some View {
        List { ForEach(Array(result["episodes"].array.enumerated()), id: \.offset) { _, value in
            Button {
                selected = value["episode"]["video_episode_id"].string ?? ""
                directoryPopover = false
            } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Text(model.t("drama.episode", ["number": String(value["episode_number"].integer ?? 0)]))
                        .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                    Text(value["episode"]["title"].string ?? "").font(.system(size: 14))
                }.fontWeight(selected == value["episode"]["video_episode_id"].string ? .semibold : .regular).padding(.vertical, 4)
            }.buttonStyle(.plain).accessibilityAddTraits(selected == value["episode"]["video_episode_id"].string ? .isSelected : [])
        } }.scrollContentBackground(.hidden)
    }
    private func load() async {
        guard !loading, let reference = model.workReference, reference.kind == "video", let workspace = model.workspace else { return }
        loading = true; error = nil; defer { loading = false }
        do {
            let next = try await workspace.data("hetu.video.projects.get", input: ["video_project_id": .string(reference.objectID)])
            guard model.workReference == reference, next["work_ref"] == reference.value else { throw CoreError.invalidResponse }
            result = next
            if !next["episodes"].array.contains(where: { $0["episode"]["video_episode_id"].string == selected }) {
                selected = next["episodes"].array.first?["episode"]["video_episode_id"].string ?? ""
            }
        } catch { self.error = model.localizer.error(error) }
    }
}
