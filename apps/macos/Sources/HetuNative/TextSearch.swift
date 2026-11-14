import Foundation
import NaturalLanguage
import Observation
import HetuCore

public struct TextMatch: Identifiable, Sendable {
    public let range: NSRange
    public let quote: String
    public init(range: NSRange, quote: String) { self.range = range; self.quote = quote }
    public var id: String { "\(range.location):\(range.length)" }
}

public enum TextSearch {
    private static func valid(_ range: NSRange, in source: NSString) -> Bool {
        guard range.location >= 0, range.length > 0, range.location <= source.length,
              range.length <= source.length - range.location else { return false }
        func boundary(_ offset: Int) -> Bool {
            offset == source.length || !(0xDC00...0xDFFF).contains(source.character(at: offset))
        }
        return boundary(range.location) && boundary(NSMaxRange(range))
    }
    public static func matches(in text: String, query: String, words: Bool = false, caseSensitive: Bool = true, limit: Int = 5000) -> [TextMatch] {
        guard !query.isEmpty, limit > 0 else { return [] }
        var terms = [query]
        if words {
            let tokenizer = NLTokenizer(unit: .word); tokenizer.string = query
            terms = tokenizer.tokens(for: query.startIndex..<query.endIndex).map { String(query[$0]) }
        }
        let source = text as NSString
        let needles = Set(terms.filter { !$0.isEmpty }).sorted()
        func next(_ term: String, from offset: Int) -> NSRange? {
            guard offset < source.length else { return nil }
            let range = source.range(of: term, options: caseSensitive ? [] : [.caseInsensitive], range: NSRange(location: offset, length: source.length - offset))
            return range.location != NSNotFound && range.length > 0 ? range : nil
        }
        // 按原文位置合并各词项，截断不受 Set 顺序影响，也不为每个词缓存整章命中。
        var candidates = needles.map { next($0, from: 0) }
        var found: [TextMatch] = []
        var end = 0
        while found.count <= limit {
            guard let index = candidates.indices.filter({ candidates[$0] != nil }).min(by: {
                let a = candidates[$0]!, b = candidates[$1]!
                return a.location == b.location ? a.length > b.length : a.location < b.location
            }), let range = candidates[index] else { break }
            if range.location >= end, valid(range, in: source) {
                found.append(TextMatch(range: range, quote: source.substring(with: range)))
                end = NSMaxRange(range)
            }
            candidates[index] = next(needles[index], from: max(end, NSMaxRange(range)))
        }
        return found
    }
    // 只接受当前快照中的确切范围；反向替换保留原始换行、未选字节与 Unicode 标量。
    public static func replacing(_ text: String, matches: [TextMatch], with replacement: String) -> String? {
        guard !replacement.contains("\0") else { return nil }
        let ordered = matches.sorted { $0.range.location < $1.range.location }
        let source = text as NSString
        var end = 0
        for match in ordered {
            guard match.range.location >= end, valid(match.range, in: source), source.substring(with: match.range) == match.quote else { return nil }
            end = NSMaxRange(match.range)
        }
        let output = NSMutableString(string: text)
        for match in ordered.reversed() { output.replaceCharacters(in: match.range, with: replacement) }
        return output as String
    }
}

public struct BookSearchHit: Identifiable, Sendable {
    public let documentID: String
    public let title: String
    public let revisionID: String
    public let content: String
    public let match: TextMatch
    public var id: String { documentID + ":" + match.id }
    public var excerpt: String {
        let source = content as NSString
        let start = max(0, match.range.location - 24)
        return source.substring(with: NSRange(location: start, length: min(source.length - start, match.range.length + 64))).replacingOccurrences(of: "\n", with: " ")
    }
}

@MainActor @Observable public final class BookSearchSession {
    public private(set) var hits: [BookSearchHit] = []
    public private(set) var searching = false
    public private(set) var scanned = 0
    public private(set) var total = 0
    public private(set) var truncated = false
    public private(set) var error: String?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    public init() {}
    public func cancel() { task?.cancel(); generation = UUID(); searching = false }
    public func search(model: WorkspaceModel, query: String, allDocuments: Bool, words: Bool, caseSensitive: Bool) {
        cancel(); hits = []; scanned = 0; total = 0; truncated = false; error = nil
        guard !query.isEmpty, let workspace = model.workspace else { return }
        let scope = model.workspaceID, token = generation
        let selectedID = model.documentID, buffer = model.text, selectedRevision = model.baseRevisionID
        let documents = allDocuments ? model.documents.filter { $0.value["draft_source_id"] == .null } : model.documents.filter { $0.id == selectedID }
        total = documents.count; searching = true
        task = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(200))
                for document in documents {
                    try Task.checkCancellation()
                    guard let self, token == self.generation, model.workspaceID == scope else { return }
                    let content: String, revision: String
                    if document.id == selectedID { content = buffer; revision = selectedRevision }
                    else {
                        let value = try await workspace.data("hetu.documents.get", input: ["document_id": .string(document.id)])
                        content = value["content"].string ?? ""; revision = value["revision"]["revision_id"].string ?? ""
                    }
                    let matches = await Task.detached(priority: .userInitiated) { TextSearch.matches(in: content, query: query, words: words, caseSensitive: caseSensitive) }.value
                    guard !Task.isCancelled, token == self.generation, model.workspaceID == scope else { return }
                    let remaining = 5000 - self.hits.count
                    self.hits += matches.prefix(remaining).map { BookSearchHit(documentID: document.id, title: document.title, revisionID: revision, content: content, match: $0) }
                    self.scanned += 1
                    if matches.count > remaining { self.truncated = true; break }
                }
            } catch is CancellationError { return }
            catch { if let self, token == self.generation, model.workspaceID == scope { self.error = model.localizer.error(error) } }
            if let self, token == self.generation { self.searching = false }
        }
    }
}
