import messages from "../../../assets/localization/reading.json";
export function readingText(key: keyof typeof messages, language = "zh-CN", parameters: Record<string, string | number> = {}) {
  return messages[key][language === "en" ? "en" : "zh-CN"].replace(/\{([a-z_]+)\}/g, (_, name: string) => String(parameters[name] ?? ""));
}
