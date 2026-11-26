import ApplicationServices
import Foundation

// 只读检查指定隔离应用，不申请系统权限，不操作窗口或键盘。
let arguments = CommandLine.arguments
guard (2...3).contains(arguments.count),
      let pid = Int32(arguments[1]), pid > 1 else {
    fputs("用法：inspect-macos-ax <隔离应用PID> [匹配文字，默认引擎]\n", stderr)
    exit(2)
}
let query = arguments.count == 3 ? arguments[2] : "引擎"
guard !query.isEmpty else { exit(2) }

let trusted = AXIsProcessTrusted()
let application = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(application, 2)
let deadline = Date().addingTimeInterval(10)
var matches: [[String: String]] = []
var visited = 0
var truncated = false
var readErrors = 0

func read(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, key as CFString, &value)
    if result == .success { return value }
    if result != .attributeUnsupported && result != .noValue { readErrors += 1 }
    return nil
}

func visit(_ element: AXUIElement, _ depth: Int) {
    guard depth <= 30, visited < 1500, Date() < deadline else {
        truncated = true
        return
    }
    visited += 1
    let fields = [
        "role": kAXRoleAttribute, "title": kAXTitleAttribute,
        "description": kAXDescriptionAttribute, "help": kAXHelpAttribute,
        "value": kAXValueAttribute,
    ].mapValues { read(element, $0) as? String ?? "" }
    if fields.values.contains(where: { $0.contains(query) }) { matches.append(fields) }
    for child in read(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
        if Date() >= deadline || visited >= 1500 { truncated = true; break }
        visit(child, depth + 1)
    }
}

if trusted { visit(application, 0) }
let result: [String: Any] = [
    "source": "macOS AXUIElement", "trusted": trusted,
    "visited": visited, "truncated": truncated,
    "read_errors": readErrors, "matches": matches,
]
let bytes = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: bytes, encoding: .utf8)!)
if !trusted { exit(3) }
