import SwiftUI
import HetuCore
import HetuNative

struct TaskContextView: View {
    let taskRef: JSONValue
    let locale: String
    let held: Bool
    let read: (String, [String: JSONValue]) async -> JSONValue?
    @State private var directory: JSONValue = .null
    @State private var preview: JSONValue = .null
    @State private var selected: JSONValue = .null
    @State private var busy = false
    private var localizer: Localizer { Localizer(locale: locale) }

    var body: some View {
        Group {
            if !directory["entries"].array.isEmpty {
                DisclosureGroup(localizer.text("creative.context.title")) {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(directory["entries"].array.enumerated()), id: \.offset) { _, entry in
                            Button(entry["title"].string.flatMap { $0.isEmpty ? nil : $0 } ?? localizer.text("bible.title")) {
                                Task { await load(entry["context_ref"]) }
                            }.buttonStyle(.link).disabled(held || busy)
                        }
                        if directory["next_cursor"].string != nil {
                            Button(localizer.text("creative.more")) { Task { await list(more: true) } }.disabled(held || busy)
                        }
                        if let content = preview["content"].string {
                            Text(content).font(.system(size: 14)).textSelection(.enabled)
                        }
                        ForEach(Array(preview["sections"].array.enumerated()), id: \.offset) { _, section in
                            Button(sectionTitle(section["section"].string ?? "")) {
                                Task { await load(selected, section: section["section"]) }
                            }.buttonStyle(.link).disabled(held || busy)
                        }
                        ForEach(Array(preview["entities"].array.enumerated()), id: \.offset) { _, entity in
                            Button(entity["title"].string ?? "") {
                                Task { await load(selected, section: preview["section"], entity: entity["entity_id"]) }
                            }.buttonStyle(.link).disabled(held || busy)
                        }
                        ForEach(Array(displayRecords.enumerated()), id: \.offset) { _, record in
                            if let name = record["name"].string ?? record["title"].string { Text(name).font(.system(size: 14, weight: .semibold)) }
                            ForEach(["description", "summary", "identity", "notes", "content", "rationale"], id: \.self) { field in
                                if let content = record[field].string { Text(content).font(.system(size: 14)).textSelection(.enabled) }
                            }
                        }
                        if preview["next_range"].object["byte_start"] != nil {
                            Button(localizer.text("creative.context.next")) { Task { await load(selected, range: preview["next_range"]) } }.disabled(held || busy)
                        }
                        if preview["next_cursor"].string != nil {
                            Button(localizer.text("creative.more")) { Task { await load(selected, section: preview["section"], cursor: preview["next_cursor"]) } }.disabled(held || busy)
                        }
                    }.padding(.top, 8)
                }
            }
        }.task(id: taskRef) { await list() }
    }
    private var displayRecords: [JSONValue] {
        if preview["entity"] != .null { return [preview["entity"]] }
        return preview["blueprint"].object.values.flatMap(\.array)
    }
    private func sectionTitle(_ section: String) -> String {
        let kind = BibleKind.allCases.first { $0.section == section }
        return localizer.text(kind.map { "entity.kind." + $0.rawValue } ?? "bible.title")
    }
    private func list(more: Bool = false) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        var input: [String: JSONValue] = ["task_ref": taskRef, "limit": .integer(20)]
        if more { input["cursor"] = directory["next_cursor"] }
        if var result = await read("hetu.task_context.list", input) {
            if more {
                var fields = result.object
                fields["entries"] = .array(directory["entries"].array + result["entries"].array)
                result = .object(fields)
            }
            directory = result
        }
    }
    private func load(_ reference: JSONValue, range: JSONValue = .null, section: JSONValue = .null, entity: JSONValue = .null, cursor: JSONValue = .null) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        var input: [String: JSONValue] = ["task_ref": taskRef, "context_ref": reference]
        if range != .null { input["range"] = range }
        if section != .null { input["section"] = section }
        if entity != .null { input["entity_id"] = entity }
        if cursor != .null { input["cursor"] = cursor }
        if let result = await read("hetu.task_context.read", input) { selected = reference; preview = result }
    }
}
