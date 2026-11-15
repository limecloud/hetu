import AppKit
import SwiftUI

// Radix Colors 3.0.0 sRGB：1–2 背景、3 选中、6 分隔、11 次要文字、12 正文。
// 来源 @radix-ui/colors；许可见 assets/licenses/radix-colors-MIT.txt。
@MainActor public enum WorkbenchPalette {
    public static func adaptive(_ light: UInt32, _ dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255, alpha: 1)
        }
    }
    public static let inkColor = adaptive(0x1A211E, 0xECEEED) // sage 12
    public static let artworkInk = Color(nsColor: adaptive(0x1A211E, 0x1A211E)) // 固定浅色封面上的 sage 12，不随界面主题反转。
    public static let pageColor = adaptive(0xFBFDFC, 0x101211) // sage 1
    public static let paper = Color(nsColor: adaptive(0xF7F9F8, 0x171918)) // sage 2
    public static let sidebar = Color(nsColor: adaptive(0xF7F9F8, 0x171918)) // sage 2
    public static let inspector = Color(nsColor: adaptive(0xF7F9F8, 0x171918)) // sage 2
    public static let muted = Color(nsColor: adaptive(0x5F6563, 0xADB5B2)) // sage 11
    public static let line = Color(nsColor: adaptive(0xD7DAD9, 0x373B39)) // sage 6
    public static let jade = Color(nsColor: adaptive(0x208368, 0x1FD8A4)) // jade 11
    public static let jadeSoft = Color(nsColor: adaptive(0xE6F7ED, 0x0F2E22)) // jade 3
    public static let warning = Color(nsColor: adaptive(0xFFF7C2, 0x302008)) // amber 3
    public static let warningInk = Color(nsColor: adaptive(0xAB6400, 0xFFCA16)) // amber 11
    public static let warningLine = Color(nsColor: adaptive(0xF3D673, 0x5C3D05)) // amber 6
    public static let surface = Color(nsColor: adaptive(0xFBFDFC, 0x101211)) // sage 1
    public static let canvasStart = Color(nsColor: adaptive(0xF4FBF7, 0x121C18)) // jade 2
    public static let canvasMiddle = Color(nsColor: adaptive(0xF4FAFF, 0x111927)) // blue 2
    public static let canvasEnd = Color(nsColor: adaptive(0xFAF8FF, 0x1B1525)) // violet 2
    public static let mistMint = Color(nsColor: adaptive(0xD6F1E3, 0x0B3B2C)) // jade 4
    public static let mistBlue = Color(nsColor: adaptive(0xD5EFFF, 0x003362)) // blue 4
    public static let mistLilac = Color(nsColor: adaptive(0xEBE4FF, 0x33255B)) // violet 4
    public static let danger = Color(nsColor: adaptive(0xCE2C31, 0xFF9592)) // red 11
    public static let dangerSoft = Color(nsColor: adaptive(0xFEEBEC, 0x3B1219)) // red 3
    public static let ink = Color(nsColor: inkColor)
    public static let page = Color(nsColor: pageColor)
    public static let actionStart = Color(nsColor: adaptive(0x208368, 0x29A383))
    public static let actionEnd = actionStart
    public static let actionInk = Color(nsColor: adaptive(0xFFFFFF, 0x101211))
}
