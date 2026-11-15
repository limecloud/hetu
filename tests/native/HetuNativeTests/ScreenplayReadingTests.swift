import Foundation
import HetuNative

enum ScreenplayReadingTests {
    struct Failure: Error { let message: String }
    static func run() throws {
        let source = "Title: 渡口\r\nAuthor: 测试\r\n\r\n.EXT. 渡口 - 日\r\n\r\n@林溪\r\n（压低声音）\r\n船还没来。\r\n\r\n!WAIT\r\n\r\n/* 制作备忘\r\n不要删去原文。 */\r\n\r\n未知内容：保留 🌿\r\n"
        let digest = Array(source.utf8)
        let paragraphs = ScreenplayReading.paragraphs(source)
        let expected: [ScreenplayParagraph.Kind] = [.metadata, .metadata, .scene, .character, .parenthetical, .dialogue, .action, .note, .note, .action]
        guard paragraphs.map(\.kind) == expected else { throw Failure(message: "Windows换行使对白或强制动作被误判：\(paragraphs)") }
        guard paragraphs.last?.text == "未知内容：保留 🌿", Array(source.utf8) == digest else { throw Failure(message: "阅读投影丢失未知文字或修改原文") }
        guard ScreenplayReading.paragraphs(source.replacingOccurrences(of: "\r\n", with: "\n")) == paragraphs else { throw Failure(message: "不同平台换行产生不同阅读结果") }
        print("剧本阅读格式通过：中文对白、Windows换行、强制动作、便笺、未知文字和原文保护。")
    }
}
