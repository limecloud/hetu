import React, { useEffect, useRef, useState, type RefObject } from "react";
import { readFixedAssetBytes, type FixedAssetRef } from "@hetu/workbench-ui";
import { desktop, data } from "./bridge.ts";

export type CaptionTrack = {id: string; label: string; language: string; asset_ref: FixedAssetRef};
export type CaptionExport = {busy: boolean; saved?: FixedAssetRef; save(track: CaptionTrack): void};
const LIMIT = 1024 * 1024;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+': Error:\s*/, "");

function NativeCaption({url, track, player, ready, failed}: {url: string; track: CaptionTrack; player: RefObject<HTMLMediaElement | null>; ready: () => void; failed: () => void}) {
  const element = useRef<HTMLTrackElement>(null);
  useEffect(() => {
    const target = element.current!;
    const loaded = () => {
      for (const item of Array.from(player.current?.textTracks ?? [])) item.mode = item === target.track ? "showing" : "disabled";
      ready();
    };
    // track的load/error不冒泡；直接在原生节点监听，再开启加载。
    target.addEventListener("load", loaded); target.addEventListener("error", failed);
    target.track.mode = "showing";
    if (target.readyState === 2) loaded();
    else if (target.readyState === 3) failed();
    return () => {target.removeEventListener("load", loaded); target.removeEventListener("error", failed);};
  }, [url]);
  return <track ref={element} kind="subtitles" src={url} label={track.label} srcLang={track.language}/>;
}
async function readCaption(work: any, reference: FixedAssetRef, active: () => boolean) {
  const read = async (action: string, input: any) => data(await desktop.read(action, {...input, ...(action === "hetu.assets.read_blob" ? {work_ref: work} : {})}));
  const fixed = await read("hetu.assets.get", {asset_id: reference.asset_id, revision: reference.revision});
  if (fixed.sha256 !== reference.sha256 || fixed.asset?.kind !== "caption" || fixed.asset?.blob?.media_type !== "text/vtt") throw new Error("字幕类型或固定版本不符。");
  return readFixedAssetBytes(fixed.asset, reference, read, active, LIMIT);
}

/** 仅加载当前轨；原生浏览器负责时间码及字幕排版，不执行专业插件。 */
export function useMediaCaptions(work: any, tracks: CaptionTrack[], player: RefObject<HTMLMediaElement | null>, exportCaption?: CaptionExport) {
  const [selected, setSelected] = useState(tracks[0]?.id ?? ""), [reload, setReload] = useState(0);
  const [file, setFile] = useState<{key: string; url: string}>(), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const track = tracks.find(item => item.id === selected);
  const key = track ? JSON.stringify([work, track]) : "";
  useEffect(() => {
    let active = true, url = "";
    setFile(undefined); setError(""); setLoading(!!track);
    if (track) void readCaption(work, track.asset_ref, () => active).then(bytes => {
      if (!active) return;
      url = URL.createObjectURL(new Blob([bytes], {type: "text/vtt"}));
      setFile({key, url});
    }).catch(error => {if (active) {setError("无法加载字幕。" + message(error)); setLoading(false);}});
    return () => {active = false; if (url) URL.revokeObjectURL(url);};
  }, [key, reload]);
  const current = file?.key === key ? file : undefined;
  const caption = current && track ? <NativeCaption key={current.url} url={current.url} track={track} player={player}
    ready={() => setLoading(false)} failed={() => {setLoading(false); setError("无法显示字幕，请重新加载。");}}/> : null;
  const controls = tracks.length > 0 && <div className="caption-controls" role="group" aria-label="视频字幕" aria-busy={loading}>
    <label>字幕 <select aria-label="字幕语言" value={selected} disabled={exportCaption?.busy} onChange={event => setSelected(event.target.value)}>
      <option value="">关闭</option>{tracks.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
    {track && exportCaption && <button disabled={exportCaption.busy} onClick={() => exportCaption.save(track)}>导出字幕</button>}
    {track && exportCaption?.saved?.asset_id === track.asset_ref.asset_id && exportCaption.saved.revision === track.asset_ref.revision && exportCaption.saved.sha256 === track.asset_ref.sha256 && <span className="muted" role="status">本版字幕已导出。</span>}
    {loading && <span role="status">正在加载字幕…</span>}
    {error && <><span role="alert">{error}</span><button onClick={() => setReload(value => value + 1)}>重新加载字幕</button></>}
  </div>;
  return {caption, controls};
}

export function CaptionAssetPreview({asset, sha256}: {asset: any; sha256: string}) {
  const [text, setText] = useState(""), [error, setError] = useState(""), [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true; setText(""); setError("");
    void readCaption(asset.work_ref, {asset_id: asset.asset_id, revision: asset.revision, sha256}, () => active)
      .then(bytes => {if (active) setText(new TextDecoder("utf-8", {fatal: true}).decode(bytes));})
      .catch(error => {if (active) setError(message(error));});
    return () => {active = false;};
  }, [asset.asset_id, asset.revision, sha256, reload]);
  return <section className="caption-preview" aria-label="字幕原文" aria-busy={!text && !error}>
    {error ? <><p role="alert">{error}</p><button onClick={() => setReload(value => value + 1)}>重新读取字幕</button></> : text ? <pre>{text}</pre> : <p role="status">正在读取字幕…</p>}
  </section>;
}
