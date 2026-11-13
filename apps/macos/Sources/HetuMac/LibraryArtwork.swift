import AppKit
import SwiftUI
import HetuArtwork
import HetuNative

@MainActor private enum ArtworkCache {
    static let images = NSCache<NSString, NSImage>()
    static func image(_ name: String) -> NSImage? {
        if let image = images.object(forKey: name as NSString) { return image }
        guard let url = HetuArtwork.url(name), let image = NSImage(contentsOf: url) else { return nil }
        images.setObject(image, forKey: name as NSString)
        return image
    }
}

struct LibraryArtwork: View {
    let name: String
    var body: some View {
        if let image = ArtworkCache.image(name) { Image(nsImage: image).resizable().scaledToFill().accessibilityHidden(true) }
        else { Color.clear }
    }
}

struct WorkbenchSpotArtwork: View {
    let name: String
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        if let image = ArtworkCache.image(scheme == .dark ? name + "-dark" : name) ?? ArtworkCache.image(name) {
            Image(nsImage: image).resizable().interpolation(.high).scaledToFit()
                .mask { GeometryReader { geometry in
                    RadialGradient(stops: [.init(color: .white, location: 0.30), .init(color: .white, location: 0.60), .init(color: .clear, location: 0.98)], center: .center, startRadius: 0, endRadius: max(geometry.size.width, geometry.size.height) * 0.60)
                } }
                .accessibilityHidden(true).allowsHitTesting(false)
        }
    }
}

struct BookCoverView: View {
    let title: String
    let author: String
    let identity: String
    var compact = false
    var imageData: Data? = nil
    var titleOverlay: String? = nil
    var authorOverlay: String? = nil
    private var variant: Int { Int(identity.utf8.reduce(UInt64(0)) { ($0 &* 31) &+ UInt64($1) } % 3) }
    private var name: String { ["cover-river-jade", "cover-cloud-rose", "cover-stars-ink"][variant] }
    private var selectedImage: NSImage? { imageData.flatMap(NSImage.init(data:)) }
    private var hasOverlay: Bool { !(titleOverlay ?? title).isEmpty || !(authorOverlay ?? author).isEmpty }
    private func fittedSize(image: NSImage?, in available: CGSize) -> CGSize {
        guard let image, image.size.width > 0, image.size.height > 0 else { return available }
        let scale = min(available.width / image.size.width, available.height / image.size.height)
        return CGSize(width: image.size.width * scale, height: image.size.height * scale)
    }
    var body: some View {
        GeometryReader { geometry in
            let image = selectedImage
            let size = fittedSize(image: image, in: geometry.size)
            ZStack(alignment: .topLeading) {
                if let image {
                    Image(nsImage: image).resizable().scaledToFit()
                } else {
                    LibraryArtwork(name: name).frame(width: size.width, height: size.height).clipped()
                }
                if !compact && hasOverlay {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(titleOverlay ?? title).font(.system(size: max(12, min(25, size.width * 0.14)), weight: .medium, design: .serif)).lineSpacing(4).lineLimit(4)
                        if !(authorOverlay ?? author).isEmpty { Text(authorOverlay ?? author).font(.system(size: 12, weight: .medium)).lineLimit(1) }
                    }.foregroundStyle(image != nil ? WorkbenchPalette.ink : variant == 2 ? .white : WorkbenchPalette.ink)
                        .padding(image != nil ? 8 : 0)
                        .background { if image != nil { WorkbenchPalette.surface.opacity(0.94) } }
                        .padding(.horizontal, size.width * 0.12).padding(.top, size.height * 0.09)
                }
            }.frame(width: size.width, height: size.height)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(WorkbenchPalette.line, lineWidth: 0.5))
                .frame(width: geometry.size.width, height: geometry.size.height)
        }.accessibilityHidden(true)
    }
}
