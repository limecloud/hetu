import Foundation

public struct TextStatistics: Sendable, Equatable {
    public let han: Int
    public let latinWords: Int
    public let graphemes: Int
    public static let ruleVersion = "han-latin-1"
    public static func count(_ text: String) -> Self {
        var han = 0, words = 0
        var inWord = false
        let scalars = Array(text.unicodeScalars)
        for (index, scalar) in scalars.enumerated() {
            let value = scalar.value
            if (0x3400...0x4dbf).contains(value) || (0x4e00...0x9fff).contains(value) || (0xf900...0xfaff).contains(value) || (0x20000...0x2fa1f).contains(value) || (0x30000...0x323af).contains(value) { han += 1 }
            let latin = isLatin(scalar)
            if latin { if !inWord { words += 1 }; inWord = true }
            else if inWord, scalar.properties.generalCategory == .nonspacingMark || scalar.properties.generalCategory == .spacingMark { }
            else if (value == 0x27 || value == 0x2019), inWord, index + 1 < scalars.count, isLatin(scalars[index + 1]) { }
            else { inWord = false }
        }
        return Self(han: han, latinWords: words, graphemes: text.count)
    }
    private static func isLatin(_ scalar: Unicode.Scalar) -> Bool {
        let v = scalar.value
        return scalar.properties.isAlphabetic && ((0x41...0x7a).contains(v) || (0xc0...0x24f).contains(v) || (0x1e00...0x1eff).contains(v))
    }
}
