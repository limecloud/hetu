import Foundation

public struct ScreenplayParagraph: Equatable, Sendable {
    public enum Kind: Sendable { case metadata, scene, action, character, parenthetical, dialogue, transition, section, note }
    public let kind: Kind
    public let text: String
}

/// 只投影可读段落，不重写 Fountain 原稿。未知语法保留为动作文字。
public enum ScreenplayReading {
    public static func paragraphs(_ source: String) -> [ScreenplayParagraph] {
        var result: [ScreenplayParagraph] = []
        var dialogue = false, titlePage = true, comment = false
        let metadata = ["title:", "credit:", "author:", "authors:", "source:", "draft date:", "date:", "contact:", "copyright:", "notes:", "episode:", "language:"]
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        for raw in lines.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { dialogue = false; if !result.isEmpty { titlePage = false }; continue }
            if titlePage && (metadata.contains(where: { line.lowercased().hasPrefix($0) }) || raw.hasPrefix("   ")) {
                result.append(.init(kind: .metadata, text: line)); continue
            }
            titlePage = false
            if comment || line.hasPrefix("/*") {
                result.append(.init(kind: .note, text: line)); comment = !line.contains("*/"); dialogue = false; continue
            }
            if line.hasPrefix("[[") || line.hasPrefix("=") { result.append(.init(kind: .note, text: line)); dialogue = false; continue }
            if line.hasPrefix("#") { result.append(.init(kind: .section, text: String(line.drop(while: { $0 == "#" || $0 == " " })))); dialogue = false; continue }
            if line.hasPrefix("@") {
                result.append(.init(kind: .character, text: String(line.dropFirst()))); dialogue = true; continue
            }
            let scene = ["INT.", "EXT.", "INT/EXT.", "I/E.", "EST."].contains { line.uppercased().hasPrefix($0) }
            if scene || (line.hasPrefix(".") && !line.hasPrefix("..")) {
                result.append(.init(kind: .scene, text: line.hasPrefix(".") ? String(line.dropFirst()) : line)); dialogue = false; continue
            }
            if line.hasPrefix(">") || line.hasSuffix("TO:") { result.append(.init(kind: .transition, text: line)); dialogue = false; continue }
            if line.hasPrefix("!") { result.append(.init(kind: .action, text: String(line.dropFirst()))); dialogue = false; continue }
            if dialogue {
                result.append(.init(kind: line.hasPrefix("(") || line.hasPrefix("（") ? .parenthetical : .dialogue, text: line))
            } else {
                let character = line == line.uppercased() && line != line.lowercased() && line.count < 60 && !line.hasSuffix(".")
                result.append(.init(kind: character ? .character : .action, text: line)); dialogue = character
            }
        }
        return result
    }
}
