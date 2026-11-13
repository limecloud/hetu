import Foundation

public struct RevisionDifference: Sendable {
    public struct Change: Sendable, Identifiable {
        public let line: Int
        public let text: String
        public let added: Bool
        public var id: String { "\(added)-\(line)" }
    }
    public let changes: [Change]
    public let totalChanges: Int
    public let withinBudget: Bool
    public static func compare(before: String, after: String) -> Self {
        let old = before.isEmpty ? [] : before.components(separatedBy: "\n")
        let new = after.isEmpty ? [] : after.components(separatedBy: "\n")
        guard old.count <= 3000, new.count <= 3000 else { return Self(changes: [], totalChanges: 0, withinBudget: false) }
        let difference = new.difference(from: old)
        let changes = difference.map { item -> Change in
            switch item {
            case .insert(let offset, let text, _): return Change(line: offset + 1, text: text, added: true)
            case .remove(let offset, let text, _): return Change(line: offset + 1, text: text, added: false)
            }
        }.sorted { a, b in a.added == b.added ? a.line < b.line : !a.added }
        return Self(changes: Array(changes.prefix(400)), totalChanges: changes.count, withinBudget: true)
    }
}
