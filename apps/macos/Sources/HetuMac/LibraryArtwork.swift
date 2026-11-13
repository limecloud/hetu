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
    private var variant: Int { Int(identity.utf8.reduce(UInt64(0)) { ($0 &* 31) &+ UInt64($1) } % 3) }
    private var name: String { ["cover-river-jade", "cover-cloud-rose", "cover-stars-ink"][variant] }
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                LibraryArtwork(name: name).frame(width: geometry.size.width, height: geometry.size.height).clipped()
                if !compact {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(title).font(.system(size: min(25, geometry.size.width * 0.14), weight: .medium, design: .serif)).lineSpacing(4).lineLimit(4)
                        if !author.isEmpty { Text(author).font(.system(size: 10, weight: .medium)).lineLimit(1) }
                    }.foregroundStyle(variant == 2 ? Color(red: 0.96, green: 0.93, blue: 0.85) : Color(red: 0.16, green: 0.23, blue: 0.21))
                        .padding(.horizontal, geometry.size.width * 0.12).padding(.top, geometry.size.height * 0.09)
                }
            }.background(WorkbenchPalette.sidebar)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .overlay(alignment: .leading) { Rectangle().fill(.black.opacity(0.06)).frame(width: 3) }
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(.black.opacity(0.06), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.08), radius: 6, x: 0, y: 3)
        }.accessibilityHidden(true)
    }
}
