import Darwin
import Foundation

/// 删除期间与 Core 共用作品写入锁；只允许移动本次核验的同一个目录。
final class WorkspaceTrashLease: Sendable {
    let url: URL
    let device: Int32
    let inode: UInt64
    private let root: Int32
    private let lock: Int32

    init(url: URL) throws {
        let root = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard root >= 0 else { throw LibraryStore.LibraryError.unavailable }
        let managed = openat(root, ".hetu", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard managed >= 0 else { Darwin.close(root); throw LibraryStore.LibraryError.invalidRecord }
        let lock = openat(managed, "workspace.lock", O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
        Darwin.close(managed)
        var metadata = stat(), directory = stat()
        guard lock >= 0, fstat(root, &directory) == 0, fstat(lock, &metadata) == 0,
              metadata.st_nlink == 1, metadata.st_mode & S_IFMT == S_IFREG else {
            if lock >= 0 { Darwin.close(lock) }; Darwin.close(root)
            throw LibraryStore.LibraryError.invalidRecord
        }
        guard flock(lock, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(lock); Darwin.close(root); throw LibraryStore.LibraryError.busy
        }
        self.url = url; self.root = root; self.lock = lock
        device = directory.st_dev; inode = directory.st_ino
    }
    deinit { flock(lock, LOCK_UN); Darwin.close(lock); Darwin.close(root) }
    func verifyLocation() throws {
        guard Self.matches(url, device: device, inode: inode) else { throw LibraryStore.LibraryError.changedWork }
    }
    static func matches(_ url: URL, device: Int32, inode: UInt64) -> Bool {
        var metadata = stat()
        return lstat(url.path, &metadata) == 0 && metadata.st_mode & S_IFMT == S_IFDIR
            && metadata.st_dev == device && metadata.st_ino == inode
    }
}
