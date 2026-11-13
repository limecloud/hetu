import SwiftUI
import HetuCore
import HetuNative

enum BibleKind: String, CaseIterable, Identifiable {
    case character, faction, location, event, world, rule
    var id: String { rawValue }
    var section: String {
        switch self { case .character: "characters"; case .faction: "factions"; case .location: "locations"; case .event: "timeline"; case .world: "world"; case .rule: "rules" }
    }
    var idKey: String { self == .world ? "entry_id" : rawValue + "_id" }
    var prefix: String { self == .world ? "entry" : rawValue }
    var titleKey: String { self == .rule ? "rationale" : [.character, .faction, .location].contains(self) ? "name" : "title" }
    var hasArchive: Bool { [.character, .faction, .location].contains(self) }
}

struct EntityChoice: Identifiable {
    let id: String
    let name: String
}
@MainActor func entityTitle(_ model: WorkspaceModel, _ kind: BibleKind, _ entity: JSONValue) -> String {
    if let title = entity[kind.titleKey].string, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return title }
    return model.t(kind == .rule ? "rule.type." + (entity["type"].string ?? "advisory") : "entity.unnamed")
}
@MainActor func entityChoices(_ model: WorkspaceModel, _ kind: BibleKind, excluding: String = "", blueprint: JSONValue? = nil) -> [EntityChoice] {
    (blueprint ?? model.bible["blueprint"])[kind.section].array.filter { $0[kind.idKey].string != excluding }.map { item in
        let suffix = item["archived"].bool == true ? model.t("entity.archived_suffix") : ""
        return EntityChoice(id: item[kind.idKey].string ?? "", name: entityTitle(model, kind, item) + suffix)
    }
}
@MainActor func displayName(_ model: WorkspaceModel, reference: String, blueprint: JSONValue? = nil) -> String {
    for kind in BibleKind.allCases {
        if let found = entityChoices(model, kind, blueprint: blueprint).first(where: { $0.id == reference }) { return found.name }
    }
    return model.t("entity.unavailable")
}

struct StoryBibleView: View {
    let model: WorkspaceModel
    @State private var kind = BibleKind.character
    @State private var editing = false
    @State private var selected: JSONValue = .null
    @State private var showArchived = false
    @State private var confirmLock = false
    @State private var reason = ""
    @State private var lockError: String?
    @State private var removal: JSONValue = .null
    @State private var history = false
    private var items: [JSONValue] { model.bible["blueprint"][kind.section].array.filter { showArchived || $0["archived"].bool != true } }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            WorkbenchHeading(title: model.t("bible.title"), subtitle: model.t("bible.description"), artwork: items.isEmpty ? "" : "story-world") {
                Button(model.t("bible.history")) { history = true }
                Button(model.t(model.locked ? "bible.unlock" : "bible.lock")) { lockError = nil; confirmLock = true }
                Button { selected = .null; editing = true } label: { Label(model.t("entity.add"), systemImage: "plus") }
                    .buttonStyle(WorkbenchButtonStyle(primary: true)).disabled(model.locked)
            }
            HStack {
                Label(model.t(model.locked ? "bible.locked" : "bible.editable"), systemImage: model.locked ? "lock" : "lock.open")
                    .font(.system(size: 11)).foregroundStyle(WorkbenchPalette.jade).padding(.horizontal, 10).padding(.vertical, 5)
                    .background(WorkbenchPalette.jadeSoft, in: RoundedRectangle(cornerRadius: 4))
                Spacer()
                if kind.hasArchive { Toggle(model.t("entity.show_archived"), isOn: $showArchived).toggleStyle(.checkbox).font(.caption) }
            }
            Picker(model.t("entity.category"), selection: $kind) {
                ForEach(BibleKind.allCases) { kind in Text(model.t("entity.kind." + kind.rawValue)).tag(kind) }
            }.pickerStyle(.segmented).labelsHidden()
            if items.isEmpty {
                WorkbenchEmptyState(title: model.t("entity.empty"), detail: model.t("entity.empty_detail"), artwork: "story-world")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            entityRow(item)
                            Divider()
                        }
                    }
                }
            }
        }.padding(28).workbenchPage()
        .sheet(isPresented: $editing) { EntityEditor(model: model, kind: kind, entity: selected) }
        .sheet(isPresented: $history) { BibleHistoryView(model: model) }
        .sheet(isPresented: $confirmLock) { lockSheet }
        .alert(model.t("entity.remove_title"), isPresented: Binding(get: { removal != .null }, set: { if !$0 { removal = .null } })) {
            Button(model.t("common.cancel"), role: .cancel) { removal = .null }
            Button(model.t("entity.remove"), role: .destructive) {
                let reference = removal[kind.idKey]; removal = .null
                Task { _ = await model.saveBibleChanges([.object(["type": .string("remove_entity"), "entity_ref": reference])]) }
            }
        } message: { Text(model.t("entity.remove_detail", ["name": entityTitle(model, kind, removal)])) }
    }
    private func entityRow(_ item: JSONValue) -> some View {
        HStack(alignment: .center, spacing: 22) {
            Text(String(entityTitle(model, kind, item).prefix(1)))
                .font(.custom("Songti SC", size: 21)).foregroundStyle(WorkbenchPalette.jade)
                .frame(width: 42, height: 42).background(WorkbenchPalette.jadeSoft, in: Circle()).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(entityTitle(model, kind, item)).font(.system(size: 15, weight: .semibold))
                Text(model.t("entity.kind." + kind.rawValue)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                if kind == .event, item["time_anchor"] != .null { Text(model.t("timeline.anchor_summary", ["calendar": item["time_anchor"]["calendar"].string ?? "", "tick": String(item["time_anchor"]["tick"].integer ?? 0)])).font(.caption).foregroundStyle(.secondary) }
                if kind == .rule, !(item["rationale"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { Text(model.t("rule.type." + (item["type"].string ?? "advisory"))).font(.caption).foregroundStyle(.secondary) }
                if kind == .character { Text(model.t("fact.count", ["count": String(item["facts"].array.count)])).font(.caption).foregroundStyle(.secondary) }
                if item["archived"].bool == true { Text(model.t("entity.archived")).font(.caption).foregroundStyle(.secondary) }
            }.frame(minWidth: 140, idealWidth: 180, maxWidth: 240, alignment: .leading)
            if let description = item["description"].string, !description.isEmpty {
                Text(description).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
            } else { Spacer(minLength: 0) }
            Button(model.t("common.edit")) { selected = item; editing = true }.buttonStyle(.borderless).disabled(model.locked)
            Menu {
                if kind.hasArchive {
                    Button(model.t(item["archived"].bool == true ? "entity.unarchive" : "entity.archive")) {
                        var value = item.object; value["archived"] = .bool(item["archived"].bool != true)
                        Task { _ = await model.saveBibleChanges([.object(["type": .string("upsert_" + kind.rawValue), "entity": .object(value)])]) }
                    }
                }
                Button(model.t("entity.remove"), role: .destructive) {
                    Task {
                        let change: JSONValue = .object(["type": .string("remove_entity"), "entity_ref": item[kind.idKey]])
                        if await model.previewBibleChanges([change]) != nil { removal = item }
                    }
                }
            } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize().accessibilityLabel(model.t("entity.actions")).disabled(model.locked)
        }.padding(.vertical, 20).accessibilityElement(children: .contain)
    }
    private var lockSheet: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(model.t(model.locked ? "bible.unlock" : "bible.lock")).font(.title2)
            Text(model.t("bible.lock_detail")).foregroundStyle(.secondary)
            TextField(model.t("bible.reason"), text: $reason)
            if let lockError { Text(lockError).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button(model.t("common.cancel")) { confirmLock = false }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t("common.confirm")) {
                    Task {
                        lockError = nil
                        if await model.setLocked(!model.locked, reason: reason, onFailure: { lockError = $0 }) { confirmLock = false; reason = "" }
                    }
                }.disabled(model.busy || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 470)
    }
}

struct MultipleReferences: View {
    let title: String
    let choices: [EntityChoice]
    @Binding var selected: Set<String>
    let model: WorkspaceModel
    @State private var query = ""
    private var visible: [EntityChoice] { query.isEmpty ? choices : choices.filter { $0.name.localizedStandardContains(query) } }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
            if choices.isEmpty { Text(model.t("reference.none")).foregroundStyle(.secondary) }
            else {
                if choices.count > 8 { TextField(model.t("reference.filter"), text: $query) }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(visible) { choice in
                            Toggle(choice.name, isOn: Binding(get: { selected.contains(choice.id) }, set: { if $0 { selected.insert(choice.id) } else { selected.remove(choice.id) } })).toggleStyle(.checkbox)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.frame(height: CGFloat(min(max(visible.count, 1), 5) * 25))
            }
            Text(choices.filter { selected.contains($0.id) }.map(\.name).joined(separator: model.locale == "en" ? ", " : "、")).foregroundStyle(.secondary).font(.callout)
        }
    }
}

struct FactionRelation: Identifiable { let id = UUID(); var target: String; var type: String }
struct EntityEditor: View {
    let model: WorkspaceModel
    let kind: BibleKind
    let entity: JSONValue
    @Environment(\.dismiss) private var dismiss
    @State private var reference: String
    @State private var name = ""
    @State private var description = ""
    @State private var aliases = ""
    @State private var traits = ""
    @State private var archived = false
    @State private var parent = ""
    @State private var interior = "unknown"
    @State private var facts: [JSONValue] = []
    @State private var relations: [FactionRelation] = []
    @State private var hasAnchor = false
    @State private var calendar = ""
    @State private var tick = ""
    @State private var before: Set<String> = []
    @State private var after: Set<String> = []
    @State private var ruleType = "advisory"
    @State private var severity = "warning"
    @State private var exceptionPolicy = "author_review"
    @State private var packages: Set<String> = ["novel", "drama"]
    @State private var documents: Set<String> = []
    @State private var entities: Set<String> = []
    @State private var referenceTypes: Set<String> = ["character", "location", "faction"]
    @State private var predicates: Set<String> = ["identity", "primary_faction", "life_state", "age"]
    @State private var ruleBefore = ""
    @State private var ruleAfter = ""
    @State private var terms = ""
    @State private var exceptions = ""
    @State private var caseSensitive = true
    @State private var capability = ""
    @State private var ruleLocation = ""
    @State private var advisory = ""
    @State private var editingFact = false
    @State private var selectedFact: JSONValue = .null
    @State private var didLoad = false
    @State private var saveError: String?
    init(model: WorkspaceModel, kind: BibleKind, entity: JSONValue) {
        self.model = model; self.kind = kind; self.entity = entity
        _reference = State(initialValue: entity[kind.idKey].string ?? kind.prefix + "_" + UUID().uuidString.lowercased())
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.t(entity == .null ? "entity.new_title" : "entity.edit_title", ["kind": model.t("entity.kind." + kind.rawValue)])).font(.title2)
            ScrollView {
                Form {
                    if kind != .rule { TextField(model.t("entity.name"), text: $name) }
                    if [.character, .faction, .location, .world].contains(kind) { TextField(model.t("entity.description"), text: $description, axis: .vertical).lineLimit(3...8) }
                    if [.character, .location].contains(kind) { TextField(model.t("character.aliases"), text: $aliases, axis: .vertical).lineLimit(2...5) }
                    if kind == .character { characterFields }
                    if kind == .faction { factionFields }
                    if kind == .location { locationFields }
                    if kind == .event { timelineFields }
                    if kind == .rule { ruleFields }
                    if kind.hasArchive { Toggle(model.t("entity.archived"), isOn: $archived) }
                    SourceEvidenceView(model: model, sources: entity["source_refs"].array)
                }.formStyle(.grouped)
            }
            if let saveError { Text(saveError).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t("common.save")) {
                    Task {
                        saveError = nil
                        if await model.saveBibleChanges([.object(["type": .string("upsert_" + kind.rawValue), "entity": value])], onFailure: { saveError = $0 }) { dismiss() }
                    }
                }
                    .keyboardShortcut(.defaultAction).disabled(model.busy || !valid)
            }
        }.padding(24).frame(width: 660, height: 650)
        .onAppear(perform: load)
        .sheet(isPresented: $editingFact) {
            FactEditor(model: model, subject: reference, fact: selectedFact) { fact in
                if let index = facts.firstIndex(where: { $0["fact_id"] == fact["fact_id"] }) { facts[index] = fact } else { facts.append(fact) }
            }
        }
    }
    private var characterFields: some View {
        Section(model.t("fact.title")) {
            TextField(model.t("character.traits"), text: $traits, axis: .vertical).lineLimit(2...5)
            ForEach(Array(facts.enumerated()), id: \.offset) { index, fact in
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(factDescription(model, fact))
                        Text(model.t("fact.valid_from") + ": " + displayName(model, reference: fact["valid_from"].string ?? "")).font(.caption).foregroundStyle(.secondary)
                        Text(model.t("fact.valid_to") + ": " + (fact["valid_to"].string.map { displayName(model, reference: $0) } ?? model.t("fact.open_end"))).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(model.t("common.edit")) { selectedFact = fact; editingFact = true }
                    Button(role: .destructive) { facts.remove(at: index) } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless).accessibilityLabel(model.t("fact.remove"))
                }
            }
            Button(model.t("fact.add")) { selectedFact = .null; editingFact = true }.disabled(entityChoices(model, .event).isEmpty)
            if entityChoices(model, .event).isEmpty { Text(model.t("fact.needs_event")).font(.callout).foregroundStyle(.secondary) }
        }
    }
    private var factionFields: some View {
        Section(model.t("faction.relations")) {
            ForEach($relations) { $relation in
                HStack {
                    Picker(model.t("faction.target"), selection: $relation.target) { ForEach(entityChoices(model, .faction, excluding: reference)) { Text($0.name).tag($0.id) } }
                    Picker(model.t("faction.relation_type"), selection: $relation.type) { ForEach(["ally", "enemy", "neutral", "subordinate"], id: \.self) { Text(model.t("faction.relation." + $0)).tag($0) } }
                    Button(role: .destructive) { relations.removeAll { $0.id == relation.id } } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless).accessibilityLabel(model.t("reference.remove"))
                }
            }
            Button(model.t("faction.add_relation")) {
                if let target = entityChoices(model, .faction, excluding: reference).first { relations.append(FactionRelation(target: target.id, type: "neutral")) }
            }.disabled(entityChoices(model, .faction, excluding: reference).isEmpty)
        }
    }
    private var locationFields: some View {
        Section(model.t("entity.kind.location")) {
            referencePicker(model.t("location.parent"), selection: $parent, kind: .location, optional: true)
            Picker(model.t("location.interior_exterior"), selection: $interior) {
                ForEach(["interior", "exterior", "mixed", "unknown"], id: \.self) { Text(model.t("location." + $0)).tag($0) }
            }
        }
    }
    private var timelineFields: some View {
        Section(model.t("timeline.order")) {
            Text(model.t("timeline.order_detail")).font(.callout).foregroundStyle(.secondary)
            MultipleReferences(title: model.t("timeline.before"), choices: entityChoices(model, .event, excluding: reference), selected: $before, model: model)
            MultipleReferences(title: model.t("timeline.after"), choices: entityChoices(model, .event, excluding: reference), selected: $after, model: model)
            Toggle(model.t("timeline.has_anchor"), isOn: $hasAnchor)
            if hasAnchor {
                TextField(model.t("timeline.calendar"), text: $calendar)
                TextField(model.t("timeline.tick"), text: $tick)
                Text(model.t("timeline.tick_detail")).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    @ViewBuilder private var ruleFields: some View {
        Section(model.t("entity.kind.rule")) {
            Picker(model.t("rule.type"), selection: $ruleType) { ForEach(["required_reference", "fact_equals", "event_precedes", "forbidden_term", "world_constraint", "advisory"], id: \.self) { Text(model.t("rule.type." + $0)).tag($0) } }
            Picker(model.t("rule.severity"), selection: $severity) { ForEach(["error", "warning", "info"], id: \.self) { Text(model.t("rule.severity." + $0)).tag($0) } }
            TextField(model.t("rule.rationale"), text: $description, axis: .vertical).lineLimit(2...5)
            Picker(model.t("rule.exception"), selection: $exceptionPolicy) { ForEach(["author_review", "none"], id: \.self) { Text(model.t("rule.exception." + $0)).tag($0) } }
            ruleParameterFields
        }
        Section(model.t("rule.scope")) {
            Text(model.t("rule.scope_detail")).font(.caption).foregroundStyle(.secondary)
            HStack {
                ForEach(["novel", "drama", "music-cue", "visual-prompt"], id: \.self) { package in Toggle(model.t("package." + package), isOn: membership(package, in: $packages)) }
            }
            MultipleReferences(title: model.t("rule.documents"), choices: model.documents.map { EntityChoice(id: $0.id, name: $0.title) }, selected: $documents, model: model)
            MultipleReferences(title: model.t("rule.entities"), choices: BibleKind.allCases.flatMap { entityChoices(model, $0, excluding: reference) }, selected: $entities, model: model)
        }
    }
    @ViewBuilder private var ruleParameterFields: some View {
        switch ruleType {
        case "required_reference":
            HStack { ForEach(["character", "location", "faction"], id: \.self) { key in Toggle(model.t("entity.kind." + key), isOn: membership(key, in: $referenceTypes)) } }
        case "fact_equals":
            ForEach(["identity", "primary_faction", "life_state", "age"], id: \.self) { key in Toggle(model.t("fact.predicate." + key), isOn: membership(key, in: $predicates)) }
        case "event_precedes":
            referencePicker(model.t("rule.earlier_event"), selection: $ruleBefore, kind: .event)
            referencePicker(model.t("rule.later_event"), selection: $ruleAfter, kind: .event)
        case "forbidden_term":
            TextField(model.t("rule.terms"), text: $terms, axis: .vertical).lineLimit(3...8)
            TextField(model.t("rule.term_exceptions"), text: $exceptions, axis: .vertical).lineLimit(2...5)
            Toggle(model.t("rule.case_sensitive"), isOn: $caseSensitive)
        case "world_constraint":
            referencePicker(model.t("rule.location"), selection: $ruleLocation, kind: .location)
            TextField(model.t("rule.capability"), text: $capability)
        default:
            TextField(model.t("rule.advisory"), text: $advisory, axis: .vertical).lineLimit(4...10)
            Text(model.t("rule.advisory_detail")).font(.callout).foregroundStyle(.secondary)
        }
    }
    private func referencePicker(_ title: String, selection: Binding<String>, kind: BibleKind, optional: Bool = false) -> some View {
        Picker(title, selection: selection) {
            Text(model.t(optional ? "reference.none" : "reference.select")).tag("")
            ForEach(entityChoices(model, kind, excluding: reference)) { Text($0.name).tag($0.id) }
        }
    }
    private func membership(_ item: String, in binding: Binding<Set<String>>) -> Binding<Bool> {
        Binding(get: { binding.wrappedValue.contains(item) }, set: { if $0 { binding.wrappedValue.insert(item) } else { binding.wrappedValue.remove(item) } })
    }
    private var valid: Bool {
        if kind != .rule && name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        if kind == .event && hasAnchor && (calendar.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || Int64(tick).map({ abs(Double($0)) > 9_007_199_254_740_991 }) != false) { return false }
        guard kind == .rule else { return true }
        if packages.isEmpty { return false }
        switch ruleType {
        case "required_reference": return !referenceTypes.isEmpty
        case "fact_equals": return !predicates.isEmpty
        case "event_precedes": return !ruleBefore.isEmpty && !ruleAfter.isEmpty && ruleBefore != ruleAfter
        case "forbidden_term": return !splitLines(terms).isEmpty
        case "world_constraint": return !ruleLocation.isEmpty && !capability.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default: return !advisory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
    private var parameters: JSONValue {
        switch ruleType {
        case "required_reference": .object(["entity_types": strings(referenceTypes)])
        case "fact_equals": .object(["predicates": strings(predicates)])
        case "event_precedes": .object(["before_event_id": .string(ruleBefore), "after_event_id": .string(ruleAfter)])
        case "forbidden_term": .object(["terms": .array(splitLines(terms).map(JSONValue.string)), "case_sensitive": .bool(caseSensitive), "exceptions": .array(splitLines(exceptions).map(JSONValue.string))])
        case "world_constraint": .object(["location_ref": .string(ruleLocation), "forbidden_capability": .string(capability)])
        default: .object(["text": .string(advisory)])
        }
    }
    private var value: JSONValue {
        var fields: [String: JSONValue] = [kind.idKey: .string(reference)]
        if kind != .rule { fields[kind.titleKey] = .string(name) }
        if [.character, .faction, .location, .world].contains(kind) { fields["description"] = .string(description) }
        if [.character, .location].contains(kind) { fields["aliases"] = .array(splitLines(aliases).map(JSONValue.string)) }
        if kind.hasArchive { fields["archived"] = .bool(archived) }
        switch kind {
        case .character: fields["traits"] = .array(splitLines(traits).map(JSONValue.string)); fields["facts"] = .array(facts)
        case .faction: fields["relations"] = .array(relations.map { .object(["target_ref": .string($0.target), "type": .string($0.type)]) })
        case .location: fields["interior_exterior"] = .string(interior); if !parent.isEmpty { fields["parent_ref"] = .string(parent) }
        case .event:
            fields["before_refs"] = strings(before); fields["after_refs"] = strings(after)
            if hasAnchor, let value = Int64(tick) { fields["time_anchor"] = .object(["calendar": .string(calendar), "tick": .integer(value)]) }
            fields["source_refs"] = entity["source_refs"] == .null ? .array([]) : entity["source_refs"]
        case .world: fields["source_refs"] = entity["source_refs"] == .null ? .array([]) : entity["source_refs"]
        case .rule:
            fields.merge(["revision": entity["revision"] == .null ? .integer(1) : entity["revision"], "type": .string(ruleType), "severity": .string(severity), "rationale": .string(description), "exception_policy": .string(exceptionPolicy), "parameters": parameters,
                          "scope": .object(["packages": strings(packages), "document_ids": strings(documents), "entity_refs": strings(entities)])]) { _, next in next }
        }
        return .object(fields)
    }
    private func strings(_ values: Set<String>) -> JSONValue { .array(values.sorted().map(JSONValue.string)) }
    private func load() {
        guard !didLoad else { return }; didLoad = true
        name = entity[kind.titleKey].string ?? ""; description = entity["description"].string ?? ""
        aliases = entity["aliases"].array.compactMap(\.string).joined(separator: "\n"); traits = entity["traits"].array.compactMap(\.string).joined(separator: "\n")
        archived = entity["archived"].bool ?? false; facts = entity["facts"].array
        parent = entity["parent_ref"].string ?? ""; interior = entity["interior_exterior"].string ?? "unknown"
        relations = entity["relations"].array.map { FactionRelation(target: $0["target_ref"].string ?? "", type: $0["type"].string ?? "neutral") }
        hasAnchor = entity["time_anchor"] != .null; calendar = entity["time_anchor"]["calendar"].string ?? ""; tick = entity["time_anchor"]["tick"].integer.map(String.init) ?? ""
        before = Set(entity["before_refs"].array.compactMap(\.string)); after = Set(entity["after_refs"].array.compactMap(\.string))
        if kind == .rule, entity != .null {
            ruleType = entity["type"].string ?? "advisory"; severity = entity["severity"].string ?? "warning"; exceptionPolicy = entity["exception_policy"].string ?? "author_review"; description = entity["rationale"].string ?? ""
            packages = Set(entity["scope"]["packages"].array.compactMap(\.string)); documents = Set(entity["scope"]["document_ids"].array.compactMap(\.string)); entities = Set(entity["scope"]["entity_refs"].array.compactMap(\.string))
            let p = entity["parameters"]
            if ruleType == "required_reference" { referenceTypes = Set(p["entity_types"].array.compactMap(\.string)) }
            if ruleType == "fact_equals" { predicates = Set(p["predicates"].array.compactMap(\.string)) }
            ruleBefore = p["before_event_id"].string ?? ""; ruleAfter = p["after_event_id"].string ?? ""
            terms = p["terms"].array.compactMap(\.string).joined(separator: "\n"); exceptions = p["exceptions"].array.compactMap(\.string).joined(separator: "\n"); caseSensitive = p["case_sensitive"].bool ?? true
            ruleLocation = p["location_ref"].string ?? ""; capability = p["forbidden_capability"].string ?? ""; advisory = p["text"].string ?? ""
        }
    }
}

func splitLines(_ text: String) -> [String] { text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
@MainActor func factDescription(_ model: WorkspaceModel, _ fact: JSONValue, blueprint: JSONValue? = nil) -> String {
    let predicate = fact["predicate"].string ?? "identity"
    let value: String
    if predicate == "primary_faction" { value = displayName(model, reference: fact["value"].string ?? "", blueprint: blueprint) }
    else if predicate == "life_state" { value = model.t("fact.life." + (fact["value"].string ?? "alive")) }
    else { value = fact["value"].string ?? fact["value"].integer.map(String.init) ?? "" }
    return model.t("fact.summary", ["predicate": model.t("fact.predicate." + predicate), "value": value])
}

struct FactEditor: View {
    let model: WorkspaceModel
    let subject: String
    let fact: JSONValue
    let onSave: (JSONValue) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var predicate = "identity"
    @State private var text = ""
    @State private var faction = ""
    @State private var life = "alive"
    @State private var start = ""
    @State private var end = ""
    @State private var didLoad = false
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(model.t("fact.edit")).font(.title2)
            Form {
                Picker(model.t("fact.predicate"), selection: $predicate) { ForEach(["identity", "primary_faction", "life_state", "age"], id: \.self) { Text(model.t("fact.predicate." + $0)).tag($0) } }
                if predicate == "primary_faction" { Picker(model.t("entity.kind.faction"), selection: $faction) { Text(model.t("reference.select")).tag(""); ForEach(entityChoices(model, .faction)) { Text($0.name).tag($0.id) } } }
                else if predicate == "life_state" { Picker(model.t("fact.value"), selection: $life) { ForEach(["alive", "dead"], id: \.self) { Text(model.t("fact.life." + $0)).tag($0) } } }
                else { TextField(model.t(predicate == "age" ? "fact.age_value" : "fact.value"), text: $text) }
                Picker(model.t("fact.valid_from"), selection: $start) { Text(model.t("reference.select")).tag(""); ForEach(entityChoices(model, .event)) { Text($0.name).tag($0.id) } }
                Picker(model.t("fact.valid_to"), selection: $end) { Text(model.t("fact.open_end")).tag(""); ForEach(entityChoices(model, .event, excluding: start)) { Text($0.name).tag($0.id) } }
                Text(model.t("fact.interval_detail")).font(.caption).foregroundStyle(.secondary)
                SourceEvidenceView(model: model, sources: fact["source_refs"].array)
            }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t("common.save")) { onSave(value); dismiss() }.keyboardShortcut(.defaultAction).disabled(!valid)
            }
        }.padding(24).frame(width: 530)
        .onAppear {
            guard !didLoad else { return }; didLoad = true
            predicate = fact["predicate"].string ?? "identity"; text = fact["value"].string ?? fact["value"].integer.map(String.init) ?? ""
            faction = predicate == "primary_faction" ? fact["value"].string ?? "" : ""; life = predicate == "life_state" ? fact["value"].string ?? "alive" : "alive"
            start = fact["valid_from"].string ?? ""; end = fact["valid_to"].string ?? ""
        }
    }
    private var valid: Bool {
        guard !start.isEmpty, start != end else { return false }
        switch predicate {
        case "primary_faction": return !faction.isEmpty
        case "life_state": return true
        case "age": return Int64(text).map { (0...1_000_000_000).contains($0) } ?? false
        default: return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
    private var value: JSONValue {
        let content: JSONValue = predicate == "age" ? .integer(Int64(text) ?? 0) : .string(predicate == "primary_faction" ? faction : predicate == "life_state" ? life : text)
        var result: [String: JSONValue] = ["fact_id": fact["fact_id"] == .null ? .string("fact_" + UUID().uuidString.lowercased()) : fact["fact_id"], "subject_ref": .string(subject), "predicate": .string(predicate), "value": content, "valid_from": .string(start), "source_refs": fact["source_refs"] == .null ? .array([]) : fact["source_refs"]]
        if !end.isEmpty { result["valid_to"] = .string(end) }
        return .object(result)
    }
}

struct SourceEvidenceView: View {
    let model: WorkspaceModel
    let sources: [JSONValue]
    var body: some View {
        if !sources.isEmpty {
            Section(model.t("source.evidence")) { ForEach(Array(sources.enumerated()), id: \.offset) { _, source in Text(source["quote"].string ?? "").textSelection(.enabled).font(.callout).foregroundStyle(.secondary) } }
        }
    }
}

struct BibleHistoryView: View {
    let model: WorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var revision: Int64 = 1
    @State private var snapshot: JSONValue = .null
    @State private var loadError: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.t("bible.history")).font(.title2)
            Text(model.t("bible.history_detail")).foregroundStyle(.secondary)
            HStack {
                Stepper(model.t("bible.revision", ["revision": String(revision)]), value: $revision, in: 1...max(1, model.bible["revision"].integer ?? 1))
                Button(model.t("bible.load_revision")) {
                    Task {
                        loadError = nil
                        if let result = await model.readBibleRevision(revision, onFailure: { loadError = $0 }) { snapshot = result }
                    }
                }.disabled(model.busy)
            }
            if let loadError { Text(loadError).foregroundStyle(.red).textSelection(.enabled) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if snapshot != .null {
                        Text(model.t("bible.revision", ["revision": String(snapshot["revision"].integer ?? 0)])).font(.headline)
                        Label(model.t(snapshot["blueprint"]["lock"]["locked"].bool == true ? "bible.locked" : "bible.editable"), systemImage: "book.closed").foregroundStyle(.secondary)
                        ForEach(BibleKind.allCases) { kind in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(model.t("entity.kind." + kind.rawValue)).font(.headline)
                                ForEach(Array(snapshot["blueprint"][kind.section].array.enumerated()), id: \.offset) { _, entity in
                                    Text(entityTitle(model, kind, entity)).font(.headline)
                                    HistoricalEntityDetails(model: model, kind: kind, entity: entity, blueprint: snapshot["blueprint"])
                                    Divider()
                                }
                            }
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
        }.padding(24).frame(width: 650, height: 580)
        .onAppear { revision = model.bible["revision"].integer ?? 1; snapshot = model.bible }
    }
}

struct HistoricalEntityDetails: View {
    let model: WorkspaceModel
    let kind: BibleKind
    let entity: JSONValue
    let blueprint: JSONValue
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let description = entity["description"].string, !description.isEmpty { Text(description) }
            if !entity["aliases"].array.isEmpty { field("character.aliases", entity["aliases"].array.compactMap(\.string).joined(separator: ", ")) }
            if kind.hasArchive { Text(model.t(entity["archived"].bool == true ? "entity.archived" : "entity.active")).foregroundStyle(.secondary) }
            switch kind {
            case .character:
                if !entity["traits"].array.isEmpty { field("character.traits", entity["traits"].array.compactMap(\.string).joined(separator: ", ")) }
                ForEach(Array(entity["facts"].array.enumerated()), id: \.offset) { _, fact in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(factDescription(model, fact, blueprint: blueprint))
                        field("fact.valid_from", name(fact["valid_from"]))
                        field("fact.valid_to", fact["valid_to"] == .null ? model.t("fact.open_end") : name(fact["valid_to"]))
                        SourceEvidenceView(model: model, sources: fact["source_refs"].array)
                    }
                }
            case .faction:
                ForEach(Array(entity["relations"].array.enumerated()), id: \.offset) { _, relation in
                    field("faction.relations", name(relation["target_ref"]) + " · " + model.t("faction.relation." + (relation["type"].string ?? "neutral")))
                }
            case .location:
                field("location.parent", entity["parent_ref"] == .null ? model.t("reference.none") : name(entity["parent_ref"]))
                field("location.interior_exterior", model.t("location." + (entity["interior_exterior"].string ?? "unknown")))
            case .event:
                if entity["time_anchor"] != .null {
                    field("timeline.calendar", entity["time_anchor"]["calendar"].string ?? "")
                    field("timeline.tick", entity["time_anchor"]["tick"].integer.map(String.init) ?? "")
                }
                field("timeline.before", names(entity["before_refs"]))
                field("timeline.after", names(entity["after_refs"]))
            case .world: EmptyView()
            case .rule: ruleDetails
            }
            SourceEvidenceView(model: model, sources: entity["source_refs"].array)
        }.font(.callout).textSelection(.enabled).padding(.vertical, 8)
    }
    private func field(_ key: String, _ text: String) -> some View { LabeledContent(model.t(key), value: text).frame(maxWidth: .infinity, alignment: .leading) }
    private func name(_ reference: JSONValue) -> String { displayName(model, reference: reference.string ?? "", blueprint: blueprint) }
    private func names(_ references: JSONValue) -> String { references.array.isEmpty ? model.t("reference.none") : references.array.map(name).joined(separator: ", ") }
    @ViewBuilder private var ruleDetails: some View {
        field("rule.type", model.t("rule.type." + (entity["type"].string ?? "advisory")))
        field("rule.revision", entity["revision"].integer.map(String.init) ?? "")
        field("rule.severity", model.t("rule.severity." + (entity["severity"].string ?? "warning")))
        field("rule.exception", model.t("rule.exception." + (entity["exception_policy"].string ?? "author_review")))
        if let rationale = entity["rationale"].string, !rationale.isEmpty { field("rule.rationale", rationale) }
        field("rule.scope", entity["scope"]["packages"].array.compactMap(\.string).map { model.t("package." + $0) }.joined(separator: ", "))
        field("rule.entities", entity["scope"]["entity_refs"].array.isEmpty ? model.t("reference.all") : names(entity["scope"]["entity_refs"]))
        field("rule.documents", entity["scope"]["document_ids"].array.isEmpty ? model.t("reference.all") : entity["scope"]["document_ids"].array.map { reference in model.documents.first { $0.id == reference.string }?.title ?? model.t("entity.unavailable") }.joined(separator: ", "))
        let p = entity["parameters"]
        switch entity["type"].string {
        case "required_reference": field("rule.type.required_reference", p["entity_types"].array.compactMap(\.string).map { model.t("entity.kind." + $0) }.joined(separator: ", "))
        case "fact_equals": field("fact.predicate", p["predicates"].array.compactMap(\.string).map { model.t("fact.predicate." + $0) }.joined(separator: ", "))
        case "event_precedes":
            field("rule.earlier_event", name(p["before_event_id"])); field("rule.later_event", name(p["after_event_id"]))
        case "forbidden_term":
            field("rule.terms", p["terms"].array.compactMap(\.string).joined(separator: ", "))
            field("rule.term_exceptions", p["exceptions"].array.compactMap(\.string).joined(separator: ", "))
            Toggle(model.t("rule.case_sensitive"), isOn: .constant(p["case_sensitive"].bool ?? true)).disabled(true)
        case "world_constraint": field("rule.location", name(p["location_ref"])); field("rule.capability", p["forbidden_capability"].string ?? "")
        default: field("rule.advisory", p["text"].string ?? "")
        }
    }
}
