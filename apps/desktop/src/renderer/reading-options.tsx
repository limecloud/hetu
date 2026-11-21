import React, { useEffect, useRef, useState } from "react";
import { documentZooms, mergeReadingPreferences, ReadingControls, readingText, Icon, type ReadingKind } from "@hetu/workbench-ui";
import { desktop } from "./bridge.ts";
import { applyPreferences, usePreferences } from "./preferences.tsx";

export function ReadingOptions({ kind, composing, zoom, onZoom, beforeChange, onPreview }: {
  kind: ReadingKind; composing: boolean; zoom: number; onZoom: (value: number) => void; beforeChange: () => void;
  onPreview: (value: Record<string, any> | undefined) => void;
}) {
  const preferences = usePreferences();
  const [preview, setPreview] = useState<Record<string, any>>(), [saving, setSaving] = useState(false), [error, setError] = useState(""), [journal, setJournal] = useState<any>();
  const pending = useRef(false), failed = useRef(false);
  const [syncError, setSyncError] = useState("");
  const current = preview ?? preferences;
  const t = (key: Parameters<typeof readingText>[0]) => readingText(key, current.language);
  useEffect(() => { if (!pending.current && !failed.current) setPreview(undefined); }, [preferences]);
  useEffect(() => { onPreview(preview); }, [preview]);
  useEffect(() => () => onPreview(undefined), []);
  useEffect(() => { const listener = (event: Event) => setSyncError((event as CustomEvent).detail); window.addEventListener("hetu:preference-sync", listener); return () => window.removeEventListener("hetu:preference-sync", listener); }, []);
  async function accept(state: any) {
    const next = { ...state.preferences, settings_revision: state.revision };
    setPreview(next); applyPreferences(next); setJournal(state.journal);
  }
  async function save(patch: Record<string, unknown>) {
    if (pending.current || composing || failed.current) return;
    beforeChange(); pending.current = true; setSaving(true); setError("");
    setPreview(mergeReadingPreferences(current, patch));
    try {
      const state = await desktop.settings("preferences");
      await accept(await desktop.settings("update", { expected_revision: state.revision, patch }));
    } catch (error) {
      failed.current = true; setError((error as Error).message);
      try { setJournal((await desktop.settings("get")).journal); } catch { /* 保留本次预览及原错误。 */ }
    } finally { pending.current = false; setSaving(false); }
  }
  async function recover(discard = false) {
    if (pending.current) return;
    pending.current = true; setSaving(true);
    try {
      const state = await desktop.settings("get");
      if (state.journal?.status === "pending") {
        await desktop.settings("recover");
        await desktop.settings("acknowledge");
      } else if (discard && state.journal) await desktop.settings("acknowledge");
      beforeChange(); await accept(await desktop.settings("get"));
      failed.current = false; setError("");
    } catch (error) { setError((error as Error).message); }
    finally { pending.current = false; setSaving(false); }
  }
  return <details className="popover-menu reading-menu"><summary aria-label={t("reading.title")} title={t("reading.title")}><Icon name="brush"/></summary>
    <div className="menu-panel reading-panel">
      <ReadingControls loadFonts={refresh => desktop.fonts(refresh)} preferences={current} kind={kind} disabled={saving || composing || !!error} onChange={patch => void save(patch)}/>
      <label className="reading-field"><span>{t("reading.zoom")}</span><select aria-label={t("reading.zoom")} disabled={composing} value={zoom} onChange={event => { beforeChange(); onZoom(Number(event.target.value)); }}>
        {documentZooms.map(value => <option key={value} value={value}>{value}%</option>)}</select></label>
      {zoom !== 100 && <button type="button" onClick={() => { beforeChange(); onZoom(100); }}>{t("reading.zoom_reset")}</button>}
      {saving && <p className="reading-save-state" role="status">{t("reading.saving")}</p>}
      {syncError && <div className="reading-save-error" role="status"><p>{t("reading.sync_error")}</p><button type="button" title={syncError} onClick={() => window.dispatchEvent(new Event("hetu:refresh-preferences"))}>{t("reading.sync_retry")}</button></div>}
      {error && <div className="reading-save-error" role="alert"><p>{error}</p>
        {journal?.status === "pending" ? <button type="button" disabled={saving} onClick={() => void recover()}>{t("reading.recover")}</button>
          : <button type="button" disabled={saving} onClick={() => void recover(true)}>{t("reading.discard_preview")}</button>}</div>}
    </div>
  </details>;
}
