import SwiftUI
import HetuNative

/// 标题页与视频项目标识不冒充尚不存在的海报或视频帧。
struct WorkLibraryThumbnail: View {
    let entry: LibraryEntry
    var compact = false
    var body: some View {
        if entry.contentType == "novel" {
            BookCoverView(title: entry.title, author: entry.authorName, identity: entry.id, compact: compact,
                imageData: entry.coverPreview, titleOverlay: entry.coverTitle, authorOverlay: entry.coverAuthor)
                .aspectRatio(2.0 / 3.0, contentMode: .fit)
        } else {
            VStack(alignment: .leading, spacing: compact ? 0 : 16) {
                Image(systemName: entry.contentType == "video" ? "film" : "doc.text")
                    .font(.system(size: compact ? 20 : 32, weight: .light)).foregroundStyle(WorkbenchPalette.muted)
                if !compact {
                    Spacer(minLength: 0)
                    Text(entry.title).font(.system(size: 14, weight: .medium)).lineLimit(3)
                }
            }.padding(compact ? 10 : 20).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: compact ? .center : .topLeading)
                .background(WorkbenchPalette.surface)
                .overlay(Rectangle().strokeBorder(WorkbenchPalette.line, lineWidth: 0.5))
                .accessibilityHidden(true)
        }
    }
}
