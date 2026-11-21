import type { PluginPreferences } from "@hetu/plugin-sdk";

/** 专业插件只收到表现偏好，不转交作者资料、账号或连接信息。 */
export function pluginPreferences(state: any, effectiveTheme?: "light" | "dark"): PluginPreferences {
  return {
    theme: effectiveTheme ?? state.preferences.appearance,
    appearance: state.preferences.appearance,
    language: state.preferences.language ?? "zh-CN",
    settings_revision: state.revision,
    document_theme: state.preferences.document_theme,
    reading_profiles: state.preferences.reading_profiles,
  };
}
