import Foundation
import Observation
import HetuCore
import HetuTaskViewAssets

public struct LocalViewPairRequest: Identifiable, Equatable {
    public let id: String
    public let code: String
}

/// 原生端持有子进程及任务受限句柄；浏览器和 Node 均不能取得作者入口。
@MainActor @Observable public final class LocalTaskViewSession {
    public private(set) var url: URL?
    public private(set) var running = false
    public private(set) var pairing: [LocalViewPairRequest] = []
    public private(set) var errorKey: String?
    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var buffer = Data()
    private var generation = ""
    private var taskReference: JSONValue = .null
    private var workspace: Workspace?
    private var heartbeat: Task<Void, Never>?

    public init() {}
    public static var packagedRuntime: URL? {
        guard let root = Bundle.main.executableURL?.deletingLastPathComponent().deletingLastPathComponent() else { return nil }
        let url = root.appendingPathComponent("Helpers/node")
        return FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
    }
    public func start(root: URL, scope: ContentScope, taskRef: JSONValue, locale: String, theme: String, runtime: URL? = nil) async {
        stop(); errorKey = nil
        guard let runtime = runtime ?? Self.packagedRuntime, runtime.isFileURL,
              FileManager.default.isExecutableFile(atPath: runtime.path), let taskID = taskRef["task_id"].string else { errorKey = "local_view.runtime_missing"; return }
        let identity = UUID().uuidString.lowercased()
        generation = identity
        do {
            let taskWorkspace = try await (scope == .workspace
                ? Workspace.open(at: root, mode: .agent, taskID: taskID)
                : Workspace.openCreationProject(at: root, mode: .agent, taskID: taskID))
            _ = try await taskWorkspace.data("hetu.creative_tasks.get", input: ["task_ref": taskRef])
            guard generation == identity else { return }
            workspace = taskWorkspace; taskReference = taskRef
            let child = Process(), incoming = Pipe(), outgoing = Pipe()
            child.executableURL = runtime
            child.arguments = [TaskViewAssets.directory.appendingPathComponent("server.mjs").path]
            // 不继承 NODE_OPTIONS、NODE_PATH、预加载脚本、Agent 密钥或作者凭据。
            child.environment = ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8", "NODE_NO_WARNINGS": "1"]
            child.standardInput = incoming; child.standardOutput = outgoing; child.standardError = FileHandle.nullDevice
            let reader = outgoing.fileHandleForReading
            reader.readabilityHandler = { [weak self] handle in
                let bytes = handle.availableData
                Task { @MainActor [weak self] in self?.receive(bytes, identity: identity) }
            }
            child.terminationHandler = { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self, self.generation == identity else { return }
                    self.stop()
                }
            }
            process = child; input = incoming.fileHandleForWriting; output = reader
            try child.run()
            running = true
            try send(["type": .string("start"), "view_id": .string(identity), "task_ref": taskRef,
                      "locale": .string(locale == "en" ? "en" : "zh-CN"), "theme": .string(theme == "dark" ? "dark" : "light")])
            heartbeat = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(2))
                    guard !Task.isCancelled, let self, self.generation == identity else { return }
                    do { _ = try await taskWorkspace.data("hetu.creative_tasks.get", input: ["task_ref": taskRef]) }
                    catch { self.stop(); return }
                }
            }
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(8))
                guard let self, self.generation == identity, self.url == nil else { return }
                self.errorKey = "local_view.start_failed"; self.stop()
            }
        } catch {
            guard generation == identity else { return }
            errorKey = "local_view.start_failed"; stop()
        }
    }
    public func approve(_ request: LocalViewPairRequest) {
        guard pairing.contains(request) else { return }
        do { try send(["type": .string("authorize"), "view_id": .string(generation), "request_id": .string(request.id)]) }
        catch { errorKey = "local_view.start_failed"; stop() }
        pairing.removeAll { $0.id == request.id }
    }
    public func deny(_ request: LocalViewPairRequest) {
        guard pairing.contains(request) else { return }
        try? send(["type": .string("deny"), "view_id": .string(generation), "request_id": .string(request.id)])
        pairing.removeAll { $0.id == request.id }
    }
    public func stop() {
        if running { try? send(["type": .string("stop"), "view_id": .string(generation)]) }
        generation = ""; heartbeat?.cancel(); heartbeat = nil
        try? input?.close(); input = nil
        output?.readabilityHandler = nil; try? output?.close(); output = nil
        if let child = process {
            child.terminationHandler = nil
            Task.detached {
                try? await Task.sleep(for: .seconds(2))
                if child.isRunning { child.terminate() }
            }
        }
        process = nil; workspace = nil; taskReference = .null
        buffer.removeAll(); url = nil; running = false; pairing = []
    }
    private func send(_ fields: [String: JSONValue]) throws {
        guard let input, process?.isRunning == true else { throw CreativeTaskError.invalidResult }
        var data = try JSONValue.object(fields).encoded(); data.append(10)
        try input.write(contentsOf: data)
    }
    private func receive(_ bytes: Data, identity: String) {
        guard generation == identity else { return }
        guard !bytes.isEmpty, buffer.count + bytes.count <= 24 * 1024 * 1024 else { stop(); return }
        buffer.append(bytes)
        while let newline = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
            guard let value = try? JSONDecoder().decode(JSONValue.self, from: line), value["view_id"].string == identity else { errorKey = "local_view.start_failed"; stop(); return }
            switch value["type"].string {
            case "ready":
                guard let raw = value["url"].string, let url = URL(string: raw), url.scheme == "http", url.host == "127.0.0.1",
                      url.port != nil, url.path == "/", url.query == nil, url.fragment == nil, url.user == nil, url.password == nil else { stop(); return }
                self.url = url
            case "pair_request":
                guard let id = value["request_id"].string, id.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                      let code = value["code"].string, code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil, pairing.count < 16 else { stop(); return }
                let request = LocalViewPairRequest(id: id, code: code)
                if !pairing.contains(request) { pairing.append(request) }
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(120))
                    guard let self, self.generation == identity else { return }
                    self.pairing.removeAll { $0.id == id }
                }
            case "request":
                Task { @MainActor [weak self] in await self?.respond(value, identity: identity) }
            case "stopped": stop()
            default: errorKey = "local_view.start_failed"; stop()
            }
        }
    }
    private func respond(_ message: JSONValue, identity: String) async {
        guard generation == identity, let workspace, let id = message["id"].string,
              let action = message["action"].string else { return }
        let fields = message["input"].object
        let allowed: Bool
        switch action {
        case "hetu.interactions.get": allowed = Set(fields.keys) == ["task_ref"] && fields["task_ref"] == taskReference
        case "hetu.interactions.save_selection":
            allowed = Set(fields.keys).isSubset(of: ["task_ref", "expected", "candidate_refs", "comment", "operation_key"]) && fields["task_ref"] == taskReference
        case "hetu.operations.get":
            allowed = Set(fields.keys) == ["action", "key"] && fields["action"]?.string == "hetu.interactions.save_selection" && fields["key"]?.string != nil
        default: allowed = false
        }
        guard allowed else { errorKey = "local_view.start_failed"; stop(); return }
        do {
            let result = try await workspace.request(action, input: fields)
            guard generation == identity else { return }
            try send(["type": .string("response"), "view_id": .string(identity), "id": .string(id), "result": result])
            if result["error"]["code"].string == "forbidden" { stop() }
        } catch { if generation == identity { errorKey = "local_view.start_failed"; stop() } }
    }
}
