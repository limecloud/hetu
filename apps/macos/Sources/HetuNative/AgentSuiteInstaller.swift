import Foundation
import CryptoKit

public enum AgentInstallError: Error {
    case clientUnavailable, invalidPackage, destinationConflict, commandFailed, verificationFailed
    public var key: String { "agent.install_error." + String(describing: self) }
}

public struct AgentInstallReceipt: Sendable {
    public let directory: URL
    public let version: String
}

/// 仅在作者点击安装后运行。官方 CLI 拥有 Codex 配置；河图不直接编辑其 TOML。
public struct AgentSuiteInstaller: Sendable {
    public let supportDirectory: URL
    public let codexDirectory: URL
    public let codexExecutable: URL?
    public init(supportDirectory: URL? = nil, codexDirectory: URL? = nil, codexExecutable: URL? = nil) {
        self.supportDirectory = supportDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Hetu/AgentPackages")
        self.codexDirectory = codexDirectory ?? ProcessInfo.processInfo.environment["CODEX_HOME"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex")
        self.codexExecutable = codexExecutable ?? Self.findCodex()
    }
    public static func findCodex() -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let paths = (ProcessInfo.processInfo.environment["PATH"] ?? "").components(separatedBy: ":").filter { $0.hasPrefix("/") }.map { URL(fileURLWithPath: $0).appendingPathComponent("codex") }
        let candidates = paths + [home.appendingPathComponent(".bun/bin/codex"), home.appendingPathComponent(".local/bin/codex"),
            URL(fileURLWithPath: "/opt/homebrew/bin/codex"), URL(fileURLWithPath: "/usr/local/bin/codex"),
            URL(fileURLWithPath: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }
    public func installCodex(suite: AgentSuite, catalog: AgentSuiteCatalog) throws -> AgentInstallReceipt {
        guard let codexExecutable else { throw AgentInstallError.clientUnavailable }
        let source = catalog.directory(for: suite)
        let inspected = AgentPackageInspector(codexDirectory: codexDirectory).inspect(suite: suite, catalog: catalog, client: .codex, selectedDirectory: source)
        guard inspected.state == .filesFound, let version = inspected.version else { throw AgentInstallError.invalidPackage }
        // 同版本内容不得静默覆盖；失败后保留原现场，可从官方登记回读恢复。
        let market = supportDirectory.appendingPathComponent("codex/\(suite.id)/\(version)")
        let package = market.appendingPathComponent(suite.pluginName)
        try FileManager.default.createDirectory(at: market, withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: package.path) {
            guard try fingerprint(source) == fingerprint(package) else { throw AgentInstallError.destinationConflict }
        } else {
            let incoming = market.appendingPathComponent(".hetu-install-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: incoming) }
            try FileManager.default.copyItem(at: source, to: incoming)
            try FileManager.default.moveItem(at: incoming, to: package)
        }
        let marketName = "hetu-luoshu-" + suite.id
        let manifest: [String: Any] = ["name": marketName, "plugins": [["name": suite.pluginName,
            "source": ["source": "local", "path": "./" + suite.pluginName],
            "policy": ["installation": "AVAILABLE", "authentication": "ON_INSTALL"], "category": "Productivity"]]]
        let directory = market.appendingPathComponent(".agents/plugins")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let bytes = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
        let manifestURL = directory.appendingPathComponent("marketplace.json")
        if FileManager.default.fileExists(atPath: manifestURL.path) {
            guard try Data(contentsOf: manifestURL) == bytes else { throw AgentInstallError.destinationConflict }
        } else { try bytes.write(to: manifestURL, options: .atomic) }
        _ = try command(codexExecutable, ["plugin", "marketplace", "add", market.path, "--json"])
        let installed = try command(codexExecutable, ["plugin", "add", suite.pluginName + "@" + marketName, "--json"])
        let listed = try command(codexExecutable, ["plugin", "list", "--marketplace", marketName, "--json"])
        guard let records = listed["installed"] as? [[String: Any]],
              records.contains(where: { $0["pluginId"] as? String == suite.pluginName + "@" + marketName && $0["installed"] as? Bool == true && $0["enabled"] as? Bool == true && $0["version"] as? String == version }),
              let path = installed["installedPath"] as? String else { throw AgentInstallError.verificationFailed }
        let destination = URL(fileURLWithPath: path, isDirectory: true)
        guard destination.resolvingSymlinksInPath().path.hasPrefix(codexDirectory.resolvingSymlinksInPath().path + "/plugins/cache/") else { throw AgentInstallError.verificationFailed }
        guard try fingerprint(source) == fingerprint(destination) else { throw AgentInstallError.verificationFailed }
        return AgentInstallReceipt(directory: destination, version: version)
    }
    /// WorkBuddy 5.2.6 的个人 Skills 扫描递归读取 configDir/skills；不改它的账号或启用配置。
    public func installWorkBuddy(suite: AgentSuite, catalog: AgentSuiteCatalog, configDirectory: URL = AgentPackageInspector.defaultWorkbuddyDirectory) throws -> AgentInstallReceipt {
        let inspected = AgentPackageInspector(codexDirectory: codexDirectory).inspect(suite: suite, catalog: catalog, client: .codex, selectedDirectory: catalog.directory(for: suite))
        guard inspected.state == .filesFound, let version = inspected.version else { throw AgentInstallError.invalidPackage }
        let root = configDirectory.appendingPathComponent("skills")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let destination = root.appendingPathComponent(suite.pluginName)
        let stage = supportDirectory.appendingPathComponent("workbuddy-staging/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: stage.deletingLastPathComponent(), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stage) }
        try FileManager.default.copyItem(at: catalog.directory(for: suite), to: stage)
        for method in catalog.skills {
            let file = stage.appendingPathComponent("skills/\(method)/SKILL.md")
            let source = try String(contentsOf: file, encoding: .utf8)
            let adapted = source.replacingOccurrences(of: "\nname: \(method)\n", with: "\nname: \(suite.skillName(method, client: .workbuddy))\n")
            try Data(adapted.utf8).write(to: file, options: .atomic)
        }
        let identity: [String: Any] = ["schema_version": "1.0.0", "suite_id": suite.id, "adapter": "workbuddy"]
        try JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys]).write(to: stage.appendingPathComponent("hetu-suite.json"), options: .atomic)
        if FileManager.default.fileExists(atPath: destination.path) {
            guard try fingerprint(stage) == fingerprint(destination) else { throw AgentInstallError.destinationConflict }
        } else {
            // 临时目录与目标可能跨卷；先在目标文件系统复制，再原子安装完整包。
            let incoming = root.appendingPathComponent(".hetu-install-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: incoming) }
            try FileManager.default.copyItem(at: stage, to: incoming)
            try FileManager.default.moveItem(at: incoming, to: destination)
        }
        guard try fingerprint(stage) == fingerprint(destination) else { throw AgentInstallError.verificationFailed }
        return AgentInstallReceipt(directory: destination, version: version)
    }
    private func command(_ executable: URL, _ arguments: [String]) throws -> [String: Any] {
        let process = Process(), output = Pipe()
        process.executableURL = executable; process.arguments = arguments
        process.environment = ProcessInfo.processInfo.environment.merging(["CODEX_HOME": codexDirectory.path]) { _, value in value }
        process.standardOutput = output; process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        let timer = DispatchSource.makeTimerSource()
        timer.schedule(deadline: .now() + 45)
        timer.setEventHandler { if process.isRunning { process.terminate() } }; timer.resume()
        defer { timer.cancel() }
        try process.run()
        var bytes = Data()
        while let chunk = try output.fileHandleForReading.read(upToCount: 65_536), !chunk.isEmpty {
            bytes.append(chunk)
            if bytes.count > 2_097_152 { process.terminate(); throw AgentInstallError.commandFailed }
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw AgentInstallError.commandFailed }
        return object
    }
    private func fingerprint(_ root: URL) throws -> [String: String] {
        let canonical = root.resolvingSymlinksInPath().standardizedFileURL
        guard let files = FileManager.default.enumerator(at: canonical, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]) else { throw AgentInstallError.invalidPackage }
        var result: [String: String] = [:]
        for case let url as URL in files {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isSymbolicLink != true else { throw AgentInstallError.invalidPackage }
            if values.isRegularFile == true {
                guard let size = values.fileSize, size < 2_097_152 else { throw AgentInstallError.invalidPackage }
                let bytes = try Data(contentsOf: url)
                guard bytes.count < 2_097_152, result.count < 256 else { throw AgentInstallError.invalidPackage }
                // macOS 的目录枚举可能返回 /private/var，而根目录解析为 /var。
                let path = url.resolvingSymlinksInPath().standardizedFileURL.path
                guard path.hasPrefix(canonical.path + "/") else { throw AgentInstallError.invalidPackage }
                result[String(path.dropFirst(canonical.path.count + 1))] = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            }
        }
        return result
    }
}
