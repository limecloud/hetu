import AppKit

/// 工作台按当前屏幕提供初始空间，用户之后可自由调整窗口。
@MainActor public enum WorkspaceWindowLayout {
    public static var mainVisibleFrame: NSRect {
        NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    }

    public static func preferredContentSize(in visibleFrame: NSRect) -> NSSize {
        let available = availableContentSize(in: visibleFrame)
        let minimum = minimumContentSize(in: visibleFrame)
        return NSSize(width: max(minimum.width, available.width * 0.92), height: max(minimum.height, available.height * 0.94))
    }

    public static func minimumContentSize(in visibleFrame: NSRect) -> NSSize {
        let available = availableContentSize(in: visibleFrame)
        return NSSize(width: min(1180, available.width), height: min(740, available.height))
    }

    public static func configure(_ window: NSWindow) {
        window.styleMask.formUnion([.titled, .closable, .miniaturizable, .resizable])
        window.collectionBehavior.insert(.fullScreenPrimary)
        if let screen = window.screen ?? NSScreen.main {
            window.contentMinSize = minimumContentSize(in: screen.visibleFrame)
        }
    }

    public static func zoomFrame(for window: NSWindow, proposed: NSRect) -> NSRect {
        (window.screen ?? NSScreen.main)?.visibleFrame ?? proposed
    }

    private static func availableContentSize(in visibleFrame: NSRect) -> NSSize {
        let frame = NSRect(origin: .zero, size: visibleFrame.size)
        let content = NSWindow.contentRect(forFrameRect: frame, styleMask: [.titled, .resizable])
        return NSSize(width: max(1, content.width - 24), height: max(1, content.height - 24))
    }
}
