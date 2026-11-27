import AppKit
import ApplicationServices
import Foundation
import Darwin
import Vision
import CryptoKit

// 本机适配器不请求系统授权，观察与动作回执都不构成知识成果。
var actionDispatchStarted = false
struct ObservationError: Error {
    let code: String
    let message: String
}

func fail(_ code: String, _ message: String) throws -> Never {
    throw ObservationError(code: code, message: message)
}

func processStartMilliseconds(_ pid: pid_t) -> Int64? {
    var info = kinfo_proc(), query: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    var size = MemoryLayout<kinfo_proc>.stride
    guard sysctl(&query, UInt32(query.count), &info, &size, nil, 0) == 0,
          size == MemoryLayout<kinfo_proc>.stride, info.kp_proc.p_starttime.tv_sec > 0 else { return nil }
    return Int64(info.kp_proc.p_starttime.tv_sec) * 1000 + Int64(info.kp_proc.p_starttime.tv_usec) / 1000
}

func appInfo(_ app: NSRunningApplication) -> [String: Any] {
    var value: [String: Any] = [
        "pid": Int(app.processIdentifier),
        "name": app.localizedName ?? "未命名应用",
        "accessory": app.activationPolicy == .accessory
    ]
    if let bundle = app.bundleIdentifier { value["bundle_id"] = bundle }
    // 直接启动的应用可能没有Launch Services日期；内核启动时间仍可围栏PID复用。
    if let launch = processStartMilliseconds(app.processIdentifier) { value["launched_at_ms"] = launch }
    return value
}

func runningApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter {
        !$0.isTerminated && $0.activationPolicy != .prohibited
    }.sorted {
        let a = $0.localizedName ?? "", b = $1.localizedName ?? ""
        return a == b ? $0.processIdentifier < $1.processIdentifier : a < b
    }
}

func selectedApp(_ query: [String: Any]) throws -> NSRunningApplication {
    let apps = runningApps().filter { app in
        if let pid = query["pid"] as? Int { return Int(app.processIdentifier) == pid }
        if let bundle = query["bundle_id"] as? String { return app.bundleIdentifier == bundle }
        if let name = query["name"] as? String { return app.localizedName == name }
        return false
    }
    if apps.isEmpty { try fail("app_not_found", "未发现明确指定的运行应用。") }
    if apps.count != 1 { try fail("app_ambiguous", "存在多个匹配应用，请用实际PID重新指定。") }
    return apps[0]
}

func page(_ rows: [[String: Any]], _ request: [String: Any]) -> [String: Any] {
    let offset = request["offset"] as? Int ?? 0, limit = request["limit"] as? Int ?? 64
    let end = min(rows.count, offset + limit)
    let values = offset < rows.count ? Array(rows[offset..<end]) : []
    var value: [String: Any] = ["items": values, "offset": offset, "total_count": rows.count, "complete": end >= rows.count]
    if end < rows.count { value["next_offset"] = end }
    return value
}

func observe(_ request: [String: Any]) throws -> [String: Any] {
    switch request["method"] as? String {
    case "permissions":
        return ["accessibility": AXIsProcessTrusted(), "screen_capture": CGPreflightScreenCaptureAccess(), "post_event": CGPreflightPostEventAccess(), "prompt_requested": false]
    case "apps":
        return page(runningApps().map(appInfo), request)
    case "windows":
        guard let query = request["app"] as? [String: Any] else {
            try fail("invalid_input", "窗口发现需要明确的应用选择。")
        }
        let app = try selectedApp(query)
        guard let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            try fail("observation_unavailable", "系统没有返回窗口目录。")
        }
        let windows = rows.compactMap { row -> [String: Any]? in
            guard let pid = row[kCGWindowOwnerPID as String] as? Int, pid == Int(app.processIdentifier),
                  let layer = row[kCGWindowLayer as String] as? Int,
                  let id = row[kCGWindowNumber as String] as? Int,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any],
                  let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double,
                  width > 0, height > 0 else { return nil }
            var window: [String: Any] = ["window_id": id, "pid": pid, "frame": bounds, "layer": layer,
                "on_screen": row[kCGWindowIsOnscreen as String] as? Bool ?? false,
                "title_available": row[kCGWindowName as String] is String]
            if let title = row[kCGWindowName as String] as? String { window["title"] = title }
            return window
        }.sorted { ($0["window_id"] as! Int) < ($1["window_id"] as! Int) }
        var result = page(windows, request)
        result["app"] = appInfo(app)
        result["window_titles_require_screen_capture_permission"] = !CGPreflightScreenCaptureAccess()
        return result
    case "snapshot":
        return try captureSnapshot(request)
    case "act":
        return try performComputerAction(request)
    case "launch":
        return try launchComputerApplication(request)
    default:
        try fail("unsupported_capability", "当前原生观察适配器未实现此动作。")
    }
}

func axValue(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func axFrame(_ element: AXUIElement) -> CGRect? {
    guard let position = axValue(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = axValue(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var origin = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
          AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: origin, size: dimensions)
}

func windowInfo(_ pid: Int, _ id: Int) throws -> [String: Any] {
    let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]] ?? []
    guard let row = rows.first(where: { ($0[kCGWindowNumber as String] as? Int) == id && ($0[kCGWindowOwnerPID as String] as? Int) == pid }),
          let bounds = row[kCGWindowBounds as String] as? [String: Any] else {
        try fail("window_not_found", "原应用的指定窗口已不存在。")
    }
    return ["window_id": id, "pid": pid, "frame": bounds,
        "on_screen": row[kCGWindowIsOnscreen as String] as? Bool ?? false,
        "title": row[kCGWindowName as String] as? String ?? ""]
}

func nativeWindowNumber(_ window: AXUIElement) -> CGWindowID? {
    typealias WindowLookup = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
    if let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") {
        let lookup = unsafeBitCast(symbol, to: WindowLookup.self);var number: CGWindowID = 0
        if lookup(window, &number) == .success && number != 0 { return number }
    }
    return (axValue(window, "AXWindowNumber") as? NSNumber).map { CGWindowID($0.uint32Value) }
}

func resolveAXWindow(_ app: NSRunningApplication, _ id: Int, _ bounds: CGRect) throws -> AXUIElement {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.3)
    var value: CFArray?
    let status = AXUIElementCopyAttributeValues(root, kAXWindowsAttribute as CFString, 0, 128, &value)
    guard status == .success, let windows = value as? [AXUIElement] else {
        try fail("accessibility_error", "应用没有返回可观察窗口，未选择其他窗口。")
    }
    typealias WindowLookup = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
    let lookup = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow").map { unsafeBitCast($0, to: WindowLookup.self) }
    var geometry: [AXUIElement] = []
    for window in windows {
        AXUIElementSetMessagingTimeout(window, 0.3)
        var number: CGWindowID = 0
        if let lookup {
            let found = lookup(window, &number)
            if found == .success && number != 0 {
                if number == id { return window }
                continue
            }
            if found != .attributeUnsupported && found != .noValue { continue }
        }
        if let native = axValue(window, "AXWindowNumber") as? NSNumber {
            if native.intValue == id { return window }
            continue
        }
        if let frame = axFrame(window), abs(frame.minX - bounds.minX) < 1, abs(frame.minY - bounds.minY) < 1,
           abs(frame.width - bounds.width) < 1, abs(frame.height - bounds.height) < 1 { geometry.append(window) }
    }
    guard geometry.count == 1 else { try fail("window_stale", "无法唯一核对指定窗口的辅助功能身份。") }
    return geometry[0]
}

func describeAXElement(_ element: AXUIElement, _ bounds: CGRect) -> [String: Any] {
    AXUIElementSetMessagingTimeout(element, 0.2)
    let role = axValue(element, kAXRoleAttribute) as? String ?? "AXUnknown", subrole = axValue(element, kAXSubroleAttribute) as? String ?? ""
    let secure = subrole == "AXSecureTextField" || role == "AXSecureTextField"
    var node: [String: Any] = ["role": role, "secure": secure]
    for (key, attribute) in [("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute), ("identifier", kAXIdentifierAttribute)] {
        if let value = axValue(element, attribute) as? String, !value.isEmpty { node[key] = value }
    }
    if !subrole.isEmpty { node["subrole"] = subrole }
    if !secure, let value = axValue(element, kAXValueAttribute) {
        if let text = value as? String { node["value"] = text }
        else if let number = value as? NSNumber { node["value"] = number }
    }
    if let enabled = axValue(element, kAXEnabledAttribute) as? Bool { node["enabled"] = enabled }
    if let frame = axFrame(element) { node["frame"] = ["x": Double(frame.minX - bounds.minX), "y": Double(frame.minY - bounds.minY), "width": Double(frame.width), "height": Double(frame.height)] }
    var actions: CFArray?
    if AXUIElementCopyActionNames(element, &actions) == .success, let values = actions as? [String] { node["actions"] = Array(values.prefix(32)).sorted() }
    // 完整可观察属性参与动作前校验；它不是跨快照原生元素身份。
    if let bytes = try? JSONSerialization.data(withJSONObject: node, options: [.sortedKeys]), bytes.count <= 65536 {
        node["action_fingerprint"] = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    if let focused = axValue(element, kAXFocusedAttribute) as? Bool { node["focused"] = focused }
    return node
}

func captureSnapshot(_ request: [String: Any]) throws -> [String: Any] {
    guard let query = request["app"] as? [String: Any], let id = request["window_id"] as? Int else {
        try fail("invalid_input", "快照需要明确的应用和窗口身份。")
    }
    let app = try selectedApp(query), before = try windowInfo(Int(app.processIdentifier), id)
    let rawBounds = before["frame"] as! [String: Any]
    let bounds = CGRect(x: rawBounds["X"] as? Double ?? 0, y: rawBounds["Y"] as? Double ?? 0,
        width: rawBounds["Width"] as? Double ?? 0, height: rawBounds["Height"] as? Double ?? 0)
    let window: AXUIElement
    do {
        guard AXIsProcessTrusted() else { try fail("permission_denied", "辅助功能权限未授予；读取未发起权限请求。") }
        window = try resolveAXWindow(app, id, bounds)
    } catch {
        // 截图只绑定原CG窗口；缺少AX身份时不生成可操作元素或选择替代窗口。
        guard request["screenshot"] as? Bool != false else { throw error }
        let pixels = capturePixels(id, bounds, [], request["screenshot"] as? [String: Any] ?? [:])
        guard let image = pixels["image"] else { throw error }
        let after = try windowInfo(Int(app.processIdentifier), id)
        guard NSDictionary(dictionary: before).isEqual(to: after), !app.isTerminated else {
            try fail("window_stale", "截图期间原窗口已变化，请重新观察。")
        }
        let problem = error as? ObservationError
        var result: [String: Any] = ["app": appInfo(app), "window": before, "coordinate_space": "window",
            "elements": [[String: Any]](), "screenshot": image, "screenshot_status": pixels["status"] ?? [:],
            "accessibility_status": ["state": "unavailable", "code": problem?.code ?? "accessibility_unavailable"],
            "truncation": ["truncated": true, "reasons": ["accessibility_unavailable"]]]
        if let ocr = pixels["ocr"] { result["ocr"] = ocr }
        return result
    }
    let maxNodes = request["max_nodes"] as? Int ?? 500, maxDepth = request["max_depth"] as? Int ?? 24
    let deadline = Date().addingTimeInterval(4)
    var nodes: [[String: Any]] = [], seen: [AXUIElement] = [], textBytes = 0, truncated = false, reasons = Set<String>()
    func bounded(_ raw: String) -> String {
        let result = String(raw.prefix(1024))
        textBytes += result.utf8.count
        if result != raw { truncated = true; reasons.insert("field_limit") }
        return result
    }
    func visit(_ element: AXUIElement, _ parent: Int?, _ depth: Int, _ route: [Int]) {
        if nodes.count >= maxNodes { truncated = true; reasons.insert("node_limit"); return }
        if depth > maxDepth { truncated = true; reasons.insert("depth_limit"); return }
        if textBytes >= 160_000 { truncated = true; reasons.insert("text_limit"); return }
        if Date() >= deadline { truncated = true; reasons.insert("deadline"); return }
        if seen.contains(where: { CFEqual($0, element) }) { return }
        seen.append(element)
        let index = nodes.count
        var node = describeAXElement(element, bounds)
        if node["role"] as? String == "AXUnknown" { truncated = true; reasons.insert("unreadable_element") }
        node["index"] = index; node["depth"] = depth; node["route"] = route
        if let parent { node["parent_index"] = parent }
        for key in ["title", "description", "identifier", "value"] { if let value = node[key] as? String { node[key] = bounded(value) } }
        nodes.append(node)
        var count: CFIndex = 0
        let childStatus = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
        if childStatus != .success {
            if childStatus != .attributeUnsupported && childStatus != .noValue { truncated = true; reasons.insert("unreadable_children") }
            return
        }
        if count == 0 { return }
        if depth == maxDepth { truncated = true; reasons.insert("depth_limit"); return }
        let budget = max(0, min(count, maxNodes - nodes.count))
        if budget < count { truncated = true; reasons.insert("node_limit") }
        if budget == 0 { return }
        var children: CFArray?
        if AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, budget, &children) == .success, let values = children as? [AXUIElement] {
            for (offset, child) in values.enumerated() { visit(child, index, depth + 1, route + [offset]) }
        } else { truncated = true; reasons.insert("unreadable_children") }
    }
    visit(window, nil, 0, [])
    var result: [String: Any] = ["app": appInfo(app), "window": before, "coordinate_space": "window",
        "accessibility_status": ["state": "available"],
        "elements": nodes, "truncation": ["truncated": truncated, "reasons": reasons.sorted(), "max_nodes": maxNodes, "max_depth": maxDepth],
        "screenshot_status": ["state": "skipped", "reason": "not_requested"]]
    if request["screenshot"] as? Bool != false {
        let pixels = capturePixels(id, bounds, nodes, request["screenshot"] as? [String: Any] ?? [:])
        result["screenshot_status"] = pixels["status"]
        if let screenshot = pixels["image"] { result["screenshot"] = screenshot }
        if let ocr = pixels["ocr"] { result["ocr"] = ocr }
    }
    let after = try windowInfo(Int(app.processIdentifier), id)
    if !NSDictionary(dictionary: before).isEqual(to: after) || app.isTerminated { try fail("window_stale", "观察期间窗口已变化，请重新读取指定窗口。") }
    return result
}

func capturePixels(_ id: Int, _ bounds: CGRect, _ nodes: [[String: Any]], _ options: [String: Any]) -> [String: Any] {
    func failure(_ code: String) -> [String: Any] { ["status": ["state": "failed", "code": code]] }
    guard CGPreflightScreenCaptureAccess() else { return failure("permission_denied") }
    guard let original = CGWindowListCreateImage(.null, [.optionIncludingWindow], CGWindowID(id), [.boundsIgnoreFraming, .bestResolution]) else { return failure("screenshot_failed") }
    var crop = CGRect(origin: .zero, size: bounds.size)
    if let selected = options["crop"] as? [String: Any] {
        crop = CGRect(x: selected["x"] as? Double ?? 0, y: selected["y"] as? Double ?? 0,
            width: selected["width"] as? Double ?? 0, height: selected["height"] as? Double ?? 0)
        guard crop.width > 0, crop.height > 0, crop.minX >= 0, crop.minY >= 0,
              crop.maxX <= bounds.width, crop.maxY <= bounds.height else { return failure("crop_out_of_bounds") }
    }
    let cropPixels = CGRect(x: crop.minX * Double(original.width)/bounds.width, y: crop.minY * Double(original.height)/bounds.height,
        width: crop.width * Double(original.width)/bounds.width, height: crop.height * Double(original.height)/bounds.height)
    guard let source = original.cropping(to: cropPixels) else { return failure("screenshot_failed") }
    let maxEdge = options["max_edge"] as? Int ?? 1600
    let scale = min(1, Double(maxEdge) / Double(max(source.width, source.height)))
    let width = max(1, Int(Double(source.width)*scale)), height = max(1, Int(Double(source.height)*scale))
    guard let target = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: target) else { return failure("screenshot_failed") }
    NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current = context
    NSImage(cgImage: source, size: NSSize(width: width, height: height)).draw(in: NSRect(x: 0, y: 0, width: width, height: height))
    if options["annotate"] as? Bool == true {
        let xScale = Double(width)/crop.width, yScale = Double(height)/crop.height
        for node in nodes {
            guard let frame = node["frame"] as? [String: Double], let index = node["index"] as? Int,
                  let x = frame["x"], let y = frame["y"], let w = frame["width"], let h = frame["height"], w > 2, h > 2 else { continue }
            let rect = NSRect(x: (x-crop.minX)*xScale, y: Double(height)-(y-crop.minY+h)*yScale, width: w*xScale, height: h*yScale)
            guard rect.intersects(NSRect(x: 0, y: 0, width: width, height: height)) else { continue }
            NSColor.systemRed.setStroke();let path = NSBezierPath(rect: rect);path.lineWidth = 1;path.stroke()
            (String(index) as NSString).draw(at: rect.origin, withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 10, weight: .bold), .foregroundColor: NSColor.white, .backgroundColor: NSColor.systemRed])
        }
    }
    NSGraphicsContext.restoreGraphicsState()
    let format = options["format"] as? String ?? "png"
    guard let bytes = target.representation(using: format == "jpeg" ? .jpeg : .png, properties: [.compressionFactor: 0.85]), bytes.count <= 4*1024*1024 else { return failure("screenshot_budget_exceeded") }
    var result: [String: Any] = ["status": ["state": "captured", "engine": "cg_window_list"],
        "image": ["data": bytes.base64EncodedString(), "format": format, "width": width, "height": height,
            "scale": Double(width)/crop.width, "crop": ["x": crop.minX, "y": crop.minY, "width": crop.width, "height": crop.height], "annotated": options["annotate"] as? Bool ?? false]]
    if options["ocr"] as? Bool == true {
        let recognition = VNRecognizeTextRequest();recognition.recognitionLevel = .accurate
        recognition.automaticallyDetectsLanguage = true;recognition.usesLanguageCorrection = false
        do {
            try VNImageRequestHandler(cgImage: source).perform([recognition])
            let text = (recognition.results ?? []).prefix(128).compactMap { row -> [String: Any]? in
                guard let candidate = row.topCandidates(1).first else { return nil }
                return ["text": String(candidate.string.prefix(1024)), "confidence": candidate.confidence,
                    "frame": ["x": crop.minX + row.boundingBox.minX*crop.width, "y": crop.minY + (1-row.boundingBox.maxY)*crop.height,
                        "width": row.boundingBox.width*crop.width, "height": row.boundingBox.height*crop.height]]
            }
            result["ocr"] = ["state": "completed", "coordinate_space": "window", "items": text, "truncated": (recognition.results?.count ?? 0)>128]
        } catch { result["ocr"] = ["state": "failed", "code": "ocr_failed"] }
    }
    return result
}

@main
struct ComputerCommand {
static func main() {
do {
    let input = FileHandle.standardInput.readData(ofLength: 65537)
    if input.count > 65536 { try fail("invalid_input", "电脑观察请求超过预算。") }
    guard let request = try JSONSerialization.jsonObject(with: input) as? [String: Any] else {
        try fail("invalid_input", "电脑观察请求必须是JSON对象。")
    }
    let data = try observe(request)
    let response: [String: Any] = ["protocol_version": 1, "ok": true, "data": data]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]))
} catch {
    let problem = error as? ObservationError ?? ObservationError(code: "observation_failed", message: "本机电脑观察未完成。")
    let response: [String: Any] = ["protocol_version": 1, "ok": false, "dispatch_started": actionDispatchStarted, "error": ["code": problem.code, "message": problem.message]]
    if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
    }
}
}
}
