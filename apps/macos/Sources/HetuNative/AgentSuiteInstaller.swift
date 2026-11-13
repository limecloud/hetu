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
    public static func findCodex(searchPath: String? = nil) -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let environmentPath = searchPath ?? ProcessInfo.processInfo.environment["PATH"] ?? ""
        let directories = environmentPath.components(separatedBy: ":").filter { $0.hasPrefix("/") }.map { URL(fileURLWithPath: $0) }
        let paths = directories.map { $0.appendingPathComponent("codex") }
        let candidates = paths + [home.appendingPathComponent(".bun/bin/codex"), home.appendingPathComponent(".local/bin/codex"),
            URL(fileURLWithPath: "/opt/homebrew/bin/codex"), URL(fileURLWithPath: "/usr/local/bin/codex"),
            URL(fileURLWithPath: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")]
        return candidates.first { hasInterpreter($0, searchDirectories: directories) }
    }
    /// 只做有界入口预检；插件命令和版本仍在作者点击安装后由官方 CLI 回执核验。
    private static func hasInterpreter(_ executable: URL, searchDirectories: [URL]) -> Bool {
        guard FileManager.default.isExecutableFile(atPath: executable.path),
              let file = try? FileHandle(forReadingFrom: executable) else { return false }
        defer { try? file.close() }
        guard let prefix = try? file.read(upToCount: 4096), !prefix.isEmpty else { return false }
        guard prefix.starts(with: [0x23, 0x21]) else { return true }
        let line = prefix.split(separator: 0x0A, maxSplits: 1).first!
        guard let text = String(data: Data(line.dropFirst(2)), encoding: .utf8) else { return false }
        let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard let interpreter = words.first, interpreter.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: interpreter) else { return false }
        if URL(fileURLWithPath: interpreter).lastPathComponent != "env" { return true }
        let arguments = Array(words.dropFirst())
        let name = arguments.first == "-S" ? arguments.dropFirst().first : arguments.first
        guard let name, !name.hasPrefix("-"), !name.contains("=") else { return false }
        if name.hasPrefix("/") { return FileManager.default.isExecutableFile(atPath: name) }
        return searchDirectories.contains { FileManager.default.isExecutableFile(atPath: $0.appendingPathComponent(name).path) }
    }
    public func installCodex(suite: AgentSuite, catalog: AgentSuiteCatalog) throws -> AgentInstallReceipt {
        guard let codexExecutable else { throw AgentInstallError.clientUnavailable }
        let source = catalog.directory(for: suite)
        let inspected = AgentPackageInspector(codexDirectory: codexDirectory).inspect(suite: suite, catalog: catalog, client: .codex, selectedDirectory: source)
        guard inspected.state == .filesFound, let version = inspected.version else { throw AgentInstallError.invalidPackage }
        // 市场来源保持稳定；历史按版本登记的来源继续作为受管根，不移除或重建作者登记。
        let marketName = "hetu-luoshu-" + suite.id
        let market = try codexMarket(suite: suite, executable: codexExecutable)
        let manifestURL = market.appendingPathComponent(".agents/plugins/marketplace.json")
        let previousManifest = try existingCodexManifest(at: market, suite: suite)
        let relativePackage = "./versions/\(version)/\(suite.pluginName)"
        let package = market.appendingPathComponent(relativePackage)
        guard package.resolvingSymlinksInPath().path.hasPrefix(market.resolvingSymlinksInPath().path + "/"),
              manifestURL.resolvingSymlinksInPath().path.hasPrefix(market.resolvingSymlinksInPath().path + "/") else { throw AgentInstallError.destinationConflict }
        try FileManager.default.createDirectory(at: package.deletingLastPathComponent(), withIntermediateDirectories: true)
        // 同版本内容不得静默覆盖；失败后保留原现场，可从官方登记回读恢复。
        if FileManager.default.fileExists(atPath: package.path) {
            guard try fingerprint(source) == fingerprint(package) else { throw AgentInstallError.destinationConflict }
        } else {
            let incoming = market.appendingPathComponent(".hetu-install-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: incoming) }
            try FileManager.default.copyItem(at: source, to: incoming)
            try FileManager.default.moveItem(at: incoming, to: package)
        }
        try FileManager.default.createDirectory(at: manifestURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let bytes = try marketplaceManifest(suite: suite, path: relativePackage)
        if let previousManifest {
            guard try Data(contentsOf: manifestURL) == previousManifest else { throw AgentInstallError.destinationConflict }
        } else if FileManager.default.fileExists(atPath: manifestURL.path) { throw AgentInstallError.destinationConflict }
        if previousManifest != bytes { try bytes.write(to: manifestURL, options: .atomic) }
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
    private func codexMarket(suite: AgentSuite, executable: URL) throws -> URL {
        let root = supportDirectory.appendingPathComponent("codex/" + suite.id).resolvingSymlinksInPath().standardizedFileURL
        let listed = try command(executable, ["plugin", "marketplace", "list", "--json"])
        guard let records = listed["marketplaces"] as? [[String: Any]] else { throw AgentInstallError.verificationFailed }
        let matches = records.filter { $0["name"] as? String == "hetu-luoshu-" + suite.id }
        guard !matches.isEmpty else { return root }
        guard matches.count == 1, let path = matches[0]["root"] as? String, path.hasPrefix("/"),
              let source = matches[0]["marketplaceSource"] as? [String: Any], source["sourceType"] as? String == "local",
              let sourcePath = source["source"] as? String, sourcePath.hasPrefix("/") else { throw AgentInstallError.destinationConflict }
        let market = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
        let legacy = market.deletingLastPathComponent() == root && validVersion(market.lastPathComponent)
        guard (market == root || legacy), market == URL(fileURLWithPath: sourcePath).resolvingSymlinksInPath().standardizedFileURL,
              FileManager.default.fileExists(atPath: market.appendingPathComponent(".agents/plugins/marketplace.json").path) else { throw AgentInstallError.destinationConflict }
        return market
    }
    /// 只切换河图生成的单套件清单；额外字段、不同来源和作者改动都保留为冲突。
    private func existingCodexManifest(at market: URL, suite: AgentSuite) throws -> Data? {
        let file = market.appendingPathComponent(".agents/plugins/marketplace.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        guard file.resolvingSymlinksInPath().path.hasPrefix(market.path + "/") else { throw AgentInstallError.destinationConflict }
        let object = try installationJSON(file)
        guard let plugins = object["plugins"] as? [[String: Any]], plugins.count == 1,
              let source = plugins[0]["source"] as? [String: Any], let path = source["path"] as? String else { throw AgentInstallError.destinationConflict }
        let parts = path.components(separatedBy: "/")
        let versioned = parts.count == 4 && parts[0] == "." && parts[1] == "versions" && validVersion(parts[2]) && parts[3] == suite.pluginName
        let legacy = path == "./" + suite.pluginName && validVersion(market.lastPathComponent)
        guard versioned || legacy,
              try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) == marketplaceManifest(suite: suite, path: path) else { throw AgentInstallError.destinationConflict }
        let package = market.appendingPathComponent(path)
        guard package.resolvingSymlinksInPath().path.hasPrefix(market.path + "/") else { throw AgentInstallError.destinationConflict }
        let manifest = try installationJSON(package.appendingPathComponent("plugin.json"))
        let identity = try installationJSON(package.appendingPathComponent("hetu-suite.json"))
        guard manifest["name"] as? String == suite.pluginName, let version = manifest["version"] as? String, validVersion(version),
              identity["schema_version"] as? String == "1.0.0", identity["suite_id"] as? String == suite.id,
              !versioned || parts[2] == version else { throw AgentInstallError.destinationConflict }
        let cached = codexDirectory.appendingPathComponent("plugins/cache/hetu-luoshu-\(suite.id)/\(suite.pluginName)/\(version)")
        if FileManager.default.fileExists(atPath: cached.path) {
            guard try fingerprint(package) == fingerprint(cached) else { throw AgentInstallError.destinationConflict }
        }
        return try Data(contentsOf: file)
    }
    private func marketplaceManifest(suite: AgentSuite, path: String) throws -> Data {
        let manifest: [String: Any] = ["name": "hetu-luoshu-" + suite.id, "plugins": [["name": suite.pluginName,
            "source": ["source": "local", "path": path],
            "policy": ["installation": "AVAILABLE", "authentication": "ON_INSTALL"], "category": "Productivity"]]]
        return try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
    }
    private func validVersion(_ version: String) -> Bool {
        version.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$", options: .regularExpression) != nil
    }
    private func installationJSON(_ file: URL) throws -> [String: Any] {
        let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, let size = values.fileSize, size < 2_097_152,
              let object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any] else { throw AgentInstallError.destinationConflict }
        return object
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
