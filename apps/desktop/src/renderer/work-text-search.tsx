import React, {useEffect, useRef, useState} from "react";
import {desktop, data} from "./bridge.ts";
import {textProjection, projectedRange} from "@hetu/workbench-ui/text-projection";
import {searchText, type SearchOptions, type SearchJob} from "./text-search.ts";
import {sourceQuotes, type SourceQuote} from "./annotation-anchors.ts";
import {searchLabel, searchError, type SearchMessageKey} from "./search-labels.ts";

export interface WorkTextMatch {document_id: string; revision_id: string; title: string; created_at?: string; quote: SourceQuote; excerpt: string; before: string; matched: string; after: string}
export function WorkTextSearch({options, documents, language, open}: {options: SearchOptions; documents: {document_id: string; title: string}[]; language?: string; open: (match: WorkTextMatch) => Promise<void>}) {
  const t = (key: SearchMessageKey, values?: Record<string, number>) => searchLabel(key, language, values);
  const [rows, setRows] = useState<WorkTextMatch[]>([]), [coverage, setCoverage] = useState({read: 0, total: documents.length, failed: [] as string[], limited: false});
  const [busy, setBusy] = useState(false), [cancelled, setCancelled] = useState(false), [error, setError] = useState(""), [reload, setReload] = useState(0), [opening, setOpening] = useState(false);
  const cancel = useRef(() => {});
  useEffect(() => {
    let active = true, query: SearchJob | undefined;
    cancel.current = () => {active = false; query?.cancel(); setCancelled(true); setBusy(false);};
    setRows([]); setCoverage({read: 0, total: documents.length, failed: [], limited: false}); setCancelled(false); setError("");
    if (!options.query) {setBusy(false); return;}
    setBusy(true);
    const timer = setTimeout(() => void (async () => {
      const matches: WorkTextMatch[] = [], failed: string[] = [];
      let read = 0, limited = false;
      for (const document of documents) {
        if (!active) break;
        try {
          const value = data(await desktop.read("hetu.documents.get", {document_id: document.document_id}));
          if (!active) break;
          const projection = textProjection(value.content, value.revision.source_format, document.title);
          query = searchText(projection.text, options); const result = await query.result;
          if (!active) break;
          limited ||= result.truncated;
          const found = result.matches.slice(0, Math.max(0, 1000 - matches.length)).flatMap(match => {
            const range = projectedRange(projection, match.from, match.to); if (!range) return [];
            const before = projection.text.slice(Math.max(0, match.from - 24), match.from).replace(/\s+/g, " "), matched = projection.text.slice(match.from, match.to).replace(/\s+/g, " "), after = projection.text.slice(match.to, Math.min(projection.text.length, match.to + 48)).replace(/\s+/g, " ");
            return [{...range, before, matched, after, excerpt: before + matched + after}];
          });
          limited ||= found.length < result.matches.length;
          matches.push(...sourceQuotes(value.content, found).map(match => ({document_id: document.document_id, revision_id: value.revision.revision_id, title: document.title, created_at: value.revision.created_at, quote: match.quote, excerpt: match.excerpt, before: match.before, matched: match.matched, after: match.after})));
          read++;
        } catch (error) {
          if (!active) break;
          failed.push(document.title + ": " + searchError((error as Error).message, language));
          if (["search.invalid_regex", "search.query_limit", "search.worker_unavailable"].includes((error as Error).message)) {setError(searchError((error as Error).message, language)); break;}
        }
        if (active) {setRows([...matches]); setCoverage({read, total: documents.length, failed: [...failed], limited});}
        if (limited && matches.length >= 1000) break;
      }
      if (active) {setRows(matches); setCoverage({read, total: documents.length, failed, limited}); setBusy(false);}
    })(), 180);
    return () => {active = false; query?.cancel(); clearTimeout(timer);};
  }, [options, documents, reload]);
  async function show(match: WorkTextMatch) {setOpening(true); setError(""); try {await open(match);} catch (error) {setError((error as Error).message);} finally {setOpening(false);} }
  return <section className="work-search-results" aria-label={t("search.work_results")}>
    <p role="status">{t("search.coverage", {read: coverage.read, total: coverage.total, count: rows.length})}{busy ? " " + t("search.searching") : cancelled ? " " + t("search.cancelled") : ""}</p>
    {busy ? <button type="button" onClick={() => cancel.current()}>{t("search.cancel")}</button> : options.query && <button type="button" onClick={() => setReload(reload + 1)}>{t("search.refresh")}</button>}
    {coverage.limited && <p role="status">{t("search.work_limited")}</p>}{error && <p role="alert">{error}</p>}
    {!!coverage.failed.length && <details><summary>{t("search.failed", {count: coverage.failed.length})}</summary><ul>{coverage.failed.map((value, index) => <li key={index}>{value}</li>)}</ul></details>}
    {!busy && !cancelled && !coverage.failed.length && !coverage.limited && coverage.read === coverage.total && !!options.query && !rows.length && <p>{t("search.none")}</p>}
    <ol>{rows.map(row => <li key={row.document_id + ":" + row.quote.byte_start}><button type="button" disabled={opening} onClick={() => void show(row)}><strong>{row.title}</strong><span>{row.before}<mark>{row.matched}</mark>{row.after}</span><small>{row.created_at ? new Date(row.created_at).toLocaleString() : ""}</small></button></li>)}</ol>
  </section>;
}
