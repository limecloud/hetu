import Foundation
import HetuCore

public struct Localizer: Sendable {
    public let locale: String
    private struct Entry: Decodable, Sendable {
        let chinese: String
        let english: String
        enum CodingKeys: String, CodingKey { case chinese = "zh-CN", english = "en" }
    }
    private static let entries: [String: Entry] = {
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("Hetu_HetuNative.bundle")
        let resources = bundled.flatMap { Bundle(url: $0) } ?? Bundle.module
        guard let url = resources.url(forResource: "NativeStrings", withExtension: "json"),
              let bytes = try? Data(contentsOf: url),
              let entries = try? JSONDecoder().decode([String: Entry].self, from: bytes) else { return [:] }
        return entries
    }()
    public init(locale: String) { self.locale = locale == "en" ? "en" : "zh-CN" }
    public func hasTranslation(for key: String) -> Bool { Self.entries[key] != nil }
    public func text(_ key: String, _ values: [String: String] = [:]) -> String {
        guard let entry = Self.entries[key] else {
            return locale == "en" ? "Unable to display this message." : "无法显示此消息。"
        }
        var text = locale == "en" ? entry.english : entry.chinese
        for (name, value) in values { text = text.replacingOccurrences(of: "{\(name)}", with: value) }
        return text
    }
    public func error(_ error: any Error) -> String {
        if let libraryError = error as? LibraryStore.LibraryError {
            let key: String = switch libraryError {
            case .invalidRecord: "error.library.invalidRecord"
            case .unavailable: "error.library.unavailable"
            case .busy: "error.library.busy"
            case .duplicateWorkspace: "error.library.duplicateWorkspace"
            case .wrongWorkspace: "error.library.wrongWorkspace"
            }
            return text(key)
        }
        if case CoreError.business(let result) = error,
           let code = result["error"]["code"].string,
           Self.entries["error.\(code)"] != nil { return text("error.\(code)") }
        return text("error.generic")
    }
    public func byteCount(_ count: Int64) -> String {
        count.formatted(.byteCount(style: .file).locale(Locale(identifier: locale)))
    }
    public func date(_ raw: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = parser.date(from: raw)
        if date == nil { parser.formatOptions = [.withInternetDateTime]; date = parser.date(from: raw) }
        guard let date else { return raw }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: locale)
        formatter.dateStyle = .short; formatter.timeStyle = .medium
        return formatter.string(from: date)
    }
}
