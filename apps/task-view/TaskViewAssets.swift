import Foundation

public enum TaskViewAssets {
    public static var directory: URL {
        let packaged = Bundle.main.resourceURL?.appendingPathComponent("Hetu_HetuTaskViewAssets.bundle")
        return (packaged.flatMap { Bundle(url: $0) } ?? Bundle.module).resourceURL!.appendingPathComponent("local")
    }
}
