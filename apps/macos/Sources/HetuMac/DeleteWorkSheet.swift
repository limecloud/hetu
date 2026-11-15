import SwiftUI
import HetuNative

struct DeleteWorkSheet: View {
    let model: WorkspaceModel
    let entry: LibraryEntry
    @Environment(\.dismiss) private var dismiss
    @State private var confirmation = ""
    @State private var deleting = false
    @State private var error: String?
    @State private var scopeLoaded = false
    @State private var sharedDirectory = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(model.t(sharedDirectory ? "library.archive_title" : "library.delete.title")).font(.system(size: 20, weight: .semibold))
            VStack(alignment: .leading, spacing: 10) {
                Text(entry.title).font(.system(size: 14, weight: .semibold)).textSelection(.enabled)
                Text(entry.path).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                Text(model.t(sharedDirectory ? "library.archive_scope" : "library.delete.scope")).font(.system(size: 14)).fixedSize(horizontal: false, vertical: true)
            }
            if !scopeLoaded && error == nil { ProgressView().controlSize(.small) }
            VStack(alignment: .leading, spacing: 8) {
                Text(model.t("library.delete.confirm")).font(.system(size: 14))
                TextField(entry.title, text: $confirmation).textFieldStyle(.roundedBorder)
                    .font(.system(size: 14)).focused($focused).accessibilityLabel(model.t("library.delete.confirm"))
                    .accessibilityIdentifier("library.delete.confirmation")
            }
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.danger).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("library.delete.error") }
            HStack {
                Spacer()
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(model.t(sharedDirectory ? "library.archive_action" : "library.delete.action"), role: .destructive) {
                    deleting = true; error = nil
                    Task {
                        do {
                            if sharedDirectory { try await model.archiveLibraryEntry(entry, confirmingTitle: confirmation) }
                            else { try await model.trashLibraryEntry(entry, confirmingTitle: confirmation) }
                            dismiss()
                        }
                        catch { self.error = model.localizer.error(error); deleting = false }
                    }
                }.foregroundStyle(WorkbenchPalette.danger).disabled(!scopeLoaded || confirmation != entry.title || entry.title.isEmpty || deleting)
                    .accessibilityIdentifier("library.delete.submit")
            }
        }.padding(28).frame(width: 500).foregroundStyle(WorkbenchPalette.ink)
            .background(WorkbenchPalette.surface).buttonStyle(WorkbenchButtonStyle())
            .disabled(deleting).interactiveDismissDisabled(deleting)
            .onAppear { focused = true }
            .task {
                do { sharedDirectory = try await model.libraryDeletionScope(entry).count > 1; scopeLoaded = true }
                catch { self.error = model.localizer.error(error) }
            }
    }
}
