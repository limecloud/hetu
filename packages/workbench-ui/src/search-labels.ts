import searchMessages from "../../../assets/localization/search.json";
import sharedMessages from "../../../assets/localization/shared.json";

const messages = {...sharedMessages, ...searchMessages};
export type SearchMessageKey = keyof typeof messages;
export function searchLabel(key: SearchMessageKey, language = "zh-CN", values: Record<string, number> = {}) {
  return messages[key][language === "en" ? "en" : "zh-CN"].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
}
export function searchError(message: string, language?: string) { return message in messages ? searchLabel(message as SearchMessageKey, language) : message; }
