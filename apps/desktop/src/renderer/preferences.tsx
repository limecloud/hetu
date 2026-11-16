import React, { createContext, useContext } from "react";

export const Preferences = createContext<Record<string, any>>({});
export const usePreferences = () => useContext(Preferences);
export function applyPreferences(value: Record<string, any>) {
  const root = document.documentElement;
  root.lang = value.language ?? "zh-CN";
  root.dataset.appearance = value.appearance ?? "system";
  root.style.colorScheme =
    value.appearance === "system" ? "light dark" : value.appearance;
  root.style.setProperty(
    "--reader-font",
    (
      {
        songti: '"Songti SC", "SimSun", serif',
        pingfang: '"PingFang SC", "Microsoft YaHei", sans-serif',
        system: "system-ui, sans-serif",
      } as Record<string, string>
    )[value.font_family] ?? "serif",
  );
  root.style.setProperty("--reader-font-size", `${value.font_size ?? 18}px`);
  root.style.setProperty(
    "--reader-line-spacing",
    `${value.line_spacing ?? 5}px`,
  );
  root.style.setProperty(
    "--reader-indent",
    value.first_line_indent !== false ? "2em" : "0",
  );
}
