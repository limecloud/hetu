import Foundation

public struct SourceSelection: Equatable, Sendable {
    public let id = UUID()
    public let range: NSRange
    // UTF-8 半开区间可落在组合字符内部；按 Unicode 标量核验，转换为 TextKit 的 UTF-16 坐标。
    public init?(content: String, byteStart: Int, byteEnd: Int, quote: String) {
        let bytes = Array(content.utf8)
        guard byteStart >= 0, byteEnd > byteStart, byteEnd <= bytes.count,
              let prefix = String(bytes: bytes[..<byteStart], encoding: .utf8),
              let selected = String(bytes: bytes[byteStart..<byteEnd], encoding: .utf8), selected == quote else { return nil }
        self.range = NSRange(location: prefix.utf16.count, length: selected.utf16.count)
    }
}

public struct SourceSpan: Equatable, Sendable {
    public let byteStart: Int
    public let byteEnd: Int
    public let quote: String
    public init?(content: String, selection: NSRange, allowEmpty: Bool = false) {
        let utf16 = content.utf16
        guard selection.location >= 0, selection.length >= 0,
              (allowEmpty || selection.length > 0), selection.location <= utf16.count,
              selection.length <= utf16.count - selection.location,
              let start = utf16.index(utf16.startIndex, offsetBy: selection.location).samePosition(in: content.unicodeScalars),
              let end = utf16.index(utf16.startIndex, offsetBy: selection.location + selection.length).samePosition(in: content.unicodeScalars) else { return nil }
        // 空插入点也必须落在标量边界，不能将 UTF-16 代理对中间的位置转换为字节区间。
        byteStart = content[..<start].utf8.count
        byteEnd = content[..<end].utf8.count
        quote = String(content[start..<end])
    }
}
