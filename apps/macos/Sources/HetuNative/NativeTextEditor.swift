import AppKit
import SwiftUI

// TextKit 编辑器只在切换文档或显式恢复时替换全文；普通 SwiftUI 刷新保留 IME、选区和撤销栈。
public struct NativeTextEditor: NSViewRepresentable {
    public var text: String
    public var documentID: String
    public var replacementVersion: Int
    public var accessibleName: String
    public var editable: Bool
    public var selection: SourceSelection?
    public var readingMode: Bool
    public var presentation: EditorPresentation
    public var onChange: (String) -> Void
    public var onComposition: (Bool) -> Void
    public var onSelection: ((NSRange) -> Void)?
    public var undoBaseline: String?
    public init(text: String, documentID: String, replacementVersion: Int, accessibleName: String, editable: Bool = true, selection: SourceSelection? = nil, readingMode: Bool = false, presentation: EditorPresentation = .init(), onChange: @escaping (String) -> Void, onComposition: @escaping (Bool) -> Void, onSelection: ((NSRange) -> Void)? = nil, undoBaseline: String? = nil) {
        self.text = text; self.documentID = documentID; self.replacementVersion = replacementVersion
        self.accessibleName = accessibleName; self.onChange = onChange; self.onComposition = onComposition
        self.editable = editable
        self.selection = selection
        self.readingMode = readingMode
        self.presentation = presentation
        self.onSelection = onSelection
        self.undoBaseline = undoBaseline
    }
    public func makeCoordinator() -> Coordinator { Coordinator(self) }
    public func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true; scroll.borderType = .noBorder
        let editor = CompositionTextView(frame: .zero)
        editor.isRichText = false; editor.importsGraphics = false; editor.allowsUndo = true
        editor.isAutomaticQuoteSubstitutionEnabled = false; editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.font = .systemFont(ofSize: 16); editor.textColor = .textColor; editor.backgroundColor = .textBackgroundColor
        editor.textContainerInset = NSSize(width: 24, height: 24)
        editor.isVerticallyResizable = true; editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]; editor.textContainer?.widthTracksTextView = true
        editor.minSize = .zero; editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.usesFindBar = true; editor.delegate = context.coordinator
        editor.compositionEnded = { [weak coordinator = context.coordinator, weak editor] in
            guard let coordinator, let editor else { return }
            coordinator.parent.onChange(editor.string); coordinator.parent.onComposition(false)
        }
        scroll.documentView = editor
        return scroll
    }
    public func updateNSView(_ scroll: NSScrollView, context: Context) {
        updateEditor(in: scroll, coordinator: context.coordinator)
    }
    // 与 AppKit 容器共用同步入口，替换正文时仍使用真实 TextKit 编辑和撤销。
    public func updateEditor(in scroll: NSScrollView, coordinator: Coordinator) {
        guard let editor = scroll.documentView as? NSTextView else { return }
        coordinator.parent = self
        coordinator.editor = editor
        editor.setAccessibilityLabel(accessibleName)
        editor.isEditable = editable
        guard !editor.hasMarkedText() else { return }
        if coordinator.readingMode != readingMode || coordinator.presentation != presentation {
            coordinator.updating = true
            presentation.apply(to: editor, readingMode: readingMode)
            editor.textColor = readingMode ? WorkbenchPalette.inkColor : .textColor
            editor.backgroundColor = readingMode ? WorkbenchPalette.pageColor : .textBackgroundColor
            scroll.backgroundColor = editor.backgroundColor
            editor.textContainerInset = readingMode ? NSSize(width: 0, height: 8) : NSSize(width: 24, height: 24)
            coordinator.readingMode = readingMode
            coordinator.presentation = presentation
            coordinator.updating = false
        }
        let changedDocument = coordinator.documentID != documentID
        if changedDocument || coordinator.replacementVersion != replacementVersion {
            coordinator.updating = true
            if let before = undoBaseline, before != text {
                if changedDocument || editor.string != before {
                    editor.string = before
                    editor.undoManager?.removeAllActions()
                }
                editor.breakUndoCoalescing()
                editor.undoManager?.beginUndoGrouping()
                editor.insertText(text, replacementRange: NSRange(location: 0, length: before.utf16.count))
                editor.undoManager?.endUndoGrouping()
                editor.breakUndoCoalescing()
            } else {
                editor.string = text
                editor.undoManager?.removeAllActions()
                if changedDocument { editor.setSelectedRange(NSRange(location: 0, length: 0)) }
            }
            presentation.apply(to: editor, readingMode: readingMode)
            coordinator.documentID = documentID; coordinator.replacementVersion = replacementVersion
            coordinator.updating = false
        }
        if let selection, coordinator.selectionID != selection.id, NSMaxRange(selection.range) <= editor.string.utf16.count {
            editor.setSelectedRange(selection.range)
            editor.scrollRangeToVisible(selection.range)
            editor.showFindIndicator(for: selection.range)
            coordinator.selectionID = selection.id
        }
        coordinator.synchronizedText = editor.string
    }
    @MainActor public final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: NativeTextEditor
        var documentID = ""
        var replacementVersion = -1
        var updating = false
        var selectionID: UUID?
        var readingMode: Bool?
        var presentation: EditorPresentation?
        weak var editor: NSTextView?
        var synchronizedText = ""
        init(_ parent: NativeTextEditor) {
            self.parent = parent
            super.init()
            // 程序化采纳的 TextKit 撤销未必触发 delegate，完成后同步真实正文。
            for name in [Notification.Name.NSUndoManagerDidUndoChange, Notification.Name.NSUndoManagerDidRedoChange] {
                NotificationCenter.default.addObserver(self, selector: #selector(undoStateChanged(_:)), name: name, object: nil)
            }
        }
        deinit { NotificationCenter.default.removeObserver(self) }
        @objc private func undoStateChanged(_ notification: Notification) {
            guard !updating, let editor, let manager = notification.object as? UndoManager,
                  manager === editor.undoManager, synchronizedText != editor.string else { return }
            synchronizedText = editor.string
            parent.onComposition(editor.hasMarkedText()); parent.onChange(editor.string)
        }
        public func textDidChange(_ notification: Notification) {
            guard !updating, let editor = notification.object as? NSTextView else { return }
            synchronizedText = editor.string
            parent.onComposition(editor.hasMarkedText()); parent.onChange(editor.string)
        }
        public func textViewDidChangeSelection(_ notification: Notification) {
            guard !updating, let editor = notification.object as? NSTextView else { return }
            parent.onSelection?(editor.selectedRange())
        }
    }
}
@MainActor private final class CompositionTextView: NSTextView {
    var compositionEnded: (() -> Void)?
    override func unmarkText() { super.unmarkText(); compositionEnded?() }
}
