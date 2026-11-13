import Foundation
import HetuCore
import HetuNative
import AppKit
import WebKit

private struct LocalViewTestFailure: Error { let message: String }
private func localCheck(_ condition: Bool, _ message: String) throws { if !condition { throw LocalViewTestFailure(message: message) } }

enum LocalTaskViewTests {
    @MainActor static func run(root: URL) async throws {
        let runtime = ProcessInfo.processInfo.environment["HETU_TEST_NODE"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("build/native/Hetu.app/Contents/Helpers/node")
        try localCheck(FileManager.default.isExecutableFile(atPath: runtime.path), "未装配本地页面运行时，请先执行 tools/build-native.py")
        let directory = root.appendingPathComponent("本地页面任务")
        let author = try await Workspace.open(at: directory, mode: .author, title: "雾港", operationKey: "local-view-book")
        let capabilities = try await author.data("hetu.capabilities.get")
        let preview = try await author.data("hetu.creative_tasks.preview_prompt", input: ["scope_ref": capabilities["scope_ref"], "task_kind": .string("book_concept"), "brief": .string("准备两个中文书名参考"), "input_refs": .array([]), "client_adapter": .string("codex"), "language_tag": .string("zh-CN")])
        var prepared = preview["prepare_input"].object; prepared["operation_key"] = .string("local-view-prepare")
        let task = try await author.data("hetu.creative_tasks.prepare", input: prepared)
        let ref = task["task_ref"]
        let candidate: JSONValue = .object(["kind": .string("title"), "title": .string("方案一"), "source_format": .string("plain"), "source_ref_indices": .array([]), "content": .string("雾港听潮")])
        _ = try await author.data("hetu.creative_tasks.submit_result", input: ["task_ref": ref, "request_sha256": task["request_sha256"], "candidates": .array([candidate]), "complete": .bool(true), "missing_items": .array([]), "provenance": .object(["client": .string("native-local-test"), "skill_version": .string("1")]), "operation_key": .string("local-view-result")])
        let manager = LocalTaskViewSession()
        defer { manager.stop() }
        await manager.start(root: directory, scope: .workspace, taskRef: ref, locale: "en", theme: "dark", runtime: runtime)
        try await wait("启动任务页面") { manager.url != nil || manager.errorKey != nil }
        guard let origin = manager.url else { throw LocalViewTestFailure(message: "原生管理器未启动任务页面：\(manager.errorKey ?? "unknown")") }
        let browser = URLSession(configuration: .ephemeral)
        defer { browser.invalidateAndCancel() }
        func request(_ path: String, body: JSONValue? = nil, csrf: String? = nil) async throws -> (JSONValue, Int) {
            var value = URLRequest(url: origin.appendingPathComponent(path))
            if let body {
                value.httpMethod = "POST"; value.httpBody = try body.encoded()
                value.setValue("application/json", forHTTPHeaderField: "Content-Type")
                value.setValue(String(origin.absoluteString.dropLast()), forHTTPHeaderField: "Origin")
                if let csrf { value.setValue(csrf, forHTTPHeaderField: "X-Hetu-CSRF") }
            }
            let (bytes, response) = try await browser.data(for: value)
            return (try JSONDecoder().decode(JSONValue.self, from: bytes), (response as! HTTPURLResponse).statusCode)
        }
        let (session, _) = try await request("api/session")
        try localCheck(session["task_ref"] == .null && session["state"].string == "unpaired", "未配对页面泄露任务范围")
        let csrf = session["csrf"].string!
        let (_, invalidCSRF) = try await request("api/pair", body: .object([:]))
        try localCheck(invalidCSRF == 403 && manager.pairing.isEmpty, "浏览器绕过CSRF发起配对")
        _ = try await request("api/pair", body: .object([:]), csrf: csrf)
        try await wait("收到浏览器配对请求") { !manager.pairing.isEmpty }
        let pairing = manager.pairing[0]
        let (pending, _) = try await request("api/session")
        try localCheck(pending["code"].string == pairing.code && pending["state"].string == "pending", "原生配对码与浏览器不符")
        manager.approve(pairing)
        // 批准通过进程管道发送，等待 Node 实际完成授权后再验证任务范围。
        let paired = try await waitForPairing { try await request("api/session") }
        try localCheck(paired["state"].string == "paired" && paired["task_ref"] == ref, "原生作者确认未限定当前任务")
        func tool(_ name: String, input: [String: JSONValue]) -> JSONValue {
            .object(["method": .string("tools/call"), "params": .object(["name": .string(name), "arguments": .object(input)])])
        }
        let (opened, _) = try await request("api/rpc", body: tool("hetu_open_task_view", input: ["task_ref": ref]), csrf: csrf)
        let projection = opened["structuredContent"]["data"]
        try localCheck(projection["request"]["task_id"] == ref["task_id"], "页面未经过绑定任务Core句柄读取")
        let selected: JSONValue = .object(["task_ref": ref, "submission_id": projection["submission"]["submission_id"], "candidate_id": projection["submission"]["candidates"].array[0]["candidate_id"]])
        let (saved, _) = try await request("api/rpc", body: tool("hetu_save_task_selection", input: ["task_ref": ref, "expected": projection["expected"], "candidate_refs": .array([selected]), "comment": .string("原生子进程配对验收 🌿"), "operation_key": .string("local-view-native-save")]), csrf: csrf)
        try localCheck(saved["structuredContent"]["status"].string == "succeeded", "Node经原生父进程保存未成功")
        let latest = try await author.data("hetu.creative_tasks.get", input: ["task_ref": ref])
        try localCheck(latest["decision"]["comment"].string == "原生子进程配对验收 🌿" && latest["decision"]["effect"].string == "preference_only", "本地页面写入未落到原任务或变为正式决定")
        // 单独的测试 WebView，不打开或重启作者正在使用的软件窗口。
        _ = NSApplication.shared
        let probe = WebViewProbe()
        let webConfiguration = WKWebViewConfiguration()
        webConfiguration.websiteDataStore = .nonPersistent()
        webConfiguration.userContentController.add(probe, name: "hetuLocalViewTest")
        webConfiguration.userContentController.addUserScript(WKUserScript(source: """
            if (window.top !== window) {
              const inspect = () => {
                const title = document.querySelector('h1');
                if (title && document.querySelector('input[type=checkbox]')) window.webkit.messageHandlers.hetuLocalViewTest.postMessage(title.textContent);
              };
              new MutationObserver(inspect).observe(document, {subtree: true, childList: true}); inspect();
            }
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: false))
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 720), configuration: webConfiguration)
        defer { web.stopLoading(); webConfiguration.userContentController.removeScriptMessageHandler(forName: "hetuLocalViewTest") }
        web.load(URLRequest(url: origin))
        try await waitJavaScript(web, phase: "显示 WebKit 配对入口", script: "!!document.querySelector('#pair') && !document.querySelector('#pair').disabled")
        _ = try await web.evaluateJavaScript("document.querySelector('#pair').click()")
        try await wait("收到 WebKit 配对请求") { !manager.pairing.isEmpty }
        manager.approve(manager.pairing[0])
        try await wait("加载 WebKit 参考方案") { probe.title == "Compare references" }
        let (_, forbidden) = try await request("api/rpc", body: tool("hetu_finalize_document", input: ["task_ref": ref]), csrf: csrf)
        try localCheck(forbidden == 400, "本地页面取得作者定稿能力")
        _ = try await author.data("hetu.creative_tasks.close", input: ["task_ref": ref, "expected": latest["expected"], "reason": .string("原生关闭任务"), "operation_key": .string("local-view-close")])
        try await wait("关闭任务后撤销页面") { !manager.running }
        try await waitJavaScript(web, phase: "任务关闭后清除 WebKit 内容", script: "document.querySelectorAll('iframe').length === 0 && document.querySelector('#status').textContent.includes('Access has ended')")
        try localCheck(manager.url == nil && manager.pairing.isEmpty, "任务关闭未撤销页面生命周期")
        await manager.start(root: directory, scope: .workspace, taskRef: ref, locale: "zh-CN", theme: "light", runtime: runtime)
        try localCheck(!manager.running && manager.errorKey != nil, "已关闭任务重新获得页面访问")
        print("本地任务页面：原生子进程、配对、CSRF、真实Core保存、WebKit沙箱视图及关闭撤权通过")
    }
    @MainActor private static func waitForPairing(_ request: () async throws -> (JSONValue, Int)) async throws -> JSONValue {
        let deadline = Date().addingTimeInterval(20)
        while true {
            let (session, status) = try await request()
            try localCheck(status == 200, "配对会话在批准后不可访问")
            if session["state"].string == "paired" { return session }
            try localCheck(session["state"].string == "pending" && session["task_ref"] == .null, "待批准会话泄露任务范围或状态错误")
            guard Date() < deadline else { throw LocalViewTestFailure(message: "本地任务页面配对等待超时") }
            try await Task.sleep(for: .milliseconds(30))
        }
    }
    @MainActor private static func wait(_ phase: String, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(20)
        while !condition() {
            guard Date() < deadline else { throw LocalViewTestFailure(message: "本地任务页面等待超时：\(phase)") }
            try await Task.sleep(for: .milliseconds(30))
        }
    }
    @MainActor private static func waitJavaScript(_ web: WKWebView, phase: String, script: String) async throws {
        let deadline = Date().addingTimeInterval(20)
        while (try? await web.evaluateJavaScript(script) as? Bool) != true {
            guard Date() < deadline else {
                let state: String
                do { state = String(describing: try await web.evaluateJavaScript("JSON.stringify({ready:document.readyState,status:document.querySelector('#status')?.textContent,frames:document.querySelectorAll('iframe').length})")) }
                catch { state = String(describing: error) }
                throw LocalViewTestFailure(message: "WebKit任务页面等待超时：\(phase)，\(state)")
            }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
}

@MainActor private final class WebViewProbe: NSObject, WKScriptMessageHandler {
    var title = ""
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let value = message.body as? String { title = value }
    }
}
