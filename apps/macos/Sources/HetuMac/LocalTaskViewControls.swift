import AppKit
import SwiftUI
import WebKit
import HetuCore
import HetuNative

struct LocalTaskViewControls: View {
    let root: URL
    let scope: ContentScope
    let taskRef: JSONValue
    let brief: String
    let locale: String
    let closed: Bool
    @Environment(\.colorScheme) private var colorScheme
    @State private var session = LocalTaskViewSession()
    @State private var embedded = false
    private var localizer: Localizer { Localizer(locale: locale) }
    private func t(_ key: String) -> String { localizer.text(key) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(t("local_view.title")).font(.headline)
            Text(t("local_view.note")).font(.caption).foregroundStyle(.secondary)
            HStack {
                if session.running {
                    if let url = session.url {
                        Button(t("local_view.open_embedded")) { embedded = true }
                        Button(t("local_view.copy_url")) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(url.absoluteString, forType: .string) }
                        Button(t("local_view.open_browser")) { NSWorkspace.shared.open(url) }
                    } else { ProgressView().controlSize(.small); Text(t("local_view.starting")).font(.caption) }
                    Button(t("local_view.stop")) { session.stop(); embedded = false }
                } else {
                    Button(t("local_view.start")) { Task {
                        await session.start(root: root, scope: scope, taskRef: taskRef, locale: locale, theme: colorScheme == .dark ? "dark" : "light")
                    } }.disabled(closed)
                }
            }
            if let error = session.errorKey { Text(t(error)).font(.caption).foregroundStyle(.red) }
            LocalPairRequests(session: session, brief: brief, localizer: localizer)
        }
        .onDisappear { session.stop() }
        .onChange(of: taskRef) { _, _ in session.stop(); embedded = false }
        .onChange(of: root) { _, _ in session.stop(); embedded = false }
        .onChange(of: closed) { _, value in if value { session.stop(); embedded = false } }
        .sheet(isPresented: $embedded) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(t("local_view.title")).font(.headline); Spacer()
                    Button(t("common.close")) { embedded = false }
                }
                LocalPairRequests(session: session, brief: brief, localizer: localizer)
                if let url = session.url { LocalTaskBrowser(url: url).id(url) }
                else { Text(t("local_view.ended")); Spacer() }
            }.padding(16).frame(minWidth: 840, idealWidth: 1040, minHeight: 600, idealHeight: 780)
        }
    }
}

private struct LocalPairRequests: View {
    let session: LocalTaskViewSession
    let brief: String
    let localizer: Localizer
    var body: some View {
        ForEach(session.pairing) { request in
            VStack(alignment: .leading, spacing: 6) {
                Text(localizer.text("local_view.pair_title")).font(.headline)
                Text(brief).lineLimit(3)
                Text(request.code).font(.system(.title2, design: .monospaced)).textSelection(.enabled)
                Text(localizer.text("local_view.pair_note")).font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button(localizer.text("local_view.approve")) { session.approve(request) }
                    Button(localizer.text("local_view.deny")) { session.deny(request) }
                }
            }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
        }
    }
}

private struct LocalTaskBrowser: NSViewRepresentable {
    let url: URL
    final class Coordinator: NSObject, WKNavigationDelegate {
        let origin: URL
        init(origin: URL) { self.origin = origin }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            let sameOrigin = url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port && url.user == nil && url.password == nil
            decisionHandler(sameOrigin || url.absoluteString == "about:blank" ? .allow : .cancel)
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(origin: url) }
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator; view.load(URLRequest(url: url))
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) { view.stopLoading(); view.navigationDelegate = nil; view.loadHTMLString("", baseURL: nil) }
}
