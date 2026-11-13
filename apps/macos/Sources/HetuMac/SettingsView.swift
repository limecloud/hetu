import AppKit
import SwiftUI
import HetuNative

struct WritingPreferences: DynamicProperty {
    @AppStorage("Hetu.editor.fontFamily") var fontFamily = "songti"
    @AppStorage("Hetu.editor.fontSize") var fontSize = 18.0
    @AppStorage("Hetu.editor.lineSpacing") var lineSpacing = 5.0
    @AppStorage("Hetu.editor.firstLineIndent") var firstLineIndent = true
    func presentation(forScript: Bool = false) -> EditorPresentation {
        EditorPresentation(fontFamily: fontFamily, fontSize: fontSize, lineSpacing: lineSpacing, firstLineIndent: firstLineIndent && !forScript)
    }
}

struct WorkbenchSettingsButton: View {
    let locale: String
    var body: some View {
        SettingsLink { Image(systemName: "gearshape").font(.system(size: 15)).frame(width: 28, height: 28) }
            .buttonStyle(.plain).help(Localizer(locale: locale).text("settings.title")).accessibilityLabel(Localizer(locale: locale).text("settings.title"))
    }
}

struct HetuSettingsView: View {
    @AppStorage("Hetu.locale") private var locale = "zh-CN"
    @AppStorage("Hetu.appearance") private var appearance = "system"
    @AppStorage("Hetu.library.list") private var listMode = false
    @AppStorage("Hetu.git.authorName") private var authorName = ""
    @AppStorage("Hetu.git.authorEmail") private var authorEmail = ""
    private var writing = WritingPreferences()
    private var localizer: Localizer { Localizer(locale: locale) }
    private func t(_ key: String) -> String { localizer.text(key) }
    var body: some View {
        TabView {
            general.tabItem { Label(t("settings.general"), systemImage: "slider.horizontal.3") }
            editor.tabItem { Label(t("settings.writing"), systemImage: "textformat") }
            versions.tabItem { Label(t("settings.versions"), systemImage: "arrow.triangle.branch") }
            about.tabItem { Label(t("settings.about"), systemImage: "info.circle") }
        }.padding(20).frame(width: 640, height: 490)
            .background { WorkbenchBackdrop().ignoresSafeArea() }.tint(WorkbenchPalette.jade)
            .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
            .environment(\.locale, Locale(identifier: locale == "en" ? "en" : "zh-Hans"))
    }
    private var general: some View {
        Form {
            Section(t("settings.interface")) {
                Picker(t("language.title"), selection: $locale) { Text("简体中文").tag("zh-CN"); Text("English").tag("en") }
                Picker(t("appearance.title"), selection: $appearance) {
                    Text(t("appearance.system")).tag("system")
                    Text(t("appearance.light")).tag("light")
                    Text(t("appearance.dark")).tag("dark")
                }
            }
            Section(t("library.title")) {
                Picker(t("library.layout"), selection: $listMode) {
                    Text(t("settings.grid")).tag(false); Text(t("settings.list")).tag(true)
                }
            }
            Text(t("settings.applies_immediately")).font(.callout).foregroundStyle(WorkbenchPalette.muted)
        }.formStyle(.grouped).scrollContentBackground(.hidden)
    }
    private var editor: some View {
        Form {
            Section(t("settings.body")) {
                Picker(t("settings.font"), selection: writing.$fontFamily) {
                    Text(t("settings.font_songti")).tag("songti")
                    Text(t("settings.font_pingfang")).tag("pingfang")
                    Text(t("settings.font_system")).tag("system")
                }
                Stepper(value: writing.$fontSize, in: 14...30, step: 1) { LabeledContent(t("settings.font_size"), value: "\(Int(writing.fontSize)) pt") }
                Stepper(value: writing.$lineSpacing, in: 0...16, step: 1) { LabeledContent(t("settings.line_spacing"), value: "\(Int(writing.lineSpacing)) pt") }
                Toggle(t("settings.indent"), isOn: writing.$firstLineIndent)
            }
            Section(t("settings.preview")) {
                NativeTextEditor(text: t("settings.preview_text"), documentID: "settings-preview-" + locale, replacementVersion: 0,
                    accessibleName: t("settings.preview"), editable: false, readingMode: true, presentation: writing.presentation(), onChange: { _ in }, onComposition: { _ in })
                    .frame(height: 110).padding(10).background(WorkbenchPalette.page, in: RoundedRectangle(cornerRadius: 8))
            }
            Text(t("settings.display_only")).font(.caption).foregroundStyle(WorkbenchPalette.muted)
        }.formStyle(.grouped).scrollContentBackground(.hidden)
    }
    private var versions: some View {
        Form {
            Section(t("settings.git_identity")) {
                TextField(t("git.author_name"), text: $authorName)
                TextField(t("git.author_email"), text: $authorEmail)
                Text(t("git.identity_note")).font(.callout).foregroundStyle(WorkbenchPalette.muted)
            }
            Text(t("settings.git_note")).font(.callout).foregroundStyle(WorkbenchPalette.muted)
        }.formStyle(.grouped).scrollContentBackground(.hidden)
    }
    private var about: some View {
        VStack(spacing: 18) {
            Image(nsImage: NSApp.applicationIconImage).resizable().scaledToFit().frame(width: 80, height: 80).accessibilityHidden(true)
            Text(locale == "en" ? "Hetu" : "河图 Hetu").font(.system(size: 25, weight: .medium, design: .serif))
            Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "").font(.callout).foregroundStyle(WorkbenchPalette.muted)
            Text(t("welcome.subtitle")).font(.callout)
            Text(t("settings.local_note")).font(.callout).foregroundStyle(WorkbenchPalette.muted).multilineTextAlignment(.center).frame(maxWidth: 390)
            Spacer(minLength: 0)
        }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
