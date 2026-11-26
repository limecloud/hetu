import AppKit
import CoreGraphics
import ImageIO
import Vision

// 只读核对隔离前台的已知输入法候选；不输入、不切换系统偏好、不抓取其他应用窗口。
let arguments = CommandLine.arguments
guard (4...5).contains(arguments.count), let targetPID = Int32(arguments[1]), targetPID > 1,
      !arguments[2].isEmpty, !arguments[3].isEmpty, arguments[3].count <= 32 else {exit(2)}
let bundle = arguments[2], expected = arguments[3]
let diagnosticDirectory = arguments.count == 5 ? URL(fileURLWithPath: arguments[4], isDirectory: true) : nil
if let directory = diagnosticDirectory {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue else {exit(2)}
}
func targetIsFrontmost() -> Bool {NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPID}
var frontmost = targetIsFrontmost()
var candidateIndex: Int?
var captures = 0
var failures = 0
var diagnosticFiles: [String] = []
var recognizedLines: [String] = []
if frontmost {
    let owners = Set(NSRunningApplication.runningApplications(withBundleIdentifier: bundle).map(\.processIdentifier))
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for window in windows.filter({owners.contains(($0[kCGWindowOwnerPID as String] as? Int32) ?? -1)}).prefix(8) {
        guard targetIsFrontmost() else {frontmost = false; break}
        guard let id = window[kCGWindowNumber as String] as? Int,
              let bounds = window[kCGWindowBounds as String] as? [String: Any],
              let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double,
              width >= 100, height >= 30, width <= 2048, height <= 512 else {continue}
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("hetu-ime-candidate-\(UUID().uuidString).png")
        defer {try? FileManager.default.removeItem(at: file)}
        do {
            let capture = Process()
            capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-o", "-l", String(id), file.path]
            capture.standardOutput = FileHandle.nullDevice; capture.standardError = FileHandle.nullDevice
            try capture.run(); capture.waitUntilExit()
            guard capture.terminationStatus == 0,
                  let source = CGImageSourceCreateWithURL(file as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {failures += 1; continue}
            captures += 1
            guard targetIsFrontmost() else {frontmost = false; break}
            if let directory = diagnosticDirectory {
                let target = directory.appendingPathComponent("candidate-\(id).png")
                if !FileManager.default.fileExists(atPath: target.path) {try FileManager.default.copyItem(at: file, to: target)}
                diagnosticFiles.append(target.path)
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            request.usesLanguageCorrection = false
            try VNImageRequestHandler(cgImage: image).perform([request])
            let lines = (request.results ?? []).compactMap {$0.topCandidates(1).first?.string}
            if diagnosticDirectory != nil {recognizedLines.append(contentsOf: lines)}
            let text = lines.joined().filter {!$0.isWhitespace}
            let pattern = "(?<![0-9])([1-9])" + NSRegularExpression.escapedPattern(for: expected) + "(?=[1-9]|$)"
            let expression = try NSRegularExpression(pattern: pattern)
            let indexes = Set(expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap {match -> Int? in
                guard let range = Range(match.range(at: 1), in: text) else {return nil}
                return Int(text[range])
            })
            if indexes.count == 1 {candidateIndex = indexes.first; break}
        } catch {failures += 1}
    }
}
frontmost = frontmost && targetIsFrontmost()
if !frontmost {candidateIndex = nil}
var result: [String: Any] = ["frontmost_matches": frontmost, "candidate_ready": candidateIndex != nil,
                           "candidate_index": candidateIndex.map {NSNumber(value: $0)} ?? NSNull(),
                           "captured_candidate_windows": captures, "read_failures": failures,
                           "keyboard_input": false, "settings_changed": false]
if diagnosticDirectory != nil {result["diagnostic_files"] = diagnosticFiles; result["recognized_lines"] = recognizedLines}
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
