import Foundation
import Darwin
import HetuCore

/// 本机创作库只登记作者选择的对象，资料是可刷新的投影，作品文件仍是事实源。
public struct LibraryEntry: Codable, Identifiable, Sendable, Equatable {
    public let workspaceID: String
    public let location: Data
    public let path: String
    public let title: String
    public let authorName: String
    public let genre: String
    public let status: String
    public let chapterCount: Int
    public let lastOpenedAt: Date?
    public let coverPreview: Data?
    public let coverTitle: String?
    public let coverAuthor: String?
    public let workType: String?
    public let createdAt: String?
    public let updatedAt: String?
    public var workReference: WorkReference? = nil
    public var contentType: String { workType ?? "novel" }
    public var id: String { workReference?.id ?? workspaceID }
}

public actor LibraryStore {
    private struct Catalog: Codable {
        var schemaVersion = "1.0.0"
        var entries: [LibraryEntry] = []
        var pendingDeletion: TrashIntent?
        var removedEntries: [String]?
    }
    private struct TrashIntent: Codable {
        let entry: LibraryEntry
        let device: Int32
        let inode: UInt64
        let trashDirectory: URL
    }
    public let directory: URL
    private let collaborationDirectory: URL?
    public init(directory: URL? = nil, collaborationDirectory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Hetu/Library", isDirectory: true)
        self.collaborationDirectory = collaborationDirectory
    }

    public func entries() throws -> [LibraryEntry] {
        try locked { try read().entries.sorted(by: Self.recentFirst) }
    }

    private static func recentFirst(_ lhs: LibraryEntry, _ rhs: LibraryEntry) -> Bool {
        let left = lhs.lastOpenedAt ?? .distantPast, right = rhs.lastOpenedAt ?? .distantPast
        return left != right ? left > right : lhs.id < rhs.id
    }

    /// 只接纳当前客户端在有限新建范围创建的作品；不扫描目录，也不改最近打开记录。
    public func receiveCreatedWorks(collaborationDirectory: URL? = nil) async throws {
        var known = Set(try entries().map(\.id))
        for client in ["codex", "claude-code", "workbuddy", "generic"] {
            let bridge = CollaborationClient(clientAdapter: client, directory: collaborationDirectory ?? self.collaborationDirectory)
            var cursor: String?
            repeat {
                var input: [String: JSONValue] = ["limit": .integer(100)]
                if let cursor { input["cursor"] = .string(cursor) }
                let page = try await bridge.request("hetu.collaboration.created_works", input: input)
                guard page["status"].string == "succeeded" else { throw CoreError.business(page) }
                for work in page["data"]["works"].array {
                    guard let id = work["workspace_id"].string, let path = work["path"].string,
                          FileManager.default.fileExists(atPath: path) else { continue }
                    let scope = ["management_ref": work["management_ref"]]
                    let response = try await bridge.request("hetu.workspaces.get", input: scope)
                    // 撤权或目录已移走的历史接纳记录不能重新加入书库。
                    guard response["status"].string == "succeeded", response["data"]["workspace"]["workspace_id"].string == id else { continue }
                    var workCursor: String?
                    repeat {
                        var input = scope; input["limit"] = .integer(100)
                        if let workCursor { input["cursor"] = .string(workCursor) }
                        let listed = try await bridge.request("hetu.works.list", input: input).requiringSuccess()
                        for summary in listed["works"].array {
                            let reference = try WorkReference(summary["work_ref"])
                            let removed = try locked { try read().removedEntries?.contains(reference.id) == true }
                            guard !known.contains(reference.id), !removed else { continue }
                            var metadata: JSONValue = .object(["title": summary["title"]])
                            var count = 0
                            if reference.kind == "novel" {
                                let novel = try await bridge.request("hetu.novels.get", input: scope).requiringSuccess()
                                metadata = novel["novel"]["metadata"]; count = novel["novel"]["chapters"].array.count
                            }
                            _ = try register(url: URL(fileURLWithPath: path), workspaceID: id, metadata: metadata,
                                chapterCount: count, opened: false, workType: reference.kind, properties: summary, workReference: reference)
                            known.insert(reference.id)
                        }
                        workCursor = listed["next_cursor"].string
                    } while workCursor != nil
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
            let summary: JSONValue
            if let reference = entry.workReference {
                guard let work = try? await workspace.data("hetu.works.get", input: ["work_ref": reference.value]) else { continue }
                summary = work["summary"]
            } else { summary = info["properties"] }
            try locked {
                var catalog = try read()
                guard let index = catalog.entries.firstIndex(where: { $0.id == entry.id && $0.path == entry.path }) else { return }
                let current = catalog.entries[index]
                let created = summary["created_at"].string, updated = summary["updated_at"].string
                guard created != current.createdAt || updated != current.updatedAt else { return }
                catalog.entries[index] = LibraryEntry(workspaceID: current.workspaceID, location: current.location, path: current.path,
                    title: current.title, authorName: current.authorName, genre: current.genre, status: current.status, chapterCount: current.chapterCount,
                    lastOpenedAt: current.lastOpenedAt, coverPreview: current.coverPreview, coverTitle: current.coverTitle, coverAuthor: current.coverAuthor,
                    workType: current.workType, createdAt: created, updatedAt: updated, workReference: current.workReference)
                try write(catalog)
            }
        }
        return try entries()
    }

    public func register(url: URL, workspaceID: String, metadata: JSONValue, chapterCount: Int, opened: Bool = true, cover: JSONValue = .null, workType: String = "novel", properties: JSONValue = .null, workReference: WorkReference? = nil) throws -> [LibraryEntry] {
        guard validID(workspaceID), url.isFileURL, ["novel", "drama", "video"].contains(workType),
              workReference == nil || (workReference!.isValid && workReference!.workspaceID == workspaceID && workReference!.kind == workType) else { throw LibraryError.invalidRecord }
        let canonical = url.resolvingSymlinksInPath().standardizedFileURL
        let bookmark = try canonical.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        return try locked {
            var catalog = try read()
            let identity = workReference?.id ?? workspaceID
            if !opened, catalog.removedEntries?.contains(identity) == true { return catalog.entries.sorted(by: Self.recentFirst) }
            let previous = catalog.entries.first { $0.id == identity }
                ?? catalog.entries.first { $0.workspaceID == workspaceID && $0.workReference == nil && $0.contentType == workType }
            // 同一身份在不同位置的副本必须由作者明确决定；不能悄悄换掉书库引用。
            if let other = catalog.entries.first(where: { $0.workspaceID == workspaceID && $0.path != canonical.path }) {
                let oldURL = try? resolve(other)
                if let oldURL, oldURL.resolvingSymlinksInPath().path != canonical.path, FileManager.default.fileExists(atPath: oldURL.path) {
                    throw LibraryError.duplicateWorkspace
                }
            }
            let entry = LibraryEntry(workspaceID: workspaceID, location: bookmark, path: canonical.path,
                title: metadata["title"].string ?? canonical.lastPathComponent,
                authorName: metadata["author_name"].string ?? "", genre: metadata["genre"].string ?? "",
                status: metadata["status"].string ?? "planning", chapterCount: chapterCount,
                lastOpenedAt: opened ? Date() : previous?.lastOpenedAt,
                coverPreview: cover == .null ? previous?.coverPreview : cover["preview"]["base64"].string.flatMap { Data(base64Encoded: $0) },
                coverTitle: cover == .null ? previous?.coverTitle : cover["cover"]["presentation"]["title_overlay"].string,
                coverAuthor: cover == .null ? previous?.coverAuthor : cover["cover"]["presentation"]["author_overlay"].string, workType: workType,
                createdAt: properties == .null ? previous?.createdAt : properties["created_at"].string,
                updatedAt: properties == .null ? previous?.updatedAt : properties["updated_at"].string, workReference: workReference)
            catalog.entries.removeAll { $0.id == identity || ($0.workspaceID == workspaceID && $0.workReference == nil && $0.contentType == workType) }
            catalog.removedEntries?.removeAll { $0 == identity }
            catalog.entries.append(entry)
            try write(catalog)
            return catalog.entries.sorted(by: Self.recentFirst)
        }
    }

    /// 只移除本机登记，不改变作品文件、关联、任务或其他对象。
    public func removeRegistration(_ entry: LibraryEntry) throws -> [LibraryEntry] {
        try locked {
            var catalog = try read()
            catalog.entries.removeAll { $0.id == entry.id }
            var removed = Set(catalog.removedEntries ?? []); removed.insert(entry.id)
            catalog.removedEntries = removed.sorted()
            try write(catalog)
            return catalog.entries.sorted(by: Self.recentFirst)
        }
    }
    public func finishObjectAdmission(workspaceID: String) throws -> [LibraryEntry] {
        try locked {
            var catalog = try read()
            if catalog.entries.contains(where: { $0.workspaceID == workspaceID && $0.workReference != nil }) {
                let count = catalog.entries.count
                catalog.entries.removeAll { $0.workspaceID == workspaceID && $0.workReference == nil }
                if count != catalog.entries.count { try write(catalog) }
            }
            return catalog.entries.sorted(by: Self.recentFirst)
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
        if try locked({ try read().entries.allSatisfy { $0.id != entry.id } }) { return try entries() }
        let url = try resolve(entry).standardizedFileURL
        let libraryPath = directory.resolvingSymlinksInPath().path
        guard url.path == entry.path, url.resolvingSymlinksInPath().path == entry.path,
              libraryPath != url.path, !libraryPath.hasPrefix(url.path + "/") else { throw LibraryError.changedWork }
        let lease = try WorkspaceTrashLease(url: url)
        defer { withExtendedLifetime(lease) {} }
        let workspace = try await Workspace.open(at: url, mode: .author)
        let info = try await workspace.data("hetu.workspaces.get")
        let objects = try await WorkCatalog.list(in: workspace, includeArchived: true)
        guard objects.count <= 1 else { throw LibraryError.multipleWorks }
        if let reference = entry.workReference {
            guard objects.first?["work_ref"] == reference.value else { throw LibraryError.changedWork }
        }
        let novel = try await workspace.data("hetu.novels.get")
        let title = objects.first?["title"].string ?? (novel["initialized"].bool == true ? novel["novel"]["metadata"]["title"].string : info["workspace"]["title"].string)
        guard info["workspace"]["workspace_id"].string == entry.workspaceID else { throw LibraryError.wrongWorkspace }
        let kind = objects.first?["work_ref"]["kind"].string ?? info["workspace"]["work_type"].string ?? "novel"
        guard title == entry.title, kind == entry.contentType else { throw LibraryError.changedWork }
        return try locked {
            var catalog = try read()
            guard let current = catalog.entries.first(where: { $0.id == entry.id }),
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
            return catalog.entries.sorted(by: Self.recentFirst)
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
        guard catalog.schemaVersion == "1.0.0", catalog.entries.allSatisfy({ validID($0.workspaceID) && ($0.workReference == nil || ($0.workReference!.isValid && $0.workReference!.workspaceID == $0.workspaceID && $0.workReference!.kind == $0.contentType)) }),
              Set(catalog.entries.map(\.id)).count == catalog.entries.count else { throw LibraryError.invalidRecord }
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
    public enum LibraryError: Error { case invalidRecord, unavailable, busy, duplicateWorkspace, wrongWorkspace, confirmationMismatch, changedWork, deletionPending, multipleWorks }
}
