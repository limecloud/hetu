import messages from "../../../assets/localization/editing.json" with {type: "json"};

export type EditingKey = keyof typeof messages;
export function editingText(key: EditingKey, language = "zh-CN") {
  return messages[key][language === "en" ? "en" : "zh-CN"];
}
