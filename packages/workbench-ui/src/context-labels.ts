import messages from "../../../assets/localization/context-menu.json" with {type: "json"};

export type ContextKey = keyof typeof messages;
export function contextText(key: ContextKey, language = "zh-CN") {
  return messages[key][language === "en" ? "en" : "zh-CN"];
}
