import Foundation

/// 项目导航和内容目录各占一层，窄窗口将目录改为按需浮层。
public enum WorkspaceNavigation {
    public enum Group: Equatable, Sendable { case resources, management, checks }

    public static func group(for page: String) -> Group? {
        switch page {
        case "bible", "media": .resources
        case "git", "delivery": .management
        case "plot", "validation": .checks
        default: nil
        }
    }

    public static func canPinContents(width: Double, locale: String, projectNavigation: Bool) -> Bool {
        // 内容区至少保留 680pt；浮层和收起不改变选中的章节。
        let projectWidth = projectNavigation ? (locale == "en" ? 190.5 : 170.5) : 0
        return canPinDirectory(width: width, directoryWidth: 210.5, occupiedWidth: projectWidth)
    }

    public static func canPinDirectory(width: Double, directoryWidth: Double, occupiedWidth: Double) -> Bool {
        width - occupiedWidth - directoryWidth >= 680
    }
}
