import AppKit
import SwiftUI

// 原生工作台共享语义色；正文纸面与装饰背景分别着色。
@MainActor public enum WorkbenchPalette {
    public static func adaptive(_ light: UInt32, _ dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255, alpha: 1)
        }
    }
    public static let inkColor = adaptive(0x20312B, 0xE3E9E4)
    public static let pageColor = adaptive(0xFFFEFA, 0x202625)
    public static let ink = Color(nsColor: inkColor)
    public static let page = Color(nsColor: pageColor)
    public static let paper = Color(nsColor: adaptive(0xF8F6EF, 0x181D1A))
    public static let sidebar = Color(nsColor: adaptive(0xF4F8F6, 0x1C2325))
    public static let inspector = Color(nsColor: adaptive(0xF8FAF8, 0x22292B))
    public static let muted = Color(nsColor: adaptive(0x5F706B, 0xB0BCB8))
    public static let line = Color(nsColor: adaptive(0xD4DFDA, 0x414B4D))
    public static let jade = Color(nsColor: adaptive(0x1E6B5E, 0x7EC6AE))
    public static let jadeSoft = Color(nsColor: adaptive(0xE8F0E9, 0x293E33))
    public static let warning = Color(nsColor: adaptive(0xFFF8E9, 0x362D1C))
    public static let warningInk = Color(nsColor: adaptive(0x845F2C, 0xE0BD7B))
    public static let warningLine = Color(nsColor: adaptive(0xE9D7AC, 0x665337))
    public static let surface = Color(nsColor: adaptive(0xFFFFFF, 0x252C2E))
    public static let canvasStart = Color(nsColor: adaptive(0xEFF8F3, 0x192625))
    public static let canvasMiddle = Color(nsColor: adaptive(0xF5F7FA, 0x202529))
    public static let canvasEnd = Color(nsColor: adaptive(0xF3F0FA, 0x252333))
    public static let mistMint = Color(nsColor: adaptive(0xA9DDCB, 0x3C7D72))
    public static let mistBlue = Color(nsColor: adaptive(0xBBD9F1, 0x3F657E))
    public static let mistLilac = Color(nsColor: adaptive(0xD8C9F1, 0x6B527E))
    public static let actionStart = Color(red: 0.12, green: 0.42, blue: 0.37)
    public static let actionEnd = Color(red: 0.16, green: 0.49, blue: 0.45)
}
