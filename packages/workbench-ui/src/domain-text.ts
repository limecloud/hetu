import strings from "../../../assets/localization/shared.json";

/** 领域枚举沿同一翻译表显示，缺少翻译时保留调用方的明确回退。 */
export function domainText(key:string,fallback:string,locale:"zh-CN"|"en"="zh-CN"){
 return ((strings as Record<string,Record<string,unknown>>)[key]?.[locale] as string)??fallback;
}
