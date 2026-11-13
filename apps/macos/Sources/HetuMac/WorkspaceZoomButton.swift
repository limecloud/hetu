import AppKit
import SwiftUI
import HetuNative

struct WorkspaceZoomButton: NSViewRepresentable {
    let localizer: Localizer

    func makeNSView(context: Context) -> NSButton {
        let button = WindowZoomControl()
        button.image = NSImage(systemSymbolName: "arrow.up.left.and.arrow.down.right", accessibilityDescription: nil)
        button.isBordered = false
        button.setContentHuggingPriority(.required, for: .horizontal)
        return button
    }

    func updateNSView(_ button: NSButton, context: Context) {
        let label = localizer.text("window.zoom")
        button.toolTip = label
        button.setAccessibilityLabel(label)
    }

    private final class WindowZoomControl: NSButton {
        override init(frame: NSRect) {
            super.init(frame: frame)
            target = self
            action = #selector(zoomOwnWindow)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
        override var intrinsicContentSize: NSSize { NSSize(width: 24, height: 24) }

        // 绑定按钮所在的窗口，避免焦点位于浮层或其他窗口时缩放失效。
        @objc private func zoomOwnWindow() { window?.performZoom(self) }
    }
}
