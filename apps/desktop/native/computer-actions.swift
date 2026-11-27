import AppKit
import ApplicationServices
import Foundation

// 原生动作只解释固定目标及窄参数；不执行脚本，不重试输入，也不请求系统授权。
struct ComputerActionTarget {
    let app: NSRunningApplication
    let window: AXUIElement
    let bounds: CGRect
    let id: Int
    let element: AXUIElement?
    let node: [String: Any]?

    init(_ request: [String: Any]) throws {
        guard AXIsProcessTrusted() else { try fail("permission_denied", "电脑动作需要已有辅助功能权限，未请求权限。") }
        guard let basis = request["basis"] as? [String: Any], let expectedApp = basis["app"] as? [String: Any],
              let pid = expectedApp["pid"] as? Int, let started = expectedApp["launched_at_ms"] as? Int64,
              let expectedWindow = basis["window"] as? [String: Any], let id = expectedWindow["window_id"] as? Int else {
            try fail("snapshot_invalid", "动作缺少原快照的应用启动身份和窗口。")
        }
        let app = try selectedApp(["pid": pid])
        guard processStartMilliseconds(app.processIdentifier) == started else { try fail("window_stale", "原进程启动身份已改变。") }
        let current = try windowInfo(pid, id)
        guard NSDictionary(dictionary: current).isEqual(to: expectedWindow),
              let frame = current["frame"] as? [String: Any] else { try fail("window_stale", "窗口状态、标题或尺寸已改变，请重新观察。") }
        let bounds = CGRect(x: frame["X"] as? Double ?? 0, y: frame["Y"] as? Double ?? 0,
                            width: frame["Width"] as? Double ?? 0, height: frame["Height"] as? Double ?? 0)
        let window = try resolveAXWindow(app, id, bounds)
        var element: AXUIElement?, node: [String: Any]?
        if let expected = basis["element"] as? [String: Any] {
            guard let route = expected["route"] as? [Int], route.count <= 64, let fingerprint = expected["action_fingerprint"] as? String else {
                try fail("snapshot_invalid", "原元素没有可校验的完整观察指纹。")
            }
            var currentElement = window
            for offset in route {
                guard offset >= 0 else { try fail("element_stale", "原元素路径无效。") }
                var children: CFArray?
                guard AXUIElementCopyAttributeValues(currentElement, kAXChildrenAttribute as CFString, offset, 1, &children) == .success,
                      let values = children as? [AXUIElement], values.count == 1 else { try fail("element_stale", "原元素路径已改变。") }
                currentElement = values[0]
            }
            let observed = describeAXElement(currentElement, bounds)
            guard observed["action_fingerprint"] as? String == fingerprint else { try fail("element_stale", "原元素的可观察属性或位置已改变。") }
            element = currentElement; node = observed
        }
        self.app = app; self.window = window; self.bounds = bounds; self.id = id; self.element = element; self.node = node
    }

    func unchangedWindow() throws {
        guard !app.isTerminated, processStartMilliseconds(app.processIdentifier) != nil else { try fail("window_stale", "原应用已退出。") }
        let current = try windowInfo(Int(app.processIdentifier), id)
        guard let frame = current["frame"] as? [String: Double],
              frame["X"] == bounds.minX, frame["Y"] == bounds.minY,
              frame["Width"] == bounds.width, frame["Height"] == bounds.height else { try fail("window_stale", "动作期间窗口位置已改变。") }
    }

    func foreground() throws {
        try unchangedWindow()
        guard isForeground() else {
            let active = axValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute)
            var activePID: pid_t = 0
            if let active, CFGetTypeID(active) == AXUIElementGetTypeID() { _ = AXUIElementGetPid(active as! AXUIElement, &activePID) }
            let focused = axValue(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute)
            let number = focused.flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? nativeWindowNumber($0 as! AXUIElement) : nil }
            try fail("focus_lost", "系统焦点进程\(activePID)与目标进程\(app.processIdentifier)、焦点窗口\(number ?? 0)与目标窗口\(id)未同时匹配，未改投其他窗口。")
        }
    }

    func isForeground() -> Bool {
        // 从系统级焦点对象核对当前接收应用，不使用Workspace通知缓存判定送达资格。
        guard let active = axValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute), CFGetTypeID(active) == AXUIElementGetTypeID() else { return false }
        let application = active as! AXUIElement;var pid: pid_t = 0
        guard AXUIElementGetPid(application, &pid) == .success, pid == app.processIdentifier,
              let focused = axValue(application, kAXFocusedWindowAttribute) else { return false }
        guard CFGetTypeID(focused) == AXUIElementGetTypeID() else { return false }
        return CFEqual(focused, window) || nativeWindowNumber(focused as! AXUIElement) == CGWindowID(id)
    }

    func focusWindow() throws {
        try unchangedWindow()
        if isForeground() { return }
        guard app.activate(options: []) else { try fail("focus_failed", "系统未接受原应用激活。") }
        _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(app.processIdentifier), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { try fail("focus_failed", "系统未接受原窗口聚焦。") }
        _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let deadline = Date().addingTimeInterval(2)
        while !isForeground() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
        try foreground()
    }

    func requiredElement() throws -> AXUIElement {
        guard let element, let node else { try fail("invalid_input", "此动作必须明确原快照中的元素。") }
        guard node["enabled"] as? Bool != false else { try fail("element_disabled", "原元素当前禁用。") }
        return element
    }

    func unchangedElement() throws {
        guard let element, let node else { return }
        guard describeAXElement(element, bounds)["action_fingerprint"] as? String == node["action_fingerprint"] as? String else { try fail("element_stale", "聚焦期间原元素属性或位置已改变，未继续发送输入。") }
    }

    func focusInput() throws {
        let target = try requiredElement()
        guard node?["secure"] as? Bool != true else { try fail("restricted_element", "安全输入字段不接受当前电脑文字或按键动作。") }
        func focused() -> Bool {
            guard let actual = axValue(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedUIElementAttribute) else { return false }
            return CFEqual(actual, target)
        }
        if focused() && isForeground() { return }
        let status = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let deadline = Date().addingTimeInterval(0.5)
        while (!focused() || !isForeground()) && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
        guard focused() else { try fail("focus_failed", "指定输入元素未获得系统焦点，原生状态\(status.rawValue)。") }
        try foreground()
    }

    func point(_ input: [String: Any]?) throws -> CGPoint {
        let relative: CGPoint
        if let input, let x = input["x"] as? Double, let y = input["y"] as? Double { relative = CGPoint(x: x, y: y) }
        else if let node, let frame = node["frame"] as? [String: Double], let x = frame["x"], let y = frame["y"], let width = frame["width"], let height = frame["height"] { relative = CGPoint(x: x + width/2, y: y + height/2) }
        else { try fail("invalid_input", "指针动作需要原元素或明确的窗口相对坐标。") }
        guard relative.x >= 0, relative.y >= 0, relative.x < bounds.width, relative.y < bounds.height else { try fail("point_out_of_bounds", "指针目标不在原窗口内部。") }
        return CGPoint(x: bounds.minX + relative.x, y: bounds.minY + relative.y)
    }

    func hit(_ point: CGPoint) throws {
        try foreground()
        var value: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &value) == .success, let value else { try fail("target_obscured", "无法核对指针下的原窗口。") }
        var pid: pid_t = 0
        guard AXUIElementGetPid(value, &pid) == .success else { try fail("target_obscured", "无法核对指针目标的进程。") }
        let owner = axValue(value, kAXWindowAttribute)
        // 网页可访问性叶节点可以由渲染子进程提供；所属原生窗口身份才是指针接收范围。
        let owned = CFEqual(value, window) || owner.map({ CFEqual($0, window) || CFGetTypeID($0) == AXUIElementGetTypeID() && nativeWindowNumber($0 as! AXUIElement) == CGWindowID(id) }) == true
        guard owned else { try fail("target_obscured", "指定位置不属于原窗口（节点进程\(pid)，目标进程\(app.processIdentifier)）。") }
    }
}

func settable(_ element: AXUIElement, _ attribute: String) throws {
    var allowed: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(element, attribute as CFString, &allowed) == .success, allowed.boolValue else { try fail("unsupported_capability", "指定原生属性当前不可写。") }
}

func keyboardEvent(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags = [], _ text: [UniChar]? = nil) throws -> CGEvent {
    guard let source = CGEventSource(stateID: .combinedSessionState), let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { try fail("input_unavailable", "系统未创建键盘事件。") }
    event.flags = flags
    if let text { text.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: text.count, unicodeString: $0.baseAddress) } }
    return event
}

func keyCode(_ key: String) -> CGKeyCode? {
    let codes: [String: CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46,"enter":36,"tab":48,"space":49,"backspace":51,"escape":53,"home":115,"pageup":116,"delete":117,"end":119,"pagedown":121,"left":123,"right":124,"down":125,"up":126]
    return codes[key]
}

func keyFlags(_ modifiers: [String]) -> CGEventFlags {
    var result: CGEventFlags = []
    for modifier in modifiers { switch modifier { case "command": result.insert(.maskCommand); case "control": result.insert(.maskControl); case "option": result.insert(.maskAlternate); case "shift": result.insert(.maskShift); default: break } }
    return result
}

func postKey(_ target: ComputerActionTarget, _ code: CGKeyCode, _ flags: CGEventFlags, _ text: [UniChar]? = nil) throws {
    guard CGPreflightPostEventAccess() else { try fail("permission_denied", "系统未允许输入事件派发，未请求权限。") }
    let down = try keyboardEvent(code, true, flags, text), up = try keyboardEvent(code, false, flags)
    try target.foreground();try target.unchangedElement(); actionDispatchStarted = true
    let modifiers: [(CGKeyCode, CGEventFlags)] = [(55,.maskCommand),(59,.maskControl),(58,.maskAlternate),(56,.maskShift)].filter { flags.contains($0.1) }
    var active: CGEventFlags = []
    for (key, modifier) in modifiers { active.insert(modifier);try keyboardEvent(key,true,active).postToPid(target.app.processIdentifier) }
    down.postToPid(target.app.processIdentifier);usleep(20000);up.postToPid(target.app.processIdentifier)
    for (key, modifier) in modifiers.reversed() { active.remove(modifier);try keyboardEvent(key,false,active).postToPid(target.app.processIdentifier) }
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}

func postText(_ target: ComputerActionTarget, _ text: String) throws {
    guard CGPreflightPostEventAccess() else { try fail("permission_denied", "系统未允许输入事件派发，未请求权限。") }
    let events = try text.flatMap { character -> [CGEvent] in [try keyboardEvent(0, true, [], Array(String(character).utf16)),try keyboardEvent(0, false)] }
    try target.foreground();try target.unchangedElement();actionDispatchStarted = true
    for event in events { try target.foreground();event.postToPid(target.app.processIdentifier) }
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}

func performComputerAction(_ request: [String: Any]) throws -> [String: Any] {
    guard let action = request["action"] as? [String: Any], let kind = action["kind"] as? String else { try fail("invalid_input", "缺少固定电脑动作。") }
    let target = try ComputerActionTarget(request)
    var delivery = "ax_acknowledged", detail: [String: Any] = [:]
    switch kind {
    case "focus_window":
        actionDispatchStarted = true; try target.focusWindow()
    case "focus_element":
        _ = try target.requiredElement(); actionDispatchStarted = true; try target.focusWindow(); try target.focusInput()
    case "perform_action":
        let element = try target.requiredElement()
        guard let name = action["name"] as? String, (target.node?["actions"] as? [String])?.contains(name) == true else { try fail("unsupported_capability", "原元素未报告此辅助动作。") }
        actionDispatchStarted = true
        guard AXUIElementPerformAction(element, name as CFString) == .success else { try fail("action_failed", "原生辅助动作没有返回成功。") }
    case "set_value":
        let element = try target.requiredElement()
        guard target.node?["secure"] as? Bool != true, let text = action["text"] as? String else { try fail("restricted_element", "当前设值动作不支持安全字段。") }
        try settable(element, kAXValueAttribute)
        actionDispatchStarted = true
        guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString) == .success else { try fail("action_failed", "原生设值没有返回成功。") }
    case "type_text", "paste", "press_key":
        _ = try target.requiredElement()
        guard target.node?["secure"] as? Bool != true else { try fail("restricted_element", "安全输入字段不接受当前电脑文字或按键动作。") }
        if kind == "press_key" {
            guard let key = action["key"] as? String, keyCode(key) != nil else { try fail("unsupported_capability", "按键不在当前原生目录中。") }
            let modifiers = action["modifiers"] as? [String] ?? []
            if modifiers.contains("command") && key == "tab" || modifiers.contains("command") && modifiers.contains("option") && key == "escape" || modifiers.contains("command") && modifiers.contains("control") && key == "q" { try fail("restricted_shortcut", "此系统级快捷键不属于当前窗口动作。") }
        }
        actionDispatchStarted = true; try target.focusWindow(); try target.focusInput(); delivery = "event_posted"
        if kind == "type_text" {
            guard let text = action["text"] as? String else { try fail("invalid_input", "缺少文字。") }
            // 字符只放在按下事件中，避免Electron在抬起时重复插入。
            try postText(target, text)
        } else if kind == "press_key" {
            try postKey(target, keyCode(action["key"] as! String)!, keyFlags(action["modifiers"] as? [String] ?? []))
        } else { detail["clipboard"] = try pasteText(target, action["text"] as! String) }
    case "click", "scroll", "drag":
        let point = try target.point(action["position"] as? [String: Any])
        let destination = kind == "drag" ? try target.point(action["to"] as? [String: Any]) : point
        actionDispatchStarted = true; try target.focusWindow();try target.unchangedElement();try target.hit(point)
        if kind == "drag" { try target.hit(destination) }
        delivery = "event_posted"
        if kind == "click" {
            let secondary = action["button"] as? String == "secondary", button: CGMouseButton = secondary ? .right : .left
            for count in 1...(action["count"] as? Int ?? 1) {
                try target.hit(point)
                guard let down = CGEvent(mouseEventSource: nil, mouseType: secondary ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: point, mouseButton: button), let up = CGEvent(mouseEventSource: nil, mouseType: secondary ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: point, mouseButton: button) else { try fail("input_unavailable", "系统未创建点击事件。") }
                down.setIntegerValueField(.mouseEventClickState, value: Int64(count));up.setIntegerValueField(.mouseEventClickState, value: Int64(count))
                down.post(tap: .cghidEventTap);up.post(tap: .cghidEventTap);usleep(25000)
            }
        } else if kind == "scroll" {
            guard let wheel = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(action["dy"] as? Int ?? 0), wheel2: Int32(action["dx"] as? Int ?? 0), wheel3: 0) else { try fail("input_unavailable", "系统未创建滚动事件。") }
            guard CGWarpMouseCursorPosition(point) == .success else { try fail("input_unavailable", "系统未接受原窗口内的指针定位。") }
            let source = CGEventSource(stateID: .combinedSessionState);source?.localEventsSuppressionInterval = 0
            CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
            RunLoop.current.run(until: Date().addingTimeInterval(0.08));try target.hit(point)
            guard let actual = CGEvent(source: nil)?.location, abs(actual.x-point.x)<2, abs(actual.y-point.y)<2 else { try fail("pointer_interrupted", "指针已被接管，未继续发送滚动。") }
            wheel.location = point;wheel.setIntegerValueField(.scrollWheelEventIsContinuous,value:1);wheel.post(tap: .cghidEventTap)
            RunLoop.current.run(until: Date().addingTimeInterval(0.15))
        } else {
            let duration = action["duration_ms"] as? Int ?? 400, steps = max(2, min(40, duration/25))
            guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) else { try fail("input_unavailable", "系统未创建拖放事件。") }
            down.post(tap: .cghidEventTap)
            var last = point
            defer { CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: last, mouseButton: .left)?.post(tap: .cghidEventTap) }
            for step in 1...steps {
                try target.foreground()
                last = CGPoint(x: point.x + (destination.x-point.x)*Double(step)/Double(steps), y: point.y + (destination.y-point.y)*Double(step)/Double(steps))
                CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: last, mouseButton: .left)?.post(tap: .cghidEventTap)
                usleep(useconds_t(duration*1000/steps))
            }
        }
    case "move_resize":
        guard let frame = action["frame"] as? [String: Double], let x = frame["x"], let y = frame["y"], let width = frame["width"], let height = frame["height"] else { try fail("invalid_input", "缺少完整窗口位置与尺寸。") }
        let proposed = CGRect(x: x, y: y, width: width, height: height)
        guard NSScreen.screens.contains(where: { screen in let frame = CGRect(x: screen.frame.minX, y: NSScreen.screens[0].frame.maxY-screen.frame.maxY, width: screen.frame.width, height: screen.frame.height); let overlap = frame.intersection(proposed); return overlap.width >= 100 && overlap.height >= 100 }) else { try fail("point_out_of_bounds", "窗口必须保留可见的接管区域。") }
        try settable(target.window, kAXPositionAttribute);try settable(target.window, kAXSizeAttribute)
        var position = CGPoint(x: x, y: y), size = CGSize(width: width, height: height)
        guard let positionValue = AXValueCreate(.cgPoint, &position), let sizeValue = AXValueCreate(.cgSize, &size) else { try fail("invalid_input", "窗口几何值无效。") }
        actionDispatchStarted = true
        guard AXUIElementSetAttributeValue(target.window, kAXSizeAttribute as CFString, sizeValue) == .success,
              AXUIElementSetAttributeValue(target.window, kAXPositionAttribute as CFString, positionValue) == .success else { try fail("action_failed", "窗口位置或尺寸未全部明确完成。") }
    default:
        try fail("unsupported_capability", "当前原生提供方不支持此动作。")
    }
    return ["delivery": delivery, "action": kind, "detail": detail, "target_validation": target.element == nil ? "window_identity" : "window_and_snapshot_route_with_observable_fingerprint", "work_completion_authority": false]
}

func pasteText(_ target: ComputerActionTarget, _ text: String) throws -> [String: Any] {
    let board = NSPasteboard.general
    var previous: [[NSPasteboard.PasteboardType: Data]] = [], size = 0
    let before = board.changeCount
    for item in board.pasteboardItems ?? [] {
        var values: [NSPasteboard.PasteboardType: Data] = [:]
        for type in item.types {
            guard let bytes = item.data(forType: type) else { try fail("clipboard_unavailable", "原剪贴板不能完整保存，未替换内容。") }
            size += bytes.count
            guard size <= 2*1024*1024 else { try fail("clipboard_budget_exceeded", "原剪贴板超过临时保存预算，未替换内容。") }
            values[type] = bytes
        }
        previous.append(values)
    }
    guard board.changeCount == before else { try fail("clipboard_changed", "保存期间剪贴板已改变，未替换内容。") }
    board.clearContents();guard board.setString(text, forType: .string) else { try fail("clipboard_unavailable", "剪贴板未接受本次文字。") }
    let owned = board.changeCount
    func restore() -> String {
        guard board.changeCount == owned else { return "skipped_external_change" }
        board.clearContents()
        let items = previous.map { values -> NSPasteboardItem in let item = NSPasteboardItem();for (type, bytes) in values { item.setData(bytes, forType: type) };return item }
        return items.isEmpty || board.writeObjects(items) ? "restored" : "restore_failed"
    }
    do {
        try postKey(target, 9, .maskCommand)
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        return ["restoration": restore(), "raw_content_persisted": false]
    } catch { _ = restore();throw error }
}

func launchComputerApplication(_ request: [String: Any]) throws -> [String: Any] {
    guard let path = request["app_path"] as? String, path.hasPrefix("/"), path.hasSuffix(".app") else { try fail("invalid_input", "应用启动需要明确的绝对.app目录，不接受脚本参数。") }
    let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
    guard let bundle = Bundle(url: url), bundle.bundleIdentifier != nil, let executable = bundle.executableURL, FileManager.default.isExecutableFile(atPath: executable.path) else { try fail("app_not_found", "指定目录不是可启动应用。") }
    let existing = runningApps().filter { $0.bundleURL?.resolvingSymlinksInPath() == url }
    guard existing.count <= 1 else { try fail("app_ambiguous", "此应用已有多个实例，请按实际PID选择窗口。") }
    let activate = request["activate"] as? Bool ?? false
    if let app = existing.first {
        if activate { actionDispatchStarted = true;guard app.activate(options: [.activateIgnoringOtherApps]) else { try fail("focus_failed", "原应用未接受激活。") } }
        return ["app": appInfo(app), "launched": false, "delivery": "existing_application", "work_completion_authority": false]
    }
    let configuration = NSWorkspace.OpenConfiguration();configuration.activates = activate;configuration.arguments = []
    var launched: NSRunningApplication?, problem: Error?, completed = false
    actionDispatchStarted = true
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in launched = app;problem = error;completed = true }
    let deadline = Date().addingTimeInterval(5)
    while !completed && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
    guard completed, problem == nil, let app = launched else { try fail("launch_unknown", "应用启动未返回明确身份；请查询原操作，不重复启动。") }
    return ["app": appInfo(app), "launched": true, "delivery": "launch_acknowledged", "work_completion_authority": false]
}
