import AppKit
import HetuNative

private struct WindowLayoutFailure: Error { let message: String }

enum WindowLayoutTests {
    @MainActor static func run() throws {
        _ = NSApplication.shared
        for size in [NSSize(width: 1280, height: 720), NSSize(width: 1440, height: 860), NSSize(width: 2560, height: 1380)] {
            let screen = NSRect(origin: NSPoint(x: -200, y: 40), size: size)
            let preferred = WorkspaceWindowLayout.preferredContentSize(in: screen)
            let minimum = WorkspaceWindowLayout.minimumContentSize(in: screen)
            let frame = NSWindow.frameRect(forContentRect: NSRect(origin: .zero, size: preferred), styleMask: [.titled, .resizable])
            guard frame.width <= screen.width, frame.height <= screen.height,
                  preferred.width >= minimum.width, preferred.height >= minimum.height,
                  preferred.width >= screen.width * 0.85 else {
                throw WindowLayoutFailure(message: "工作台默认空间未适配屏幕或超出可用区：\(size)")
            }
        }
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1200, height: 760), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let original = window.frame
        WorkspaceWindowLayout.configure(window)
        guard window.styleMask.contains(.resizable), window.standardWindowButton(.zoomButton)?.isEnabled == true,
              window.collectionBehavior.contains(.fullScreenPrimary), window.frame == original else {
            throw WindowLayoutFailure(message: "窗口不可缩放，或初始化覆盖了用户已有窗口大小")
        }
        if let screen = window.screen ?? NSScreen.main {
            let zoom = WorkspaceWindowLayout.zoomFrame(for: window, proposed: original)
            guard zoom == screen.visibleFrame else { throw WindowLayoutFailure(message: "窗口缩放未使用所在屏幕的可用区域") }
        }
        print("窗口：大小屏适配、系统缩放、全屏能力与已有尺寸保护通过")
    }
}
