import Foundation

public enum HetuArtwork {
    public static func url(_ name: String) -> URL? {
        let packaged = Bundle.main.resourceURL?.appendingPathComponent("Hetu_HetuArtwork.bundle")
        let bundle = packaged.flatMap { Bundle(url: $0) } ?? Bundle.module
        return bundle.url(forResource: name, withExtension: "jpg", subdirectory: "library")
    }
}
