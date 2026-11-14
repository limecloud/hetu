import AppKit
import SwiftUI
import HetuCore
import HetuNative

struct ModelServiceSettings: View {
    let locale: String
    @State private var connection: JSONValue = .null
    @State private var catalogs: [String: JSONValue] = [:]
    @State private var busy = false
    @State private var message = ""
    @State private var editingChannel: String?
    @State private var showChannel = false
    private let client = ModelServiceClient()
    private func t(_ key: String) -> String { Localizer(locale: locale).text(key) }
    private var channelIDs: [String] { connection["custom_channels"].object.keys.sorted() }
    var body: some View {
        Form {
            serviceSection
            customChannelsSection
            ForEach(["text", "image"], id: \.self) { kind in modelSection(kind) }
            if !message.isEmpty { Text(message).font(.system(size: 13)).foregroundStyle(WorkbenchPalette.muted).textSelection(.enabled) }
            if busy { ProgressView().controlSize(.small) }
        }.formStyle(.grouped).scrollContentBackground(.hidden).disabled(busy).task { await load() }
        .sheet(isPresented: $showChannel) {
            CustomModelChannel(locale: locale, channelID: editingChannel, profile: editingChannel.map { connection["custom_channels"][$0] } ?? .null) { await load() }
        }
    }
    private var serviceSection: some View {
        Section(t("models.service")) {
            Text(t("models.note")).font(.system(size: 13)).foregroundStyle(WorkbenchPalette.muted)
            if connection["connected"].bool == true {
                HStack {
                    Button(t("models.account")) { open("https://hetu.limeai.run/console/") }
                    Button(t("models.refresh")) { Task { await load() } }
                        Button(t("models.disconnect")) { Task { await perform("disconnect"); await load() } }
                }
            }
            Button(t(connection["connected"].bool == true ? "models.reconnect" : "models.connect")) {
                Task { await perform("connect"); if let uri = connection["pending"]["verification_uri"].string { open(uri) } }
            }
            if let code = connection["pending"]["verification_code"].string {
                LabeledContent(t("models.code"), value: code)
                HStack {
                    Button(t("models.open_browser")) { if let uri = connection["pending"]["verification_uri"].string { open(uri) } }
                    Button(t("models.completed")) { Task { await perform("poll"); await load() } }
                }
            }
        }
    }
    private var customChannelsSection: some View {
        Section(t("models.custom_channels")) {
            ForEach(channelIDs, id: \.self) { id in
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(connection["custom_channels"][id]["name"].string ?? "")
                        Text(connection["custom_channels"][id]["base_url"].string ?? "").font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                    }
                    Spacer()
                    Button(t("models.edit_channel")) { editingChannel = id; showChannel = true }
                }
            }
            Button(t("models.add_channel")) { editingChannel = nil; showChannel = true }
        }
    }
    private func modelSection(_ kind: String) -> some View {
        let channel = connection["channels"][kind].string ?? "cloud"
        let selected = connection["defaults"][kind].string ?? ""
        let items = catalogs[kind]?["items"].array ?? []
        return Section(t(kind == "text" ? "models.text" : "models.image")) {
            Picker(t("models.channel"), selection: channelBinding(kind)) {
                Text(t("models.cloud_channel")).tag("cloud")
                ForEach(channelIDs, id: \.self) { id in
                    Text(connection["custom_channels"][id]["name"].string ?? "").tag(id)
                }
            }
            Picker(t("models.default"), selection: modelBinding(kind)) {
                Text(t("models.choose")).tag("")
                if !selected.isEmpty && !items.contains(where: { $0["id"].string == selected }) {
                    Text(selected + " (" + t("models.unavailable") + ")").tag(selected)
                }
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Text(modelTitle(item, channel: channel)).tag(item["id"].string ?? "")
                }
            }
            if items.isEmpty { Text(t("models.empty")).foregroundStyle(WorkbenchPalette.muted) }
            if channel != "cloud" { Text(t("models.provider_billing")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
        }
    }
    private func channelBinding(_ kind: String) -> Binding<String> {
        Binding(get: { connection["channels"][kind].string ?? "cloud" }, set: { id in
            Task { await perform("channel_select", input: ["kind": .string(kind), "channel_id": .string(id)]); await load() }
        })
    }
    private func modelBinding(_ kind: String) -> Binding<String> {
        Binding(get: { connection["defaults"][kind].string ?? "" }, set: { id in
            Task { await perform("select", input: ["kind": .string(kind), "model_id": .string(id)]) }
        })
    }
    private func modelTitle(_ item: JSONValue, channel: String) -> String {
        let id = item["id"].string ?? ""
        guard channel == "cloud" else { return id }
        return id + " (" + (item["billing"]["credits_per_unit"].string ?? "") + " Credits)"
    }
    private func open(_ value: String) {
        guard let url = URL(string: value), url.scheme == "https", url.host == "hetu.limeai.run" else { return }
        NSWorkspace.shared.open(url)
    }
    private func failure(_ error: Error) {
        if case CoreError.business(let value) = error, let code = value["error"]["code"].string { let key = "error." + code; message = t(key) }
        else { message = t("models.failed") }
    }
    private func perform(_ action: String, input: [String: JSONValue] = [:]) async {
        guard !busy else { return }; busy = true; message = ""; defer { busy = false }
        do {
            let value = try await client.request(action, input: input)
            connection = try await client.request("inspect")
            if value["status"].string == "pending" { message = t("models.pending") }
        } catch { failure(error) }
    }
    private func load() async {
        guard !busy else { return }; busy = true; message = ""; defer { busy = false }
        do {
            connection = try await client.request("inspect"); catalogs = [:]
                for kind in ["text", "image"] where connection["connected"].bool == true || (connection["channels"][kind].string ?? "cloud") != "cloud" {
                    do { catalogs[kind] = try await client.request("catalog", input: ["kind": .string(kind)]) }
                    catch { failure(error) }
                }
        } catch { failure(error) }
    }
}

private struct CustomModelChannel: View {
    let locale: String
    let channelID: String?
    let profile: JSONValue
    let saved: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var baseURL = ""
    @State private var apiKey = ""
    @State private var textModels = ""
    @State private var imageModels = ""
    @State private var busy = false
    @State private var message = ""
    private func t(_ key: String) -> String { Localizer(locale: locale).text(key) }
    private func models(_ value: String) -> JSONValue {
        .array(value.components(separatedBy: CharacterSet(charactersIn: ",，\n")).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.map(JSONValue.string))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(t(channelID == nil ? "models.add_channel" : "models.edit_channel")).font(.headline)
            Form {
                TextField(t("models.channel_name"), text: $name)
                TextField(t("models.base_url"), text: $baseURL, prompt: Text("https://…/v1"))
                SecureField(t("models.api_key"), text: $apiKey)
                Text(t(channelID == nil ? "models.key_private" : "models.key_keep")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                TextField(t("models.text_codes"), text: $textModels, axis: .vertical).lineLimit(2...4)
                TextField(t("models.image_codes"), text: $imageModels, axis: .vertical).lineLimit(2...4)
                Text(t("models.codes_note")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            }
            Text(t("models.provider_billing")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            if !message.isEmpty { Text(message).font(.system(size: 12)).foregroundStyle(.red) }
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button(t("models.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(t("models.save_channel")) { Task { await save() } }.keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 520).disabled(busy).onAppear {
            name = profile["name"].string ?? ""; baseURL = profile["base_url"].string ?? ""
            textModels = profile["models"]["text"].array.compactMap(\.string).joined(separator: "\n")
            imageModels = profile["models"]["image"].array.compactMap(\.string).joined(separator: "\n")
        }
    }
    private func save() async {
        guard !busy else { return }; busy = true; message = ""; defer { busy = false }
        var input: [String: JSONValue] = ["name": .string(name), "base_url": .string(baseURL), "api_key": .string(apiKey), "models": .object(["text": models(textModels), "image": models(imageModels)])]
        if let channelID { input["channel_id"] = .string(channelID) }
        do { _ = try await ModelServiceClient().request("custom_save", input: input); apiKey = ""; await saved(); dismiss() }
        catch { message = t("models.channel_invalid") }
    }
}
