// swift-tools-version: 6.2
import PackageDescription
import Foundation

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let package = Package(
    name: "Hetu",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "HetuCore", targets: ["HetuCore"]),
        .executable(name: "hetu", targets: ["HetuCLI"]),
        .executable(name: "hetu-bridge-tests", targets: ["HetuBridgeTests"]),
        .executable(name: "HetuMac", targets: ["HetuMac"]),
        .executable(name: "hetu-native-tests", targets: ["HetuNativeTests"]),
    ],
    targets: [
        .systemLibrary(name: "CHetu", path: "core/bindings/c"),
        .target(
            name: "HetuCore", dependencies: ["CHetu"], path: "bindings/swift/Sources/HetuCore",
            linkerSettings: [.unsafeFlags(["-L", root + "/build/native/lib", "-Xlinker", "-rpath", "-Xlinker", root + "/build/native/lib", "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
        ),
        .target(name: "HetuArtwork", path: "assets/illustrations", exclude: ["prompts"], sources: ["Artwork.swift"], resources: [.copy("library")]),
        .executableTarget(name: "HetuCLI", dependencies: ["HetuCore"], path: "apps/cli/Sources"),
        .executableTarget(name: "HetuBridgeTests", dependencies: ["HetuCore"], path: "tests/native/HetuCoreTests"),
        .target(name: "HetuNative", dependencies: ["HetuCore"], path: "apps/macos/Sources/HetuNative", exclude: ["Resources/Localizable.xcstrings"], resources: [.copy("Resources/NativeStrings.json")]),
        .executableTarget(name: "HetuMac", dependencies: ["HetuNative", "HetuCore", "HetuArtwork"], path: "apps/macos/Sources/HetuMac"),
        .executableTarget(name: "HetuNativeTests", dependencies: ["HetuNative", "HetuCore"], path: "tests/native/HetuNativeTests"),
    ]
)
