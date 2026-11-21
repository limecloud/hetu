import React, { createContext, useContext, useEffect, useState } from "react";
import { effectiveAppearance, newerPreferences, readingProfile, readingStyle, type Appearance } from "@hetu/workbench-ui";
import { desktop } from "./bridge.ts";

export const Preferences = createContext<Record<string, any>>({});
export const usePreferences = () => useContext(Preferences);
let applied: Record<string, any> | undefined;
let watching = false;
declare global { interface Window { hetuWorkbenchHostTheme?: unknown; } }

/** 只同步非敏感偏好；可见视图最多一个请求，不加载套件目录或改写作品。 */
export function watchPreferences(receive: (value: Record<string, any>) => void) {
  let active = true, pending = false, status = "";
  const report = (message: string) => {
    if (message === status) return;
    status = message; window.dispatchEvent(new CustomEvent("hetu:preference-sync", {detail: message}));
  };
  const refresh = async () => {
    if (!active || pending || document.hidden) return;
    pending = true;
    try {
      const state = await desktop.settings("preferences");
      if (active) { receive({...state.preferences, settings_revision: state.revision}); report(""); }
    } catch (error) { if (active) report((error as Error).message); }
    finally { pending = false; }
  };
  const dispose = desktop.onPreferences(receive), timer = window.setInterval(() => void refresh(), 2500);
  const onVisible = () => void refresh();
  document.addEventListener("visibilitychange", onVisible); window.addEventListener("hetu:refresh-preferences", onVisible);
  void refresh();
  return () => { active = false; dispose(); clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("hetu:refresh-preferences", onVisible); };
}

export function useEffectiveAppearance() {
  const [value, setValue] = useState<Appearance>(() => document.documentElement.dataset.effectiveAppearance === "dark" ? "dark" : "light");
  useEffect(() => {
    const update = () => setValue(document.documentElement.dataset.effectiveAppearance === "dark" ? "dark" : "light");
    update(); window.addEventListener("hetu:effective-appearance", update);
    return () => window.removeEventListener("hetu:effective-appearance", update);
  }, []);
  return value;
}

export function applyPreferences(value: Record<string, any>) {
  if (applied && newerPreferences(applied, value) !== value) return;
  applied = value;
  if (!watching) {
    watching = true;
    const update = () => { if (applied) applyPreferences(applied); };
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", update);
    window.addEventListener("hetu:host-appearance", update);
  }
  const root = document.documentElement;
  root.lang = value.language ?? "zh-CN";
  root.dataset.appearance = value.appearance ?? "system";
  const appearance = effectiveAppearance(value.appearance, window.hetuWorkbenchHostTheme, window.matchMedia("(prefers-color-scheme: dark)").matches);
  const changed = root.dataset.effectiveAppearance !== appearance;
  delete root.dataset.theme;
  root.dataset.effectiveAppearance = appearance;
  root.style.colorScheme = appearance;
  root.style.setProperty("--application-color-scheme", appearance);
  root.dataset.documentTheme = value.document_theme ?? "system";
  for (const [key, entry] of Object.entries(readingStyle(readingProfile(value, "novel")))) root.style.setProperty(key, entry);
  for (const [key, entry] of Object.entries(readingStyle(readingProfile(value, "screenplay")))) root.style.setProperty(key.replace("--reader-", "--screenplay-"), entry);
  if (changed) window.dispatchEvent(new Event("hetu:effective-appearance"));
}
