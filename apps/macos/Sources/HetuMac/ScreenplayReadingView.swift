import SwiftUI
import HetuNative

struct ScreenplayReadingView: View {
    let content: String
    let localizer: Localizer
    private var paragraphs: [ScreenplayParagraph] { ScreenplayReading.paragraphs(content) }
    var body: some View {
        LazyVStack(alignment: .leading, spacing: 14) {
            ForEach(Array(paragraphs.enumerated()), id: \.offset) { index, paragraph in
                if paragraph.kind != .metadata {
                    Text(verbatim: paragraph.text)
                        .font(.system(size: 14, weight: paragraph.kind == .scene || paragraph.kind == .character || paragraph.kind == .section ? .semibold : .regular))
                        .foregroundStyle(paragraph.kind == .note ? WorkbenchPalette.muted : WorkbenchPalette.ink)
                        .lineSpacing(6)
                        .frame(maxWidth: .infinity, alignment: paragraph.kind == .transition ? .trailing : .leading)
                        .padding(.leading, paragraph.kind == .character ? 100 : (paragraph.kind == .dialogue || paragraph.kind == .parenthetical ? 56 : 0))
                        .padding(.top, paragraph.kind == .scene ? 16 : 0)
                        .id(index)
                }
            }
            let metadata = paragraphs.filter { $0.kind == .metadata }
            if !metadata.isEmpty {
                DisclosureGroup(localizer.text("drama.script_metadata")) {
                    Text(verbatim: metadata.map(\.text).joined(separator: "\n")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                }.font(.system(size: 12)).padding(.top, 24)
            }
        }.textSelection(.enabled).padding(28).frame(maxWidth: 780, alignment: .leading)
            .background(WorkbenchPalette.page).frame(maxWidth: .infinity, alignment: .center)
    }
}
