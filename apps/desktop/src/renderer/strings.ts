import strings from "../../../../assets/localization/shared.json";

/** 已有领域文案继续消费共享来源；缺少翻译时显示明确回退文字。 */
export function domainText(
  key: string,
  fallback: string,
  locale: "zh-CN" | "en" = "zh-CN",
) {
  return (
    ((strings as Record<string, Record<string, unknown>>)[key]?.[
      locale
    ] as string) ?? fallback
  );
}
