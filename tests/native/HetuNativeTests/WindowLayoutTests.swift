import AppKit
import HetuNative

private struct WindowLayoutFailure: Error { let message: String }

enum WindowLayoutTests {
    @MainActor static func run() throws {
        _ = NSApplication.shared
        for locale in ["zh-CN", "en"] {
            for width in [960.0, 1024, 1180, 1440, 1920] {
                for projectNavigation in [false, true] {
                    if WorkspaceNavigation.canPinContents(width: width, locale: locale, projectNavigation: projectNavigation) {
                        let navigationWidth = projectNavigation ? (locale == "en" ? 190.5 : 170.5) : 0
                        guard width - navigationWidth - 210.5 >= 680 else {
                            throw WindowLayoutFailure(message: "目录挤占主要阅读空间：\(locale) \(width)")
                        }
                    }
                }
            }
        }
        guard !WorkspaceNavigation.canPinContents(width: 1024, locale: "en", projectNavigation: true),
              WorkspaceNavigation.canPinContents(width: 1440, locale: "en", projectNavigation: true),
              WorkspaceNavigation.group(for: "bible") == .resources,
              WorkspaceNavigation.group(for: "delivery") == .management,
              WorkspaceNavigation.group(for: "validation") == .checks,
              WorkspaceNavigation.group(for: "drama") == nil else {
            throw WindowLayoutFailure(message: "层级导航未按工作面和可用宽度展开")
        }
        for (directoryWidth, occupiedWidth) in [(280.5, 64.0), (260.5, 88.0), (280.0, 0.0)] {
            let threshold = 680 + directoryWidth + occupiedWidth
            guard !WorkspaceNavigation.canPinDirectory(width: threshold - 1, directoryWidth: directoryWidth, occupiedWidth: occupiedWidth),
                  WorkspaceNavigation.canPinDirectory(width: threshold, directoryWidth: directoryWidth, occupiedWidth: occupiedWidth) else {
                throw WindowLayoutFailure(message: "内容目录或检查器挤占主要阅读空间")
            }
        }
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
