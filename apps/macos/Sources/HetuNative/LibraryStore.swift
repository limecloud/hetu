import Foundation
import Darwin
import HetuCore

/// 本机书库只登记作者选择的作品，资料是可刷新的投影，作品文件仍是事实源。
public struct LibraryEntry: Codable, Identifiable, Sendable, Equatable {
    public let workspaceID: String
    public let location: Data
    public let path: String
    public let title: String
    public let authorName: String
    public let genre: String
    public let status: String
    public let chapterCount: Int
    public let lastOpenedAt: Date
    public let coverPreview: Data?
    public let coverTitle: String?
    public let coverAuthor: String?
    public let workType: String?
    public let createdAt: String?
    public let updatedAt: String?
    public var contentType: String { workType ?? "novel" }
    public var id: String { workspaceID }
}

public actor LibraryStore {
    private struct Catalog: Codable {
        var schemaVersion = "1.0.0"
        var entries: [LibraryEntry] = []
        var pendingDeletion: TrashIntent?
    }
    private struct TrashIntent: Codable {
        let entry: LibraryEntry
        let device: Int32
        let inode: UInt64
        let trashDirectory: URL
    }
    public let directory: URL
    public init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Hetu/Library", isDirectory: true)
    }

    public func entries() throws -> [LibraryEntry] {
        try locked { try read().entries.sorted { $0.lastOpenedAt > $1.lastOpenedAt } }
    }

    /// 只接纳当前客户端在有限新建范围创建的作品；不扫描目录，也不改最近打开记录。
    public func receiveCreatedWorks(collaborationDirectory: URL? = nil) async throws {
        var known = Set(try entries().map(\.workspaceID))
        for client in ["codex", "claude-code", "workbuddy", "generic"] {
            let bridge = CollaborationClient(clientAdapter: client, directory: collaborationDirectory)
            var cursor: String?
            repeat {
                var input: [String: JSONValue] = ["limit": .integer(100)]
                if let cursor { input["cursor"] = .string(cursor) }
                let page = try await bridge.request("hetu.collaboration.created_works", input: input)
                guard page["status"].string == "succeeded" else { throw CoreError.business(page) }
                for work in page["data"]["works"].array {
                    guard let id = work["workspace_id"].string, !known.contains(id), let path = work["path"].string,
                          FileManager.default.fileExists(atPath: path) else { continue }
                    let scope = ["management_ref": work["management_ref"]]
                    let response = try await bridge.request("hetu.workspaces.get", input: scope)
                    // 撤权或目录已移走的历史接纳记录不能重新加入书库。
                    guard response["status"].string == "succeeded", response["data"]["workspace"]["workspace_id"].string == id else { continue }
                    let info = response["data"]
                    let novel = try await bridge.request("hetu.novels.get", input: scope)
                    guard novel["status"].string == "succeeded" else { throw CoreError.business(novel) }
                    let metadata = novel["data"]["initialized"].bool == true ? novel["data"]["novel"]["metadata"] : .object(["title": info["workspace"]["title"]])
                    _ = try register(url: URL(fileURLWithPath: path), workspaceID: id, metadata: metadata,
                        chapterCount: novel["data"]["novel"]["chapters"].array.count, opened: false,
                        workType: info["workspace"]["work_type"].string ?? "novel", properties: info["properties"])
                    known.insert(id)
                }
                cursor = page["data"]["next_cursor"].string
            } while cursor != nil
        }
    }

    /// 仅刷新已登记作品的时间投影；最近打开时间不随后台读取变化。
    public func refreshProperties() async throws -> [LibraryEntry] {
        for entry in try entries() {
            guard let url = try? resolve(entry),
                  let workspace = try? await Workspace.open(at: url, mode: .author),
                  let info = try? await workspace.data("hetu.workspaces.get"),
                  info["workspace"]["workspace_id"].string == entry.workspaceID else { continue }
            try locked {
                var catalog = try read()
                guard let index = catalog.entries.firstIndex(where: { $0.workspaceID == entry.workspaceID && $0.path == entry.path }) else { return }
                let current = catalog.entries[index]
                let created = info["properties"]["created_at"].string, updated = info["properties"]["updated_at"].string
                guard created != current.createdAt || updated != current.updatedAt else { return }
                catalog.entries[index] = LibraryEntry(workspaceID: current.workspaceID, location: current.location, path: current.path,
                    title: current.title, authorName: current.authorName, genre: current.genre, status: current.status, chapterCount: current.chapterCount,
                    lastOpenedAt: current.lastOpenedAt, coverPreview: current.coverPreview, coverTitle: current.coverTitle, coverAuthor: current.coverAuthor,
                    workType: current.workType, createdAt: created, updatedAt: updated)
                try write(catalog)
            }
        }
        return try entries()
    }

    public func register(url: URL, workspaceID: String, metadata: JSONValue, chapterCount: Int, opened: Bool = true, cover: JSONValue = .null, workType: String = "novel", properties: JSONValue = .null) throws -> [LibraryEntry] {
        guard validID(workspaceID), url.isFileURL, ["novel", "drama"].contains(workType) else { throw LibraryError.invalidRecord }
        let canonical = url.resolvingSymlinksInPath().standardizedFileURL
        let bookmark = try canonical.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        return try locked {
            var catalog = try read()
            let previous = catalog.entries.first { $0.workspaceID == workspaceID }
            // 同一身份在不同位置的副本必须由作者明确决定；不能悄悄换掉书库引用。
            if let previous, previous.path != canonical.path {
                let oldURL = try? resolve(previous)
                if let oldURL, oldURL.resolvingSymlinksInPath().path != canonical.path, FileManager.default.fileExists(atPath: oldURL.path) {
                    throw LibraryError.duplicateWorkspace
                }
            }
            let entry = LibraryEntry(workspaceID: workspaceID, location: bookmark, path: canonical.path,
                title: metadata["title"].string ?? canonical.lastPathComponent,
                authorName: metadata["author_name"].string ?? "", genre: metadata["genre"].string ?? "",
                status: metadata["status"].string ?? "planning", chapterCount: chapterCount,
                lastOpenedAt: opened ? Date() : previous?.lastOpenedAt ?? Date(),
                coverPreview: cover["preview"]["base64"].string.flatMap { Data(base64Encoded: $0) },
                coverTitle: cover["cover"]["presentation"]["title_overlay"].string,
                coverAuthor: cover["cover"]["presentation"]["author_overlay"].string, workType: workType,
                createdAt: properties == .null ? previous?.createdAt : properties["created_at"].string,
                updatedAt: properties == .null ? previous?.updatedAt : properties["updated_at"].string)
            catalog.entries.removeAll { $0.workspaceID == workspaceID }
            catalog.entries.append(entry)
            try write(catalog)
            return catalog.entries.sorted { $0.lastOpenedAt > $1.lastOpenedAt }
        }
    }

    public func resolve(_ entry: LibraryEntry) throws -> URL {
        guard validID(entry.workspaceID) else { throw LibraryError.invalidRecord }
        var stale = false
        let url = try URL(resolvingBookmarkData: entry.location, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale)
        guard url.isFileURL, FileManager.default.fileExists(atPath: url.path) else { throw LibraryError.unavailable }
        // 解析到移动后的目录时，由 Kernel 核对身份后重新登记书签。
        return url
    }

    /// 作者输入完整作品名后执行。失败或崩溃恢复只处理原目录身份，不重删同路径的新目录。
    public func trash(_ entry: LibraryEntry, confirmingTitle: String) async throws -> [LibraryEntry] {
        guard !entry.title.isEmpty, confirmingTitle == entry.title else { throw LibraryError.confirmationMismatch }
        // 先恢复上次已完成的移动，避免把重试变成第二次删除。
        if try locked({ try read().entries.allSatisfy { $0.workspaceID != entry.workspaceID } }) { return try entries() }
        let url = try resolve(entry).standardizedFileURL
        let libraryPath = directory.resolvingSymlinksInPath().path
        guard url.path == entry.path, url.resolvingSymlinksInPath().path == entry.path,
              libraryPath != url.path, !libraryPath.hasPrefix(url.path + "/") else { throw LibraryError.changedWork }
        let lease = try WorkspaceTrashLease(url: url)
        defer { withExtendedLifetime(lease) {} }
        let workspace = try await Workspace.open(at: url, mode: .author)
        let info = try await workspace.data("hetu.workspaces.get")
        let novel = try await workspace.data("hetu.novels.get")
        let title = novel["initialized"].bool == true ? novel["novel"]["metadata"]["title"].string : info["workspace"]["title"].string
        guard info["workspace"]["workspace_id"].string == entry.workspaceID else { throw LibraryError.wrongWorkspace }
        guard title == entry.title, (info["workspace"]["work_type"].string ?? "novel") == entry.contentType else { throw LibraryError.changedWork }
        return try locked {
            var catalog = try read()
            guard let current = catalog.entries.first(where: { $0.workspaceID == entry.workspaceID }),
                  current.path == entry.path, current.title == entry.title else { throw LibraryError.changedWork }
            try lease.verifyLocation()
            let trash = try FileManager.default.url(for: .trashDirectory, in: .userDomainMask, appropriateFor: url, create: true)
            catalog.pendingDeletion = TrashIntent(entry: current, device: lease.device, inode: lease.inode, trashDirectory: trash)
            try write(catalog)
            do {
                try lease.verifyLocation()
                try FileManager.default.trashItem(at: url, resultingItemURL: nil)
            } catch {
                guard WorkspaceTrashLease.matches(url, device: lease.device, inode: lease.inode) else { throw LibraryError.deletionPending }
                catalog.pendingDeletion = nil; try? write(catalog)
                throw error
            }
            catalog.entries.removeAll { $0.workspaceID == entry.workspaceID }
            catalog.pendingDeletion = nil
            do { try write(catalog) } catch { throw LibraryError.deletionPending }
            return catalog.entries.sorted { $0.lastOpenedAt > $1.lastOpenedAt }
        }
    }

    private func validID(_ value: String) -> Bool {
        value.hasPrefix("workspace_") && UUID(uuidString: String(value.dropFirst(10))) != nil
    }
    private func locked<T>(_ body: () throws -> T) throws -> T {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let lockURL = directory.appendingPathComponent("library.lock")
        let fd = Darwin.open(lockURL.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw LibraryError.unavailable }
        defer { Darwin.close(fd) }
        var meta = stat()
        guard fstat(fd, &meta) == 0, meta.st_nlink == 1, meta.st_mode & S_IFMT == S_IFREG,
              flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw LibraryError.busy }
        defer { flock(fd, LOCK_UN) }
        return try body()
    }
    private func read() throws -> Catalog {
        let url = directory.appendingPathComponent("library.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return Catalog() }
        let fd = Darwin.open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw LibraryError.invalidRecord }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var meta = stat()
        guard fstat(fd, &meta) == 0, meta.st_nlink == 1, meta.st_mode & S_IFMT == S_IFREG, meta.st_size <= 16 * 1024 * 1024 else { throw LibraryError.invalidRecord }
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        var catalog = try decoder.decode(Catalog.self, from: handle.read(upToCount: 16 * 1024 * 1024 + 1) ?? Data())
        guard catalog.schemaVersion == "1.0.0", catalog.entries.allSatisfy({ validID($0.workspaceID) }),
              Set(catalog.entries.map(\.workspaceID)).count == catalog.entries.count else { throw LibraryError.invalidRecord }
        if let intent = catalog.pendingDeletion {
            let original = URL(fileURLWithPath: intent.entry.path)
            if !WorkspaceTrashLease.matches(original, device: intent.device, inode: intent.inode) {
                var stale = false
                guard let moved = try? URL(resolvingBookmarkData: intent.entry.location, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale),
                      moved.standardizedFileURL.path.hasPrefix(intent.trashDirectory.standardizedFileURL.path + "/"),
                      WorkspaceTrashLease.matches(moved, device: intent.device, inode: intent.inode) else { throw LibraryError.deletionPending }
                catalog.entries.removeAll { $0.workspaceID == intent.entry.workspaceID }
            }
            catalog.pendingDeletion = nil
            try write(catalog)
        }
        return catalog
    }
    private func write(_ catalog: Catalog) throws {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(catalog)
        guard data.count <= 16 * 1024 * 1024 else { throw LibraryError.invalidRecord }
        let url = directory.appendingPathComponent("library.json")
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
        let fd = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard fd >= 0 else { throw LibraryError.unavailable }
        defer { Darwin.close(fd) }
        guard fsync(fd) == 0 else { throw LibraryError.unavailable }
    }
    public enum LibraryError: Error { case invalidRecord, unavailable, busy, duplicateWorkspace, wrongWorkspace, confirmationMismatch, changedWork, deletionPending }
}
