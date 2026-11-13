import Foundation

public enum IntegrationAssets {
    public static var directory: URL {
        let packaged = Bundle.main.resourceURL?.appendingPathComponent("Hetu_HetuIntegrationAssets.bundle")
        return (packaged.flatMap { Bundle(url: $0) } ?? Bundle.module).resourceURL!
    }
}
