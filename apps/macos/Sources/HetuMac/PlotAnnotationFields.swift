import SwiftUI
import HetuCore
import HetuNative

struct PlotAssertionForm: Identifiable {
    let id = UUID()
    var subject = ""
    var predicate = "identity"
    var text = ""
    init() {}
    init(_ value: JSONValue) {
        subject = value["subject_ref"].string ?? ""
        predicate = value["predicate"].string ?? "identity"
        text = value["value"].string ?? value["value"].integer.map(String.init) ?? ""
    }
    var value: JSONValue {
        .object(["subject_ref": .string(subject), "predicate": .string(predicate), "value": predicate == "age" ? .integer(Int64(text) ?? -1) : .string(text)])
    }
}
struct PlotAnnotationForm {
    var enabled = false
    var context = "unknown"
    var facts: [PlotAssertionForm] = []
    var capabilities = ""
    init() {}
    init(_ value: JSONValue) {
        enabled = value != .null
        context = value["context"].string ?? "unknown"
        facts = value["facts"].array.map(PlotAssertionForm.init)
        capabilities = value["capabilities"].array.compactMap(\.string).joined(separator: "\n")
    }
    var value: JSONValue {
        guard enabled else { return .null }
        return .object(["context": .string(context), "facts": .array(facts.map(\.value)), "capabilities": .array(capabilities.split(separator: "\n").map { .string($0.trimmingCharacters(in: .whitespaces)) })])
    }
}
struct PlotAnnotationFields: View {
    let model: WorkspaceModel
    let blueprint: JSONValue
    @Binding var form: PlotAnnotationForm
    let entities: Set<String>
    private var characters: [EntityChoice] { entityChoices(model, .character, blueprint: blueprint).filter { entities.contains($0.id) } }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            Toggle(model.t("annotation.enabled"), isOn: $form.enabled)
            Text(model.t("annotation.note")).font(.caption).foregroundStyle(.secondary)
            if form.enabled {
                Picker(model.t("annotation.context"), selection: $form.context) {
                    ForEach(["unknown", "actual", "dream", "hypothetical", "reported"], id: \.self) { Text(model.t("annotation.context." + $0)).tag($0) }
                }
                Text(model.t("annotation.facts")).font(.headline)
                ForEach($form.facts) { $fact in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Picker(model.t("fact.subject"), selection: $fact.subject) {
                                Text(model.t("plot.unspecified")).tag("")
                                ForEach(characters) { Text($0.name).tag($0.id) }
                            }
                            Button(model.t("common.remove")) { form.facts.removeAll { $0.id == fact.id } }.buttonStyle(.borderless)
                        }
                        Picker(model.t("fact.predicate"), selection: $fact.predicate) {
                            ForEach(["identity", "primary_faction", "life_state", "age"], id: \.self) { Text(model.t("fact.predicate." + $0)).tag($0) }
                        }.onChange(of: fact.predicate) { _, _ in fact.text = "" }
                        if fact.predicate == "life_state" {
                            Picker(model.t("fact.value"), selection: $fact.text) {
                                Text(model.t("plot.unspecified")).tag("")
                                Text(model.t("fact.life.alive")).tag("alive"); Text(model.t("fact.life.dead")).tag("dead")
                            }
                        } else if fact.predicate == "primary_faction" {
                            Picker(model.t("fact.value"), selection: $fact.text) {
                                Text(model.t("plot.unspecified")).tag("")
                                ForEach(entityChoices(model, .faction, blueprint: blueprint)) { Text($0.name).tag($0.id) }
                            }
                        } else { TextField(model.t("fact.value"), text: $fact.text) }
                    }.padding(10).background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
                }
                Button(model.t("annotation.add_fact")) { var fact = PlotAssertionForm(); fact.subject = characters.first?.id ?? ""; form.facts.append(fact) }
                Text(model.t("annotation.capabilities")).font(.headline)
                TextEditor(text: $form.capabilities).frame(height: 70).border(Color.secondary.opacity(0.2)).accessibilityLabel(model.t("annotation.capabilities"))
                Text(model.t("annotation.capabilities_note")).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
