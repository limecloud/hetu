import React, {useEffect, useRef, useState} from "react";
import type {WorkRef} from "@hetu/plugin-sdk";
import {desktop, data} from "./bridge.ts";
import {ContextPickerDialog, type ContextSelection} from "./agent-context-dialog.tsx";

type Props = {kind: "scenes" | "video"; work: WorkRef; onSelect(value: ContextSelection): Promise<boolean>; onClose(): void};
type VideoMode = "media" | "episodes";
export function AgentStructuredContextPicker({kind, work, onSelect, onClose}: Props) {
  const generation = useRef(0), queryUsed = useRef(""), videoProject = useRef<any>();
  const [query, setQuery] = useState(""), [mode, setMode] = useState<VideoMode>("media");
  const [items, setItems] = useState<any[]>([]), [cursor, setCursor] = useState<string>(), [count, setCount] = useState(20);
  const [loading, setLoading] = useState(false), [loaded, setLoaded] = useState(false), [attaching, setAttaching] = useState(false), [error, setError] = useState("");
  const [retry, setRetry] = useState<() => void>();
  const busy = loading || attaching, title = kind === "scenes" ? "剧本场次" : "视频分集与成果";
  function close() { generation.current++; onClose(); }
  async function load(more = false, selectedMode = mode, term = more ? queryUsed.current : query, after = cursor) {
    const token = ++generation.current; setLoading(true); setError(""); setRetry(undefined);
    if (!more) { setItems([]); setCursor(undefined); setCount(20); queryUsed.current = term; }
    try {
      let rows: any[], next: string | undefined;
      if (kind === "scenes") {
        const value = data(await desktop.read("hetu.documents.scene_index", {work_ref: work, query: term, limit: 20, ...(more && after ? {cursor: after} : {})}));
        rows = value.scenes; next = value.next_cursor ?? undefined;
      } else {
        const project = more ? videoProject.current : data(await desktop.read("hetu.video.projects.get", {video_project_id: work.object_id}));
        if (token !== generation.current) return;
        videoProject.current = project;
        if (selectedMode === "episodes") {
          rows = project.episodes.filter((item: any) => !item.episode.archived && item.episode.title.toLowerCase().includes(term.toLowerCase()));
        } else {
          const value = await desktop.video("list", {query: term, limit: 20, ...(more && after ? {cursor: after} : {})});
          if (token !== generation.current) return;
          rows = value.items.map((item: any) => ({...item, episode: project.episodes.find((row: any) => row.episode.video_episode_id === item.media.video_episode_id)}));
          next = value.next_cursor ?? undefined;
        }
      }
      if (token !== generation.current) return;
      setItems(previous => more ? [...previous, ...rows] : rows); setCursor(next); setLoaded(true);
    } catch (e) {
      if (token === generation.current) {setError((e as Error).message); setRetry(() => () => void load(more, selectedMode, term, after));}
    } finally { if (token === generation.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { generation.current++; }; }, [kind, work.workspace_id, work.kind, work.object_id]);
  async function choose(item: any) {
    const token = generation.current; setAttaching(true); setError(""); setRetry(undefined);
    let value: ContextSelection;
    if (kind === "scenes") value = {page: "drama.scenes", object: {...item.document_ref, scene_range: item.range},
      label: `${item.episode_number ? `第${item.episode_number}集 ` : ""}${item.document_title} / 第${item.scene_number}场 ${item.heading}`};
    else if (mode === "episodes") value = {page: "video.sources", object: {video_episode_id: item.episode.video_episode_id, revision: item.episode.revision, sha256: item.sha256}, label: `第${item.episode_number}集 ${item.episode.title}`};
    else value = {page: "video.sources", object: {media_ref: item.media_ref}, label: `${item.episode ? `第${item.episode.episode_number}集 ` : ""}${item.media.title}`};
    try { if (await onSelect({...value, label: value.label.trim().slice(0, 120)}) && token === generation.current) onClose(); }
    catch (e) { if (token === generation.current) setError((e as Error).message); }
    finally { if (token === generation.current) setAttaching(false); }
  }
  const visible = kind === "video" && mode === "episodes" ? items.slice(0, count) : items;
  return <ContextPickerDialog title={title} disabled={attaching} onClose={close}>
    <form onSubmit={event => {event.preventDefault(); if (!attaching) void load();}}>
      {kind === "video" && <select aria-label="视频内容类型" value={mode} disabled={attaching} onChange={event => {const next = event.target.value as VideoMode; setMode(next); void load(false, next);}}><option value="media">视频成果</option><option value="episodes">分集</option></select>}
      <input autoFocus type="search" aria-label={kind === "scenes" ? "查找剧本场次" : "查找视频内容"} placeholder={kind === "scenes" ? "查找场次或分集" : "查找分集或成果"} maxLength={120} value={query} disabled={attaching} onChange={event => setQuery(event.target.value)}/>
      <button disabled={busy}>查找</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">{attaching ? "正在附加固定来源…" : "正在读取来源目录…"}</p>}
    <div className="agent-context-picker-items">{visible.map(item => <button key={kind === "scenes" ? JSON.stringify([item.document_ref, item.range]) : mode === "episodes" ? item.episode.video_episode_id : item.media_ref.media_id} disabled={busy} onClick={() => void choose(item)}>
      <span className="agent-context-picker-copy"><strong>{kind === "scenes" ? item.heading : mode === "episodes" ? item.episode.title : item.media.title}</strong>
        <span>{kind === "scenes" ? `${item.episode_number ? `第${item.episode_number}集 ` : ""}${item.document_title} / 第${item.scene_number}场`
          : mode === "episodes" ? `第${item.episode_number}集` : `${item.episode ? `第${item.episode.episode_number}集 ${item.episode.episode.title}` : "视频成果"}`}</span></span>
      <small>{kind === "scenes" ? "固定原稿" : `第${mode === "episodes" ? item.episode.revision : item.media_ref.revision}版`}</small>
    </button>)}</div>
    {loaded && !busy && !error && !items.length && <p>{kind === "scenes" ? "没有匹配的剧本场次。" : "没有匹配的视频内容。"}</p>}
    {cursor && <button disabled={busy} onClick={() => void load(true)}>更多{kind === "scenes" ? "场次" : "成果"}</button>}
    {kind === "video" && mode === "episodes" && items.length > count && <button disabled={busy} onClick={() => setCount(value => value + 20)}>更多分集</button>}
    {retry && <button disabled={busy} onClick={retry}>重新读取</button>}
  </ContextPickerDialog>;
}
