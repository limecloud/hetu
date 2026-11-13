import Foundation
import Darwin
import CryptoKit
import HetuCore

public struct PendingStructureOperation: Codable, Sendable, Equatable, Identifiable {
    public let workspaceID: String
    public let action: String
    public let input: [String: JSONValue]
    public var id: String { input["operation_key"]?.string ?? "" }
    public init(workspaceID: String, action: String, input: [String: JSONValue]) {
        self.workspaceID = workspaceID; self.action = action; self.input = input
    }
}

public struct PendingSave: Codable, Equatable, Sendable {
    public var operationKey: String
    public var baseRevisionID: String
    public var content: String
    public init(operationKey: String, baseRevisionID: String, content: String) {
        self.operationKey = operationKey; self.baseRevisionID = baseRevisionID; self.content = content
    }
}
public struct RecoveryEntry: Codable, Identifiable, Equatable, Sendable {
    public let id: UUID
    public let workspaceID: String
    public let documentID: String
    public let windowID: UUID
    public let baseRevisionID: String
    public let title: String
    public let content: String
    public let updatedAt: Date
    public let pendingSave: PendingSave?

    public init(workspaceID: String, documentID: String, windowID: UUID, baseRevisionID: String, title: String, content: String, pendingSave: PendingSave? = nil) {
        self.id = windowID
        self.workspaceID = workspaceID
        self.documentID = documentID
        self.windowID = windowID
        self.baseRevisionID = baseRevisionID
        self.title = title
        self.content = content
        self.updatedAt = Date()
        self.pendingSave = pendingSave
    }
}

public actor RecoveryStore {
    public let directory: URL
    public init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Hetu/Recovery", isDirectory: true)
    }
    private func file(_ entry: RecoveryEntry) throws -> URL {
        // 技术标识来自内核；不允许标题、用户路径或文件名参与恢复路径构造。
        guard entry.workspaceID.hasPrefix("workspace_"), entry.documentID.hasPrefix("doc_"),
              UUID(uuidString: String(entry.workspaceID.dropFirst(10))) != nil,
              UUID(uuidString: String(entry.documentID.dropFirst(4))) != nil else { throw RecoveryError.invalidIdentity }
        return directory.appendingPathComponent("\(entry.workspaceID)_\(entry.documentID)_\(entry.windowID.uuidString).json")
    }
    public func write(_ entry: RecoveryEntry) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = try file(entry)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(entry)
        try writeData(data, to: url)
    }
    private func writeData(_ data: Data, to url: URL) throws {
        guard data.count <= 32 * 1024 * 1024 else { throw RecoveryError.invalidRecord }
        try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
        let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard descriptor >= 0 else { throw RecoveryError.syncFailed }
        defer { Darwin.close(descriptor) }
        guard fsync(descriptor) == 0 else { throw RecoveryError.syncFailed }
    }
    private func operationFile(_ operation: PendingStructureOperation) throws -> URL {
        guard operation.workspaceID.hasPrefix("workspace_"), UUID(uuidString: String(operation.workspaceID.dropFirst(10))) != nil,
              ["hetu.documents.create", "hetu.documents.validate", "hetu.documents.finalize", "hetu.documents.withdraw_finalization", "hetu.novels.initialize", "hetu.novels.update", "hetu.novels.save_structure", "hetu.drama.build_skeleton", "hetu.drama.edit_skeleton", "hetu.drama.compare", "hetu.drama.create_script", "hetu.drafts.submit", "hetu.drafts.submit_current", "hetu.drafts.adopt", "hetu.reviews.begin", "hetu.reviews.validate", "hetu.reviews.decide", "hetu.validation.run", "hetu.git.init", "hetu.git.snapshot", "hetu.git.approve_snapshot", "hetu.assets.import", "hetu.assets.update", "hetu.cues.save", "hetu.creative_tasks.prepare", "hetu.creative_tasks.mark_copied", "hetu.creative_tasks.inspect_inbox", "hetu.creative_tasks.close", "hetu.interactions.save_selection"].contains(operation.action), !operation.id.isEmpty else { throw RecoveryError.invalidRecord }
        let hash = SHA256.hash(data: Data((operation.action + "\0" + operation.id).utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("\(operation.workspaceID)_structure_\(hash).json")
    }
    public func writeOperation(_ operation: PendingStructureOperation) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = try operationFile(operation)
        if FileManager.default.fileExists(atPath: url.path) {
            let previous = try JSONDecoder().decode(PendingStructureOperation.self, from: Data(contentsOf: url))
            guard previous == operation else { throw RecoveryError.invalidRecord }
        }
        try writeData(JSONEncoder().encode(operation), to: url)
    }
    public func structureOperations(workspaceID: String) throws -> [PendingStructureOperation] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        var result: [PendingStructureOperation] = []
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]) where url.lastPathComponent.hasPrefix(workspaceID + "_structure_") && url.pathExtension == "json" {
            let meta = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard meta.isRegularFile == true, meta.isSymbolicLink != true, (meta.fileSize ?? Int.max) <= 32 * 1024 * 1024 else { throw RecoveryError.invalidRecord }
            let operation = try JSONDecoder().decode(PendingStructureOperation.self, from: Data(contentsOf: url))
            guard operation.workspaceID == workspaceID, try operationFile(operation).lastPathComponent == url.lastPathComponent else { throw RecoveryError.invalidRecord }
            result.append(operation)
        }
        return result.sorted { $0.id < $1.id }
    }
    public func removeOperation(_ operation: PendingStructureOperation) throws {
        let url = try operationFile(operation)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        guard try JSONDecoder().decode(PendingStructureOperation.self, from: Data(contentsOf: url)) == operation else { throw RecoveryError.invalidRecord }
        try FileManager.default.removeItem(at: url)
    }
    public func list(workspaceID: String, documentID: String) throws -> [RecoveryEntry] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        let prefix = "\(workspaceID)_\(documentID)_"
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        var entries: [RecoveryEntry] = []
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]) where url.lastPathComponent.hasPrefix(prefix) && url.pathExtension == "json" {
            let meta = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard meta.isRegularFile == true, meta.isSymbolicLink != true, (meta.fileSize ?? Int.max) <= 32 * 1024 * 1024 else { throw RecoveryError.invalidRecord }
            let entry = try decoder.decode(RecoveryEntry.self, from: Data(contentsOf: url))
            // FileManager 枚举可能将 /var 规范化为 /private/var；比较受管目录内的规范文件名。
            guard entry.id == entry.windowID, entry.workspaceID == workspaceID, entry.documentID == documentID, try file(entry).lastPathComponent == url.lastPathComponent else { throw RecoveryError.invalidRecord }
            entries.append(entry)
        }
        return entries.sorted { $0.updatedAt > $1.updatedAt }
    }
    public func remove(_ entry: RecoveryEntry, ifContentMatches content: String) throws {
        let url = try file(entry)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let stored = try decoder.decode(RecoveryEntry.self, from: Data(contentsOf: url))
        guard stored.content == content else { return }
        try FileManager.default.removeItem(at: url)
    }
    public enum RecoveryError: Error { case invalidIdentity, invalidRecord, syncFailed }
}
