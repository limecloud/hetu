import AppKit
import ApplicationServices
import CoreGraphics
import ImageIO
import Vision

// 只读指定reader自己的唯一小面板；不启动读屏、不操作键盘或修改系统权限。
let arguments = CommandLine.arguments
if arguments.count == 2 && arguments[1] == "--processes" {
    let rows: [[String: Any]] = NSWorkspace.shared.runningApplications.filter {
        !$0.isTerminated && ($0.bundleIdentifier?.hasPrefix("com.apple.VoiceOver") == true ||
            ($0.executableURL?.path.hasPrefix("/System/Library/") == true && $0.executableURL?.lastPathComponent.hasPrefix("VoiceOver") == true))
    }.map { ["pid": Int($0.processIdentifier), "bundle": $0.bundleIdentifier ?? "",
             "name": $0.localizedName ?? "", "executable": $0.executableURL?.path ?? ""] }
    let bytes = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
    print(String(data: bytes, encoding: .utf8)!)
    exit(0)
}
guard (3...4).contains(arguments.count),
      let targetPID = Int32(arguments[1]), targetPID > 1,
      let readerPID = Int32(arguments[2]), readerPID > 1, readerPID != targetPID else {exit(2)}
let diagnostics = arguments.count == 4 ? URL(fileURLWithPath: arguments[3], isDirectory: true) : nil
if let directory = diagnostics {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue else {exit(2)}
}
func foregroundMatches() -> Bool {NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPID}
func readerMatches() -> Bool {
    guard let application = NSRunningApplication(processIdentifier: readerPID) else {return false}
    return application.bundleIdentifier == "com.apple.VoiceOver" && application.executableURL?.lastPathComponent == "VoiceOver"
}
var lines: [String] = [], failures = 0, captures = 0
var files: [String] = []
var windows: [[String: Any]] = []
var focused: [String: String] = [:]
if foregroundMatches() && AXIsProcessTrusted() {
    let application = AXUIElementCreateApplication(targetPID)
    AXUIElementSetMessagingTimeout(application, 1)
    var value: CFTypeRef?
    if AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &value) == .success,
       let value, CFGetTypeID(value) == AXUIElementGetTypeID() {
        let element = unsafeBitCast(value, to: AXUIElement.self)
        for (name, key) in ["title": kAXTitleAttribute, "role": kAXRoleAttribute] {
            var attribute: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, key as CFString, &attribute) == .success,
               let text = attribute as? String {focused[name] = text}
        }
    }
}
let permission = CGPreflightScreenCaptureAccess()
if foregroundMatches() && readerMatches() && permission {
    windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).filter { row in
        guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == readerPID,
              let bounds = row[kCGWindowBounds as String] as? [String: Any],
              let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double else {return false}
        // 本机字幕面板的有界候选；排除覆盖全屏的旁白光标，不推断其他系统版本。
        return width >= 240 && width <= 1600 && height >= 40 && height <= 360
    }
    if windows.count == 1, let id = windows[0][kCGWindowNumber as String] as? Int {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("hetu-voiceover-\(UUID().uuidString).png")
        defer {try? FileManager.default.removeItem(at: file)}
        do {
            let capture = Process()
            capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-o", "-l", String(id), file.path]
            capture.standardOutput = FileHandle.nullDevice; capture.standardError = FileHandle.nullDevice
            guard foregroundMatches() && readerMatches() else {throw NSError(domain: "hetu-voiceover", code: 1)}
            try capture.run(); capture.waitUntilExit()
            guard capture.terminationStatus == 0,
                  let source = CGImageSourceCreateWithURL(file as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
                  foregroundMatches() && readerMatches() else {throw NSError(domain: "hetu-voiceover", code: 2)}
            captures += 1
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            request.usesLanguageCorrection = false
            try VNImageRequestHandler(cgImage: image).perform([request])
            lines = (request.results ?? []).compactMap {$0.topCandidates(1).first?.string}
            if let directory = diagnostics {
                let target = directory.appendingPathComponent("caption-\(UUID().uuidString).png")
                try FileManager.default.copyItem(at: file, to: target)
                files.append(target.path)
            }
        } catch {failures += 1}
    }
}
let foreground = foregroundMatches(), reader = readerMatches()
if !foreground || !reader {lines = []}
let result: [String: Any] = [
    "source": "VoiceOver caption window pixels", "frontmost_matches": foreground,
    "reader_matches": reader, "screen_capture_permission": permission,
    "target_focus": focused,
    "candidate_windows": windows.count, "captured_windows": captures, "read_failures": failures,
    "recognized_lines": lines, "diagnostic_files": files,
    "keyboard_input": false, "settings_changed": false,
]
let bytes = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: bytes, encoding: .utf8)!)
