import React, { useEffect, useRef, useState } from "react";
import messages from "../../../assets/localization/reading.json";
import {readingText} from "./reading-labels.ts";
export {readingText} from "./reading-labels.ts";
import { availableTypeface, defaultReadingProfile, readingFont, readingLimits, readingPatch, readingProfile, readingStyle, type ReadingKind } from "./reading.ts";
import {FontPicker, type LoadFontCatalog} from "./font-picker.tsx";

type Key = keyof typeof messages;

function NumberField({ label, value, limits, step = 1, language, disabled, change }: {
  label: string; value: number; limits: number[]; step?: number; language: string; disabled: boolean; change: (value: number) => void;
}) {
  const [text, setText] = useState(String(Number(value.toFixed(4)))), [editing, setEditing] = useState(false), [error, setError] = useState("");
  const cancelled = useRef(false);
  useEffect(() => { if (!editing) setText(String(Number(value.toFixed(4)))); }, [value, editing]);
  function commit() {
    if (cancelled.current) { cancelled.current = false; setEditing(false); return; }
    const next = Number(text);
    if (!text.trim() || !Number.isFinite(next) || next < limits[0] || next > limits[1]) {
      setError(readingText("reading.invalid", language, { min: limits[0], max: limits[1] }));
      return;
    }
    setEditing(false); setError(""); if (next !== value) change(next);
  }
  return <label className="reading-field"><span>{label}</span><span className="reading-number">
    <button type="button" aria-label={readingText("reading.decrease", language, { field: label })} disabled={disabled || value <= limits[0]}
      onClick={() => { setEditing(false); setError(""); change(Math.max(limits[0], Number((value - step).toFixed(4)))); }}>−</button>
    <input type="number" inputMode="decimal" aria-label={label} min={limits[0]} max={limits[1]} step={step} disabled={disabled} value={text} aria-invalid={!!error}
      onFocus={() => setEditing(true)} onChange={event => { setEditing(true); setText(event.target.value); }} onBlur={commit}
      onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setText(String(value)); setError(""); event.currentTarget.blur(); } }}/>
    <button type="button" aria-label={readingText("reading.increase", language, { field: label })} disabled={disabled || value >= limits[1]}
      onClick={() => { setEditing(false); setError(""); change(Math.min(limits[1], Number((value + step).toFixed(4)))); }}>＋</button>
  </span>{error && <span className="reading-field-error" role="alert">{error}</span>}</label>;
}

/** 页面和设置使用同一控制面；数据保存由宿主注入，组件不接触作者内容。 */
export function ReadingControls({ preferences, kind, onKindChange, onChange, disabled = false, preview = false, loadFonts }: {
  preferences: Record<string, any>; kind: ReadingKind; onKindChange?: (kind: ReadingKind) => void;
  onChange: (patch: Record<string, unknown>) => void; disabled?: boolean; preview?: boolean;
  loadFonts?: LoadFontCatalog;
}) {
  const language = preferences.language ?? "zh-CN", t = (key: string) => readingText(key as Key, language);
  const profile = readingProfile(preferences, kind);
  const [fontName, setFontName] = useState(profile.font_name), [fontError, setFontError] = useState(""), [customFont, setCustomFont] = useState(profile.font_family === "custom");
  const cancelFont = useRef(false);
  useEffect(() => { setFontName(profile.font_name); setFontError(""); setCustomFont(profile.font_family === "custom"); }, [kind, profile.font_name, profile.font_family]);
  const set = (field: string, value: unknown) => onChange(readingPatch(kind, { [field]: value }));
  function saveFont() {
    if (!fontName.trim()) { setFontError(t("reading.font_required")); return; }
    if (/[\x00-\x1f"\\;{}<>]/.test(fontName)) { setFontError(t("reading.font_invalid")); return; }
    onChange(readingPatch(kind, { font_family: "custom", font_name: fontName.trim() })); setFontError("");
  }
  return <div className="reading-controls" aria-label={t("reading.title")}>
    <h3 className="reading-panel-title">{t("reading.title")}</h3>
    {onKindChange && <div className="reading-tabs" role="group" aria-label={t("reading.title")}>{(["novel", "screenplay"] as const).map(value =>
      <button key={value} type="button" aria-pressed={kind === value} onClick={() => onKindChange(value)}>{t("reading." + value)}</button>)}</div>}
    <div className="reading-style-preview reading-surface" data-document-theme={preferences.document_theme ?? "system"} aria-label={t("reading.preview")}>
      <div className="reading-style-page" style={{fontFamily: readingFont(profile)}}><strong>{t("reading." + kind)}</strong><p>{t("reading.font_sample")}</p><span/><span/><span/></div>
    </div>
    <fieldset className="reading-choice-section"><legend>{t("reading.paper")}</legend><div className="reading-paper-choices" role="group" aria-label={t("reading.paper")}>
      {(["system", "paper", "warm", "night"] as const).map(value => <button key={value} type="button" disabled={disabled} aria-pressed={(preferences.document_theme ?? "system") === value}
        onClick={() => onChange({document_theme: value})}><span className="reading-paper-swatch" data-tone={value} aria-hidden="true">Aa</span><span>{t(value === "paper" ? "reading.paper_clear" : "reading." + value)}</span></button>)}
    </div></fieldset>
    <fieldset className="reading-choice-section"><legend>{t("reading.font")}</legend><div className="reading-font-choices" role="group" aria-label={t("reading.font")}>
      {(["system", "songti", "pingfang", "mono"] as const).map(family => <button key={family} type="button" disabled={disabled} aria-pressed={!customFont && profile.font_family === family}
        style={{fontFamily: readingFont({...profile, font_family: family})}} onClick={() => {setCustomFont(false); setFontError(""); set("font_family", family);}}><span aria-hidden="true">Aa 字</span>{t("reading.font_" + family)}</button>)}
      <button type="button" className="reading-custom-font" disabled={disabled} aria-pressed={customFont} onClick={() => {setCustomFont(true); setFontError("");}}>{t("reading.font_custom")}<span aria-hidden="true">›</span></button>
    </div></fieldset>
    {customFont && <label className="reading-field reading-font-name"><span>{t("reading.font_name")}</span>
      <input aria-label={t("reading.font_name")} value={fontName} maxLength={128} disabled={disabled} onChange={event => setFontName(event.target.value)}
        onBlur={() => { if (cancelFont.current) {cancelFont.current = false; return;} if (fontName.trim() && (fontName !== profile.font_name || profile.font_family !== "custom")) saveFont(); }} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {event.preventDefault(); if (!fontName.trim()) setFontError(t("reading.font_required")); else event.currentTarget.blur();}
          if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); cancelFont.current = true; setFontName(profile.font_name); setFontError(""); event.currentTarget.blur();}
        }}/>
      {fontError && <span className="reading-field-error" role="alert">{fontError}</span>}
      {profile.font_family === "custom" && <span className="reading-font-status" role="status">{t(availableTypeface(profile.font_name) ? "reading.font_available" : "reading.font_fallback")}</span>}</label>}
    {customFont && loadFonts && <FontPicker load={loadFonts} language={language} disabled={disabled} select={name => {setFontName(name); setFontError(""); onChange(readingPatch(kind, {font_family: "custom", font_name: name}));}}/>}
    <NumberField label={t("reading.size")} value={profile.font_size} limits={readingLimits.font_size} language={language} disabled={disabled} change={value => set("font_size", value)}/>
    <fieldset className="reading-choice-section"><legend>{t("reading.width")}{![30, 44, 56].includes(profile.line_width) && <span className="reading-custom-value">{t("reading.custom")} {Number(profile.line_width.toFixed(2))}</span>}</legend><div className="reading-segmented" role="group" aria-label={t("reading.width")}>
      {([30, 44, 56] as const).map((width, index) => <button key={width} type="button" disabled={disabled} aria-pressed={profile.line_width === width} onClick={() => set("line_width", width)}>{t("reading." + ["narrow", "standard", "wide"][index])}</button>)}
    </div></fieldset>
    {kind === "novel" && <fieldset className="reading-choice-section"><legend>{t("reading.paragraph")}</legend><div className="reading-segmented" role="group" aria-label={t("reading.paragraph")}>
      {(["book", "spacious"] as const).map(value => <button key={value} type="button" disabled={disabled} aria-pressed={value === "book" ? profile.first_line_indent && profile.paragraph_spacing === 0 : !profile.first_line_indent && profile.paragraph_spacing === 0.5}
        onClick={() => onChange(readingPatch(kind, {first_line_indent: value === "book", paragraph_spacing: value === "book" ? 0 : 0.5}))}>{t("reading." + value)}</button>)}
    </div></fieldset>}
    <details className="reading-advanced"><summary>{t("reading.more")}</summary>
      <NumberField label={t("reading.line_height")} value={profile.line_height} limits={readingLimits.line_height} step={0.05} language={language} disabled={disabled} change={value => set("line_height", value)}/>
      <NumberField label={t("reading.paragraph_spacing")} value={profile.paragraph_spacing} limits={readingLimits.paragraph_spacing} step={0.1} language={language} disabled={disabled} change={value => set("paragraph_spacing", value)}/>
      <NumberField label={t("reading.width")} value={profile.line_width} limits={readingLimits.line_width} language={language} disabled={disabled} change={value => set("line_width", value)}/>
      {kind === "novel" && <label className="reading-field"><span>{t("reading.indent")}</span><input type="checkbox" role="switch" aria-label={t("reading.indent")} checked={profile.first_line_indent} disabled={disabled} onChange={event => set("first_line_indent", event.target.checked)}/></label>}
    </details>
    {preview && <div className="reading-surface reading-preview" data-document-theme={preferences.document_theme ?? "system"} style={readingStyle(profile)}>
      <p>{t("reading.font_sample")}</p><p>{t("reading.sample_second")}</p></div>}
    <button className="reading-reset" type="button" disabled={disabled} onClick={() => onChange(readingPatch(kind, defaultReadingProfile(kind)))}>{t("reading.reset")}</button>
  </div>;
}
