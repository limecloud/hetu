import Foundation
import Observation
import HetuIntegrationAssets

public enum AgentClient: String, CaseIterable, Codable, Sendable {
    case none, codex, workbuddy, claudeCode, other
    public var titleKey: String { "agent.client." + rawValue }
}

public struct AgentAssociation: Equatable, Sendable {
    public var client: AgentClient
    public var suiteID: String
    public init(client: AgentClient, suiteID: String) { self.client = client; self.suiteID = suiteID }
}

/// 客户端选择属于本机偏好；不改变作品资料、任务授权或宿主配置。
@MainActor @Observable public final class AgentIntegrationSettings {
    @ObservationIgnored private let preferences: UserDefaults
    private var revision = 0
    public init(preferences: UserDefaults = .standard) { self.preferences = preferences }
    public var defaultClient: AgentClient {
        get { _ = revision; return AgentClient(rawValue: preferences.string(forKey: "Hetu.ai.defaultClient") ?? "") ?? .none }
        set { preferences.set(newValue.rawValue, forKey: "Hetu.ai.defaultClient"); revision += 1 }
    }
    public func association(for workspaceID: String) -> AgentAssociation {
        _ = revision
        // 旧作品没有关联时保持手工创作，不追随之后变化的默认客户端。
        return AgentAssociation(client: AgentClient(rawValue: preferences.string(forKey: key(workspaceID, "client")) ?? "") ?? .none,
            suiteID: preferences.string(forKey: key(workspaceID, "suite")) ?? "general")
    }
    public func associate(_ value: AgentAssociation, with workspaceID: String) {
        guard !workspaceID.isEmpty else { return }
        preferences.set(value.client.rawValue, forKey: key(workspaceID, "client"))
        preferences.set(value.suiteID, forKey: key(workspaceID, "suite")); revision += 1
    }
    public func packageDirectory(client: AgentClient, suiteID: String) -> URL? {
        _ = revision
        return preferences.string(forKey: "Hetu.ai.package.\(client.rawValue).\(suiteID)").map { URL(fileURLWithPath: $0, isDirectory: true) }
    }
    public func selectPackageDirectory(_ directory: URL?, client: AgentClient, suiteID: String) {
        preferences.set(directory?.path, forKey: "Hetu.ai.package.\(client.rawValue).\(suiteID)"); revision += 1
    }
    private func key(_ workspaceID: String, _ field: String) -> String { "Hetu.ai.work.\(workspaceID).\(field)" }
}

public struct AgentSuite: Decodable, Identifiable, Sendable {
    public let id: String
    public let pluginName: String
    public let titleKey: String
    public let requiredFiles: [String]
    public func skillName(_ method: String, client: AgentClient) -> String {
        client == .workbuddy && id != "general" ? pluginName + "-" + method.replacingOccurrences(of: "hetu-", with: "") : method
    }
}

public struct AgentSuiteCatalog: Decodable, Sendable {
    public let schemaVersion: String
    public let suites: [AgentSuite]
    public let skills: [String]
    public static func bundled() throws -> Self {
        let bytes = try Data(contentsOf: IntegrationAssets.directory.appendingPathComponent("catalog.json"))
        let value = try JSONDecoder().decode(Self.self, from: bytes)
        guard value.schemaVersion == "1.0.0", !value.suites.isEmpty else { throw PackageError.invalid }
        return value
    }
    public func directory(for suite: AgentSuite) -> URL { IntegrationAssets.directory.appendingPathComponent("codex/" + suite.pluginName) }
}

public enum PackageError: Error { case invalid }
public enum PluginRegistration: String, Sendable { case enabled, disabled, notFound, unknown }
public enum AgentPackageState: String, Sendable { case notFound, filesFound, filesInstalled, registered, partial, invalid, ambiguous }

public struct AgentPackageInspection: Sendable {
    public let state: AgentPackageState
    public let registration: PluginRegistration
    public let directory: URL?
    public let version: String?
    public let expectedVersion: String?
    public let lockVersion: String?
    public let foundSkills: [String]
    public let missingSkills: [String]
    public let checkedAt: Date
    public var versionDiffers: Bool { version != nil && expectedVersion != nil && version != expectedVersion }
}

/// 只读核对包文件及 Codex 本机登记；不把缓存、配置开关当作会话已加载或 MCP 连通。
public struct AgentPackageInspector: Sendable {
    public let codexDirectory: URL
    public let workbuddyDirectory: URL
    public static var defaultWorkbuddyDirectory: URL {
        let environment = ProcessInfo.processInfo.environment
        if let explicit = environment["WORKBUDDY_CONFIG_DIR"], !explicit.trimmingCharacters(in: .whitespaces).isEmpty { return URL(fileURLWithPath: explicit) }
        let instance = environment["WORKBUDDY_INSTANCE_NUMBER"].map { "-" + $0 } ?? ""
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".workbuddy" + instance)
    }
    public init(codexDirectory: URL? = nil, workbuddyDirectory: URL? = nil) {
        self.codexDirectory = codexDirectory ?? ProcessInfo.processInfo.environment["CODEX_HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex", isDirectory: true)
        self.workbuddyDirectory = workbuddyDirectory ?? Self.defaultWorkbuddyDirectory
    }
    public func inspect(suite: AgentSuite, catalog: AgentSuiteCatalog, client: AgentClient, selectedDirectory: URL? = nil) -> AgentPackageInspection {
        let expected = try? manifest(at: catalog.directory(for: suite))["version"] as? String
        func result(_ state: AgentPackageState, _ registration: PluginRegistration = .unknown, _ directory: URL? = nil, _ version: String? = nil, _ skills: [String] = [], lockVersion: String? = nil) -> AgentPackageInspection {
            AgentPackageInspection(state: state, registration: registration, directory: directory, version: version,
                expectedVersion: expected, lockVersion: lockVersion, foundSkills: skills, missingSkills: catalog.skills.filter { !skills.contains($0) }, checkedAt: Date())
        }
        guard client != .none else { return result(.notFound) }
        var candidates: [(URL, PluginRegistration)] = []
        if let selectedDirectory {
            var state = PluginRegistration.unknown
            let cache = codexDirectory.appendingPathComponent("plugins/cache").resolvingSymlinksInPath().path + "/"
            let path = selectedDirectory.resolvingSymlinksInPath().path
            if client == .codex, path.hasPrefix(cache) {
                let parts = String(path.dropFirst(cache.count)).split(separator: "/")
                if parts.count == 3, parts[1] == suite.pluginName { state = registration(pluginID: suite.pluginName + "@" + parts[0]) }
            }
            candidates = [(selectedDirectory, state)]
        }
        else if client == .codex {
            let cache = codexDirectory.appendingPathComponent("plugins/cache")
            for market in children(cache) {
                let registration = registration(pluginID: suite.pluginName + "@" + market.lastPathComponent)
                for package in children(market.appendingPathComponent(suite.pluginName)) {
                    if FileManager.default.fileExists(atPath: package.appendingPathComponent("plugin.json").path)
                        || FileManager.default.fileExists(atPath: package.appendingPathComponent(".codex-plugin/plugin.json").path) {
                        candidates.append((package, registration))
                    }
                }
            }
            // 多个版本不能通过目录排序猜当前加载版本；由作者选择实际包目录。
            let registered = candidates.filter { $0.1 == .enabled || $0.1 == .disabled }
            if !registered.isEmpty { candidates = registered }
        } else if client == .workbuddy {
            let package = workbuddyDirectory.appendingPathComponent("skills/" + suite.pluginName)
            if FileManager.default.fileExists(atPath: package.path) { candidates = [(package, .unknown)] }
        }
        guard !candidates.isEmpty else { return result(.notFound, client == .codex ? .notFound : .unknown) }
        guard candidates.count == 1 else { return result(.ambiguous) }
        let (directory, registration) = candidates[0]
        do {
            let manifest = try manifest(at: directory)
            guard manifest["name"] as? String == suite.pluginName,
                  let version = manifest["version"] as? String, validVersion(version) else { return result(.invalid, registration, directory) }
            let identity = try JSONSerialization.jsonObject(with: read(directory.appendingPathComponent("hetu-suite.json"), within: directory)) as? [String: Any]
            guard identity?["schema_version"] as? String == "1.0.0", identity?["suite_id"] as? String == suite.id else { return result(.invalid, registration, directory, version) }
            guard suite.requiredFiles.allSatisfy({ (try? read(directory.appendingPathComponent($0), within: directory)) != nil }) else { return result(.invalid, registration, directory, version) }
            let lock = (try? read(directory.appendingPathComponent("plugin.lock.json"), within: directory)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let skills = catalog.skills.filter { name in
                guard let bytes = try? read(directory.appendingPathComponent("skills/\(name)/SKILL.md"), within: directory),
                      let content = String(data: bytes, encoding: .utf8) else { return false }
                let lines = content.components(separatedBy: .newlines)
                guard lines.first == "---", let end = lines.dropFirst().firstIndex(of: "---") else { return false }
                let expectedName = identity?["adapter"] as? String == "workbuddy" ? suite.skillName(name, client: .workbuddy) : name
                return lines[1..<end].contains("name: \(expectedName)")
            }
            let workbuddyInstalled = client == .workbuddy && directory.resolvingSymlinksInPath() == workbuddyDirectory.appendingPathComponent("skills/" + suite.pluginName).resolvingSymlinksInPath() && identity?["adapter"] as? String == "workbuddy"
            let state: AgentPackageState = skills.count != catalog.skills.count ? .partial : registration == .enabled || registration == .disabled ? .registered : workbuddyInstalled ? .filesInstalled : .filesFound
            return result(state, registration, directory, version, skills, lockVersion: lock?["pluginVersion"] as? String)
        } catch { return result(.invalid, registration, directory) }
    }
    private func children(_ directory: URL) -> [URL] {
        let values = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])) ?? []
        return Array(values.prefix(256)).filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
    }
    private func manifest(at directory: URL) throws -> [String: Any] {
        let portable = directory.appendingPathComponent("plugin.json")
        let file = FileManager.default.fileExists(atPath: portable.path) ? portable : directory.appendingPathComponent(".codex-plugin/plugin.json")
        guard let result = try JSONSerialization.jsonObject(with: read(file, within: directory)) as? [String: Any] else { throw PackageError.invalid }
        return result
    }
    private func validVersion(_ version: String) -> Bool { version.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$", options: .regularExpression) != nil }
    private func read(_ file: URL, within root: URL) throws -> Data {
        let canonical = file.resolvingSymlinksInPath().standardizedFileURL
        guard canonical.path.hasPrefix(root.resolvingSymlinksInPath().standardizedFileURL.path + "/"),
              (try canonical.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else { throw PackageError.invalid }
        let handle = try FileHandle(forReadingFrom: canonical); defer { try? handle.close() }
        let data = try handle.read(upToCount: 1_048_577) ?? Data()
        guard data.count <= 1_048_576 else { throw PackageError.invalid }
        return data
    }
    private func registration(pluginID: String) -> PluginRegistration {
        guard let data = try? read(codexDirectory.appendingPathComponent("config.toml"), within: codexDirectory),
              let config = String(data: data, encoding: .utf8) else { return .unknown }
        var matching = false
        for raw in config.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("[") {
                matching = line == "[plugins.\"\(pluginID)\"]" || line == "[plugins.'\(pluginID)']"
            } else if matching {
                if line.range(of: "^enabled\\s*=\\s*true\\s*(?:#.*)?$", options: .regularExpression) != nil { return .enabled }
                if line.range(of: "^enabled\\s*=\\s*false\\s*(?:#.*)?$", options: .regularExpression) != nil { return .disabled }
            }
        }
        return .notFound
    }
}
