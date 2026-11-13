import AppKit

/// 排版只作用于显示属性，不向正文插入空格或改变来源偏移。
public struct EditorPresentation: Equatable, Sendable {
    public let fontFamily: String
    public let fontSize: Double
    public let lineSpacing: Double
    public let firstLineIndent: Bool
    public init(fontFamily: String = "songti", fontSize: Double = 18, lineSpacing: Double = 5, firstLineIndent: Bool = true) {
        self.fontFamily = ["songti", "system", "pingfang"].contains(fontFamily) ? fontFamily : "songti"
        self.fontSize = fontSize.isFinite ? min(30, max(14, fontSize)) : 18
        self.lineSpacing = lineSpacing.isFinite ? min(16, max(0, lineSpacing)) : 5
        self.firstLineIndent = firstLineIndent
    }
    @MainActor @discardableResult public func apply(to editor: NSTextView, readingMode: Bool) -> Bool {
        guard !editor.hasMarkedText() else { return false }
        let selection = editor.selectedRanges
        let size = readingMode ? fontSize : 16
        let family = fontFamily == "songti" ? "Songti SC" : "PingFang SC"
        let font = readingMode && fontFamily != "system" ? NSFont(name: family, size: size) ?? .systemFont(ofSize: size) : .systemFont(ofSize: size)
        let paragraph = NSMutableParagraphStyle()
        if readingMode {
            paragraph.minimumLineHeight = size * 34 / 18
            paragraph.lineSpacing = lineSpacing
            paragraph.firstLineHeadIndent = firstLineIndent ? size * 2 : 0
        }
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: readingMode ? WorkbenchPalette.inkColor : NSColor.textColor, .paragraphStyle: paragraph]
        editor.font = font
        editor.defaultParagraphStyle = paragraph
        editor.typingAttributes = attributes
        if let storage = editor.textStorage, storage.length > 0 { storage.addAttributes(attributes, range: NSRange(location: 0, length: storage.length)) }
        editor.selectedRanges = selection
        return true
    }
}
