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
    public var id: String { workspaceID }
}

public actor LibraryStore {
    private struct Catalog: Codable {
        var schemaVersion = "1.0.0"
        var entries: [LibraryEntry] = []
    }
    public let directory: URL
    public init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Hetu/Library", isDirectory: true)
    }

    public func entries() throws -> [LibraryEntry] {
        try locked { try read().entries.sorted { $0.lastOpenedAt > $1.lastOpenedAt } }
    }

    public func register(url: URL, workspaceID: String, metadata: JSONValue, chapterCount: Int, opened: Bool = true, cover: JSONValue = .null) throws -> [LibraryEntry] {
        guard validID(workspaceID), url.isFileURL else { throw LibraryError.invalidRecord }
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
                coverAuthor: cover["cover"]["presentation"]["author_overlay"].string)
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
        let catalog = try decoder.decode(Catalog.self, from: handle.read(upToCount: 16 * 1024 * 1024 + 1) ?? Data())
        guard catalog.schemaVersion == "1.0.0", catalog.entries.allSatisfy({ validID($0.workspaceID) }),
              Set(catalog.entries.map(\.workspaceID)).count == catalog.entries.count else { throw LibraryError.invalidRecord }
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
    public enum LibraryError: Error { case invalidRecord, unavailable, busy, duplicateWorkspace, wrongWorkspace }
}
