import React, {useEffect, useMemo, useRef, useState} from "react";
import {availableTypeface, defaultReadingProfile, readingFont} from "./reading.ts";
import {readingText} from "./reading-labels.ts";

export interface FontCatalog {families: string[]; cssNames?: Record<string, string>; scanned: number; skipped: number; complete: boolean}
export type LoadFontCatalog = (refresh?: boolean) => Promise<FontCatalog>;

function FontOption({name, cssName, language, disabled, select, root}: {name: string; cssName: string; language: string; disabled: boolean; select: (name: string) => void; root: React.RefObject<HTMLUListElement>}) {
  const element = useRef<HTMLLIElement>(null), [visible, setVisible] = useState(false), [available, setAvailable] = useState<boolean>();
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {if (entries.some(entry => entry.isIntersecting)) {setVisible(true); observer.disconnect();}}, {root: root.current});
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => setAvailable(availableTypeface(cssName)));
    return () => cancelAnimationFrame(frame);
  }, [visible, cssName]);
  return <li ref={element}><button type="button" disabled={disabled} aria-label={readingText("reading.font_choose", language, {name})} onClick={() => select(cssName)}>
    <strong>{name}</strong><span style={visible ? {fontFamily: readingFont({...defaultReadingProfile("novel"), font_family: "custom", font_name: cssName})} : undefined}>{readingText("reading.font_preview", language)}</span>
    {available !== undefined && <small>{readingText(available ? "reading.font_available" : "reading.font_fallback", language)}</small>}
  </button></li>;
}

/** 只处理名称与样句；目录读取及偏好保存由宿主注入。 */
export function FontPicker({load, select, language, disabled}: {load: LoadFontCatalog; select: (family: string) => void; language: string; disabled: boolean}) {
  const [opened, setOpened] = useState(false), [catalog, setCatalog] = useState<FontCatalog>(), [busy, setBusy] = useState(false), [error, setError] = useState(""), [query, setQuery] = useState("");
  const generation = useRef(0), t = (key: Parameters<typeof readingText>[0], values?: Record<string, string | number>) => readingText(key, language, values);
  const list = useRef<HTMLUListElement>(null);
  const names = useMemo(() => catalog?.families.filter(name => name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [], [catalog, query]);
  useEffect(() => () => {generation.current++;}, []);
  async function read(refresh = false) {
    const epoch = ++generation.current; setOpened(true); setBusy(true); setError("");
    try {const value = await load(refresh); if (generation.current === epoch) setCatalog(value);}
    catch (value) {if (generation.current === epoch) setError((value as Error).message);}
    finally {if (generation.current === epoch) setBusy(false);}
  }
  return <div className="font-picker">
    <button type="button" disabled={disabled} aria-expanded={opened} onClick={() => {if (opened) setOpened(false); else if (catalog) setOpened(true); else void read();}}>{t("reading.local_fonts")}</button>
    {opened && <section aria-label={t("reading.local_fonts")}>
      <div className="font-picker-search"><input type="search" aria-label={t("reading.font_search")} placeholder={t("reading.font_search")} value={query} disabled={busy} onChange={event => setQuery(event.target.value)}/>
        <button type="button" disabled={busy} onClick={() => void read(true)}>{t("reading.font_refresh")}</button></div>
      {busy && <p role="status">{t("reading.font_loading")}</p>}
      {error && <div role="alert"><p>{t("reading.font_error")}</p><button type="button" title={error} onClick={() => void read(true)}>{t("reading.font_retry")}</button></div>}
      {!busy && catalog && <>
        {!catalog.complete && <p role="status">{t("reading.font_partial", {count: catalog.skipped})}</p>}
        <p role="status">{t(names.length ? "reading.font_count" : "reading.font_none", {count: names.length})}</p>
        <ul ref={list}>{names.slice(0, 60).map(name => <FontOption key={name} name={name} cssName={catalog.cssNames?.[name] ?? name} root={list} select={select} disabled={disabled} language={language}/>)}</ul>
        {names.length > 60 && <p>{t("reading.font_refine")}</p>}
      </>}
    </section>}
  </div>;
}
