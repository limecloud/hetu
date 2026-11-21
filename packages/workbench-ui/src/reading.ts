import catalog from "../../../contracts/reading-defaults.json";
import type { ReadingProfile } from "@hetu/plugin-sdk";
export type { ReadingProfile } from "@hetu/plugin-sdk";

export type ReadingKind = "novel" | "screenplay";
export type FontFamily = ReadingProfile["font_family"];
export type DocumentTheme = "system" | "paper" | "warm" | "night";
export type Appearance = "light" | "dark";
export type ReadingStyle = Record<`--${string}`, string>;
export const readingLimits = catalog.limits;
export const documentZooms = [80, 90, 100, 110, 125, 150, 175, 200] as const;

export function defaultReadingProfile(kind: ReadingKind): ReadingProfile {
  return { ...catalog.profiles[kind] } as ReadingProfile;
}

function number(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 档案由Core校验；旧版夹具和尚未升级的插件只在读取边界转换。 */
export function readingProfile(preferences: Record<string, any>, kind: ReadingKind): ReadingProfile {
  const defaults = defaultReadingProfile(kind);
  const current = preferences.reading_profiles?.[kind];
  if (current) return { ...defaults, ...current };
  if (typeof preferences.font_size !== "number") return defaults;
  const size = number(preferences.font_size, 18);
  return {
    ...defaults, font_size: size, line_width: 880 / size,
    ...(kind === "novel" ? {
      font_family: preferences.font_family ?? "songti",
      line_height: 1.35 + number(preferences.line_spacing, 5) / size,
      first_line_indent: preferences.first_line_indent !== false,
    } : {}),
  };
}

export function effectiveAppearance(preference: unknown, hostTheme: unknown, systemDark: boolean): Appearance {
  if (preference === "light" || preference === "dark") return preference;
  if (hostTheme === "light" || hostTheme === "dark") return hostTheme;
  return systemDark ? "dark" : "light";
}

export function newerPreferences(previous: Record<string, any>, incoming: Record<string, any>) {
  if (typeof previous.settings_revision !== "number") return incoming;
  return typeof incoming.settings_revision !== "number" || incoming.settings_revision <= previous.settings_revision ? previous : incoming;
}

export function readingFont(profile: ReadingProfile): string {
  const fonts: Record<Exclude<FontFamily, "custom">, string> = {
    songti: '"Songti SC", "Noto Serif CJK SC", "Noto Serif SC", "SimSun", serif',
    pingfang: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif',
    system: "system-ui, sans-serif",
    mono: '"Courier Prime", "Courier New", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace',
  };
  return profile.font_family === "custom"
    ? '"' + profile.font_name.replace(/["\\]/g, "\\$&") + '", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", ' + fonts.system
    : fonts[profile.font_family];
}

/** 不申请整机字体清单权限，仅核对当前名称是否产生可用字形。 */
export function availableTypeface(name: string): boolean {
  if (!name.trim() || /[\x00-\x1f"\\;{}<>]/.test(name)) return false;
  const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
  if (!context) return false;
  const sample = "雨落窗边汉字墨色 Wm0123456789";
  return ["monospace", "serif", "sans-serif"].some(fallback => {
    context.font = `72px ${fallback}`;
    const baseline = context.measureText(sample).width;
    context.font = `72px "${name}", ${fallback}`;
    return Math.abs(context.measureText(sample).width - baseline) > .01;
  });
}

export function readingStyle(profile: ReadingProfile, zoom = 100, source = false): ReadingStyle {
  if (source) profile = {...profile, font_family: "mono", first_line_indent: false, paragraph_spacing: 0};
  const size = Number((profile.font_size * zoom / 100).toFixed(4));
  return {
    "--reader-font": readingFont(profile),
    "--reader-font-size": `${size}px`,
    "--reader-line-height": String(profile.line_height),
    "--reader-line-spacing": `${Number(((profile.line_height - 1.35) * size).toFixed(4))}px`,
    "--reader-paragraph-spacing": `${profile.paragraph_spacing}em`,
    "--reader-indent": profile.first_line_indent ? "2em" : "0",
    "--reader-measure": `${profile.line_width}ic`,
  };
}

export function readingPatch(kind: ReadingKind, patch: Partial<ReadingProfile>) {
  return { reading_profiles: { [kind]: patch } };
}

export function mergeReadingPreferences(current: Record<string, any>, patch: Record<string, any>) {
  const next = { ...current, ...patch };
  if (patch.reading_profiles) {
    next.reading_profiles = { ...current.reading_profiles };
    for (const kind of ["novel", "screenplay"] as const) {
      if (patch.reading_profiles[kind]) next.reading_profiles[kind] = {
        ...readingProfile(current, kind), ...patch.reading_profiles[kind],
      };
    }
  }
  return next;
}
