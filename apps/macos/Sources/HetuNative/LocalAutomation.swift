import Foundation
import CryptoKit
import Darwin
import HetuCore

/// 本机偏好和套件安装复用原生 Owner；公开入口没有作者决定参数。
public actor LocalAutomation {
    public static let changed = Notification.Name("run.limeai.hetu.preferences.changed")
    public static let plansChanged = Notification.Name("run.limeai.hetu.local-operations.changed")
    private let directory: URL
    private let preferences: UserDefaults
    private let installer: AgentSuiteInstaller
    private let domainID: String
    private static let fields: [String: (String, JSONValue)] = [
        "language": ("Hetu.locale", .string("zh-CN")), "appearance": ("Hetu.appearance", .string("system")),
        "library_list": ("Hetu.library.list", .bool(false)), "autosave": ("Hetu.editor.autosave", .bool(true)),
        "font_family": ("Hetu.editor.fontFamily", .string("songti")), "font_size": ("Hetu.editor.fontSize", .integer(18)),
        "line_spacing": ("Hetu.editor.lineSpacing", .integer(5)), "first_line_indent": ("Hetu.editor.firstLineIndent", .bool(true)),
        "git_author_name": ("Hetu.git.authorName", .string("")), "git_author_email": ("Hetu.git.authorEmail", .string("")),
        "agent_client": ("Hetu.ai.defaultClient", .string("none"))
    ]
    public init(directory: URL? = nil, preferencesDomain: String? = nil, installer: AgentSuiteInstaller = AgentSuiteInstaller()) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Hetu/LocalOperations")
        // 随包 CLI 和 App 使用同一偏好域，测试可注入隔离域。
        let app = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let domain = preferencesDomain ?? Bundle(url: app)?.bundleIdentifier ?? "run.limeai.hetu"
        self.domainID = domain
        self.preferences = UserDefaults(suiteName: domain)!
        self.installer = installer
    }
    private func digest(_ value: JSONValue) throws -> String {
        SHA256.hash(data: try value.encoded()).map { String(format: "%02x", $0) }.joined()
    }
    private func snapshot() throws -> JSONValue {
        preferences.synchronize()
        return .object(try Self.fields.mapValues { key, fallback in
            guard let value = preferences.object(forKey: key) else { return fallback }
            return try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]))
        })
    }
    private func failure(_ action: String, _ code: String, _ message: String) -> JSONValue {
        .object(["spec_version": .string("0.2.1"), "kind": .string("result"), "action": .string(action), "contract_revision": .string("1"),
            "status": .string("blocked"), "context": .object(["scope_id": .string("collaboration")]),
            "error": .object(["code": .string(code), "message": .string(message), "resolution": .object(["kind": .string(code == "result_unknown" ? "recover" : "correct_input")])])])
    }
    private func success(_ action: String, _ data: JSONValue) -> JSONValue {
        .object(["spec_version": .string("0.2.1"), "kind": .string("result"), "action": .string(action), "contract_revision": .string("1"),
            "status": .string("succeeded"), "context": .object(["scope_id": .string("collaboration")]), "data": data])
    }
    public enum Fault: Error { case invalid, conflict, confirmation, integrity, unavailable, unknown }
    private func check(_ valid: Bool, _ fault: Fault = .invalid) throws { if !valid { throw fault } }
    private func planURL(_ id: String) throws -> URL {
        try check(id.hasPrefix("localop_") && UUID(uuidString: String(id.dropFirst(8))) != nil)
        return directory.appendingPathComponent(id + ".json")
    }
    private func read(_ url: URL) throws -> JSONValue {
        let fd = Darwin.open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
        try check(fd >= 0, .integrity)
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? handle.close() }
        var meta = stat()
        try check(fstat(fd, &meta) == 0 && meta.st_nlink == 1 && meta.st_mode & S_IFMT == S_IFREG && meta.st_size < 8 * 1024 * 1024, .integrity)
        let bytes = try handle.read(upToCount: 8 * 1024 * 1024) ?? Data()
        return try JSONDecoder().decode(JSONValue.self, from: bytes)
    }
    private func write(_ value: JSONValue, _ url: URL) throws {
        try value.encoded().write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url); defer { try? handle.close() }; try handle.synchronize()
        let fd = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        try check(fd >= 0, .integrity); defer { Darwin.close(fd) }
        try check(fsync(fd) == 0, .integrity)
    }
    private func locked<T>(_ body: () throws -> T) throws -> T {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = Darwin.open(directory.appendingPathComponent("operations.lock").path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        try check(fd >= 0, .integrity); defer { Darwin.close(fd) }
        var meta = stat()
        try check(fstat(fd, &meta) == 0 && meta.st_mode & S_IFMT == S_IFREG && meta.st_nlink == 1 && flock(fd, LOCK_EX | LOCK_NB) == 0, .conflict)
        defer { flock(fd, LOCK_UN) }
        return try body()
    }
    private func loadPlan(_ id: String) throws -> JSONValue {
        let value = try read(planURL(id))
        try check(value["operation_id"].string == id && value["sha256"].string == digest(value["fixed"]) && value["fixed"]["preferences_domain"].string == domainID, .integrity)
        return value
    }
    private func association(_ workspace: String?) -> JSONValue {
        .object(["client": preferences.string(forKey: workspace.map { "Hetu.ai.work.\($0).client" } ?? "Hetu.ai.defaultClient").map(JSONValue.string) ?? .null,
                 "suite": preferences.string(forKey: workspace.map { "Hetu.ai.work.\($0).suite" } ?? "Hetu.ai.defaultSuite").map(JSONValue.string) ?? .null])
    }
    private func checkAssociation(_ fixed: JSONValue, recovering: Bool) throws {
        guard fixed["kind"].string == "agent_suite" else { return }
        let current = association(fixed["workspace_id"].string)
        for field in ["client", "suite"] {
            let desired = fixed[field == "client" ? "agent_client" : "suite_id"]
            try check(current[field] == fixed["association_before"][field] || recovering && current[field] == desired, .conflict)
        }
    }
    private func validatePatch(_ patch: JSONValue) throws {
        try check(!patch.object.isEmpty && patch.object.count <= Self.fields.count)
        for (name, value) in patch.object {
            try check(Self.fields[name] != nil)
            switch name {
            case "language": try check(["zh-CN", "en"].contains(value.string ?? ""))
            case "appearance": try check(["system", "light", "dark"].contains(value.string ?? ""))
            case "font_family": try check(["songti", "pingfang", "system"].contains(value.string ?? ""))
            case "agent_client": try check(["none", "codex", "claudeCode", "workbuddy", "other"].contains(value.string ?? ""))
            case "font_size", "line_spacing":
                let number = value.integer.map(Double.init) ?? { if case .number(let number) = value { number } else { Double.nan } }()
                try check(number.isFinite && (name == "font_size" ? 14...30 : 0...16).contains(number))
            case "git_author_name", "git_author_email":
                try check(value.string.map { $0.count <= 256 && !$0.contains(where: { $0.isNewline || $0 == "\0" }) } == true)
            default: try check(value.bool != nil)
            }
        }
    }
    private func packageDigest(_ root: URL) throws -> String {
        guard let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]) else { throw Fault.integrity }
        var hashes: [String: JSONValue] = [:]
        for case let file as URL in files {
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            try check(values.isSymbolicLink != true, .integrity)
            if values.isRegularFile == true {
                try check((values.fileSize ?? Int.max) < 2_097_152 && hashes.count < 256, .integrity)
                let bytes = try Data(contentsOf: file)
                hashes[String(file.path.dropFirst(root.path.count + 1))] = .string(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
            }
        }
        return try digest(.object(hashes))
    }
    /// Agent 只能读取、准备、回读与执行已批准结果。作者决定没有公开 CLI 路由。
    public func request(_ action: String, input: [String: JSONValue], client: String) -> JSONValue {
        do {
            try check(["codex", "claude-code", "workbuddy", "generic"].contains(client))
            let result: JSONValue = try locked {
                switch action {
                case "hetu.local_settings.get":
                    try check(Set(input.keys).isSubset(of: ["workspace_id"]))
                    if let workspace = input["workspace_id"]?.string { try check(workspace.hasPrefix("workspace_") && UUID(uuidString: String(workspace.dropFirst(10))) != nil) }
                    else { try check(input.isEmpty) }
                    let catalog = try AgentSuiteCatalog.bundled()
                    return .object(["preferences": try snapshot(), "association": association(input["workspace_id"]?.string), "workspace_id": input["workspace_id"] ?? .null, "suites": .array(catalog.suites.map { .object(["suite_id": .string($0.id), "name": .string($0.pluginName), "summary": .string($0.summary ?? "")]) }),
                        "installable_clients": .array([.string("codex"), .string("workbuddy")])])
                case "hetu.local_settings.prepare":
                    try check(Set(input.keys).isSubset(of: ["kind", "patch", "agent_client", "suite_id", "workspace_id", "install", "summary", "operation_key"]))
                    guard let key = input["operation_key"]?.string, !key.isEmpty, key.count <= 128,
                          let summary = input["summary"]?.string, !summary.isEmpty, summary.count <= 2000 else { throw Fault.invalid }
                    let receiptURL = directory.appendingPathComponent("prepare-" + (try digest(.array([.string(domainID), .string(client), .string(key)]))) + ".json")
                    let requestSHA = try digest(.object(input))
                    if FileManager.default.fileExists(atPath: receiptURL.path) {
                        let receipt = try read(receiptURL); try check(receipt["input_sha256"].string == requestSHA, .conflict)
                        return try loadPlan(receipt["operation_id"].string ?? "")
                    }
                    var fixed: [String: JSONValue] = ["kind": input["kind"] ?? .null, "summary": .string(summary), "before": try snapshot(), "client_adapter": .string(client), "preferences_domain": .string(domainID),
                        "expires_at": .integer(Int64(Date().timeIntervalSince1970) + 86400)]
                    if input["kind"]?.string == "preferences" {
                        try check(Set(input.keys).isSubset(of: ["kind", "patch", "summary", "operation_key"]))
                        let patch = input["patch"] ?? .null; try validatePatch(patch); fixed["patch"] = patch
                    } else {
                        try check(input["patch"] == nil && (input["install"] == nil || input["install"]?.bool != nil))
                        try check(input["kind"]?.string == "agent_suite")
                        guard let selected = input["agent_client"]?.string, ["codex", "workbuddy", "claudeCode", "other"].contains(selected),
                              let suiteID = input["suite_id"]?.string else { throw Fault.invalid }
                        let catalog = try AgentSuiteCatalog.bundled()
                        guard let suite = catalog.suites.first(where: { $0.id == suiteID }) else { throw Fault.invalid }
                        let install = input["install"]?.bool ?? false
                        try check(!install || ["codex", "workbuddy"].contains(selected), .unavailable)
                        if let workspace = input["workspace_id"]?.string {
                            try check(workspace.hasPrefix("workspace_") && UUID(uuidString: String(workspace.dropFirst(10))) != nil)
                        } else { try check(input["workspace_id"] == nil) }
                        fixed["association_before"] = association(input["workspace_id"]?.string)
                        fixed["agent_client"] = .string(selected); fixed["suite_id"] = .string(suiteID); fixed["workspace_id"] = input["workspace_id"] ?? .null
                        fixed["install"] = .bool(install); fixed["package_sha256"] = .string(try packageDigest(catalog.directory(for: suite)))
                    }
                    let id = "localop_" + UUID().uuidString.lowercased()
                    let fixedValue = JSONValue.object(fixed)
                    let plan: JSONValue = .object(["operation_id": .string(id), "sha256": .string(try digest(fixedValue)), "fixed": fixedValue, "state": .string("pending"), "revision": .integer(1), "created_at": .string(ISO8601DateFormatter().string(from: Date()))])
                    try write(plan, planURL(id)); try write(.object(["input_sha256": .string(requestSHA), "operation_id": .string(id)]), receiptURL)
                    DistributedNotificationCenter.default().postNotificationName(Self.plansChanged, object: nil, userInfo: nil, deliverImmediately: true)
                    return plan
                case "hetu.local_settings.get_operation":
                    try check(Set(input.keys) == ["operation_id"])
                    let plan = try loadPlan(input["operation_id"]?.string ?? "")
                    try check(plan["fixed"]["client_adapter"].string == client, .confirmation); return plan
                case "hetu.local_settings.execute":
                    try check(Set(input.keys) == ["operation_id", "sha256", "operation_key"])
                    var plan = try loadPlan(input["operation_id"]?.string ?? "").object
                    let fixed = plan["fixed"] ?? .null
                    try check(fixed["client_adapter"].string == client && input["sha256"] == plan["sha256"], .confirmation)
                    guard let key = input["operation_key"]?.string, !key.isEmpty, key.count <= 128 else { throw Fault.invalid }
                    if plan["state"]?.string == "executed" { return .object(plan) }
                    let recovering = plan["state"]?.string == "executing"
                    try check(plan["state"]?.string == "approved" || recovering, .confirmation)
                    try checkAssociation(fixed, recovering: recovering)
                    if recovering {
                        try check(plan["execute_key"]?.string == key, .conflict)
                        let current = try snapshot()
                        for (field, original) in fixed["before"].object {
                            let desired = fixed["kind"].string == "preferences" ? fixed["patch"][field] : field == "agent_client" && fixed["workspace_id"] == .null ? fixed["agent_client"] : .null
                            try check(current[field] == original || desired != .null && current[field] == desired, .conflict)
                        }
                    } else {
                        try check((fixed["expires_at"].integer ?? 0) > Int64(Date().timeIntervalSince1970), .confirmation)
                        try check(fixed["before"] == snapshot(), .conflict)
                        plan["state"] = .string("executing"); plan["execute_key"] = .string(key)
                        try write(.object(plan), planURL(input["operation_id"]!.string!))
                    }
                    if fixed["kind"].string == "preferences" {
                        try validatePatch(fixed["patch"])
                        for (field, value) in fixed["patch"].object {
                            let object = try JSONSerialization.jsonObject(with: value.encoded(), options: [.fragmentsAllowed])
                            preferences.set(object, forKey: Self.fields[field]!.0)
                        }
                    } else {
                        let catalog = try AgentSuiteCatalog.bundled()
                        guard let selected = AgentClient(rawValue: fixed["agent_client"].string ?? ""), let suite = catalog.suites.first(where: { $0.id == fixed["suite_id"].string }) else { throw Fault.invalid }
                        try check(fixed["package_sha256"].string == packageDigest(catalog.directory(for: suite)), .conflict)
                        if fixed["install"].bool == true {
                            let receipt: AgentInstallReceipt
                            if recovering && selected == .codex {
                                guard let actual = try installer.recoverCodex(suite: suite, catalog: catalog) else {
                                    throw Fault.unknown
                                }
                                receipt = actual
                            } else { receipt = try selected == .codex ? installer.installCodex(suite: suite, catalog: catalog) : installer.installWorkBuddy(suite: suite, catalog: catalog) }
                            plan["installation"] = .object(["directory": .string(receipt.directory.path), "version": .string(receipt.version)])
                        }
                        if let workspace = fixed["workspace_id"].string {
                            preferences.set(selected.rawValue, forKey: "Hetu.ai.work.\(workspace).client"); preferences.set(suite.id, forKey: "Hetu.ai.work.\(workspace).suite")
                        } else {
                            preferences.set(selected.rawValue, forKey: "Hetu.ai.defaultClient")
                            preferences.set(suite.id, forKey: "Hetu.ai.defaultSuite")
                        }
                    }
                    try check(preferences.synchronize(), .integrity)
                    plan["state"] = .string("executed"); plan["result"] = try snapshot(); plan["execute_key"] = .string(key)
                    if fixed["kind"].string == "agent_suite" { plan["workspace_association"] = association(fixed["workspace_id"].string) }
                    plan["revision"] = .integer((plan["revision"]?.integer ?? 0) + 1)
                    try write(.object(plan), planURL(input["operation_id"]!.string!))
                    DistributedNotificationCenter.default().postNotificationName(Self.changed, object: nil, userInfo: nil, deliverImmediately: true)
                    DistributedNotificationCenter.default().postNotificationName(Self.plansChanged, object: nil, userInfo: nil, deliverImmediately: true)
                    return .object(plan)
                default: throw Fault.unavailable
                }
            }
            return success(action, result)
        } catch Fault.confirmation { return failure(action, "hetu.author_confirmation_required", "本次操作尚未获作者批准或不属于此客户端。") }
        catch Fault.conflict { return failure(action, "revision_conflict", "本机设置或套件已有变化，请核对原方案。") }
        catch Fault.unavailable { return failure(action, "hetu.capability_unavailable", "此客户端未提供受管安装能力；可先保存明确选择。") }
        catch Fault.unknown { return failure(action, "result_unknown", "尚未核实官方插件安装结果；保留原方案，不重复安装。") }
        catch Fault.invalid { return failure(action, "invalid_input", "本机操作参数不符合当前合同。") }
        catch { return failure(action, "hetu.io_failure", "本机操作未完成，请沿原操作引用读取实际结果。") }
    }
    public func plans() throws -> [JSONValue] {
        try locked {
            let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasPrefix("localop_") && $0.hasSuffix(".json") }
            try check(names.count <= 10_000, .integrity)
            return try names.sorted().compactMap { name -> JSONValue? in
                let value = try read(directory.appendingPathComponent(name))
                guard value["fixed"]["preferences_domain"].string == domainID else { return nil }
                return try loadPlan(String(name.dropLast(5)))
            }.sorted { ($0["created_at"].string ?? "") > ($1["created_at"].string ?? "") }
        }
    }
    /// 只由原生审阅入口调用，不接受外部 Agent 声明作者身份。
    public func decide(id: String, sha256: String, revision: Int64, approve: Bool) throws -> JSONValue {
        try locked {
            var plan = try loadPlan(id).object
            try check(plan["sha256"]?.string == sha256 && plan["revision"]?.integer == revision && plan["state"]?.string != "executed" && plan["state"]?.string != "executing", .conflict)
            if approve {
                let fixed = plan["fixed"] ?? .null
                try check((fixed["expires_at"].integer ?? 0) > Int64(Date().timeIntervalSince1970), .confirmation)
                try check(fixed["before"] == snapshot(), .conflict)
                try checkAssociation(fixed, recovering: false)
            }
            plan["state"] = .string(approve ? "approved" : "rejected"); plan["revision"] = .integer(revision + 1)
            plan["decided_at"] = .string(ISO8601DateFormatter().string(from: Date()))
            try write(.object(plan), planURL(id)); return .object(plan)
        }
    }
}
