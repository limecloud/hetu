import SwiftUI
import HetuCore
import HetuNative

struct RecordConflictView: View {
    let model: WorkspaceModel
    let action: String
    let input: [String: JSONValue]
    let object: String
    @Binding var baseline: JSONValue
    @State private var current: JSONValue = .null
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PageAgentButton(model: model, page: object == "resource" ? "resource" : object == "episode" ? "episode" : "drama", object: .object(input))
            Button(model.t("records.compare_latest")) { Task {
                current = await model.workspaceAction(action, input: input, onFailure: { error = $0; _ = $1 }) ?? .null
            } }.disabled(model.busy)
            if let error { Text(error).foregroundStyle(WorkbenchPalette.danger) }
            if current != .null {
                Text(model.t("records.disk_version")).font(.system(size: 14, weight: .semibold))
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(["title", "description", "plan", "body", "source_notes"], id: \.self) { field in
                            if let value = current[object][field].string, !value.isEmpty { Text(value).textSelection(.enabled) }
                        }
                        if object == "resource" {
                            Text(model.t("resources.category." + (current[object]["category"].string ?? "research")))
                            if !current[object]["tags"].array.isEmpty { Text(current[object]["tags"].array.compactMap(\.string).joined(separator: "、")) }
                            ResourceLinksView(model: model, resource: current[object])
                                .id((current[object]["resource_id"].string ?? "") + ":" + String(current[object]["revision"].integer ?? 0))
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 160)
                Button(model.t("records.accept_baseline")) { baseline = current; current = .null }
                Text(model.t("records.keep_input")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            }
        }
    }
}
