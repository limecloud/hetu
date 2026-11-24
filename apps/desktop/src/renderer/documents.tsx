import {restoreReadingState, useReadingPersistence} from "./reading-state.ts";
import { documentSelectionKey, viewStorage } from "./view-storage.ts";
import { ManuscriptComparison, ManuscriptText, ScreenplayText, ScreenplayMetadata, parseFountain, selectedScreenplaySource, readingProfile, readingStyle, documentZooms, readingText } from "@hetu/workbench-ui";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {flushSync} from "react-dom";
import {createPortal} from "react-dom";
import type { SurfaceContext } from "./contributions.tsx";
import { desktop, data } from "./bridge.ts";
import { AuthorEditor, selectedSource, type AuthorEditorHandle, type EditorContext } from "./editor.tsx";
import { AuthorLifecycle } from "./author-review.tsx";
import { ArtworkLibrary } from "./artwork.tsx";
import { usePreferences } from "./preferences.tsx";
import { readWorkContent, type DocumentGroup } from "./work-content.ts";
import { Icon, IconButton, useWorkbench } from "./workbench.tsx";
import { manuscriptKey, readEpisodeReference } from "./episode-manuscript.ts";
import {ManuscriptAnnotations} from "./manuscript-annotations.tsx";
import {readerRange, sourceOffsets, type AnnotationSurface, type DocumentNote, type SourceQuote} from "./annotation-anchors.ts";

import { ReadingOptions } from "./reading-options.tsx";
import type {WorkTextMatch} from "./work-text-search.tsx";
import {ManuscriptSearch} from "./manuscript-search.tsx";
import {readerAnchor} from "./reading-position.ts";
import {EditorControls, EditorInlineControls} from "./editor-controls.tsx";
import { useManuscriptStatistics } from "./manuscript-statistics.ts";
import { useReadingPosition } from "./reading-position.ts";
import {useEditorContextMenu} from "./editor-context-menu.tsx";
import {useContextMenu} from "@hetu/workbench-ui";
import {contextKey} from "./text-context-menus.tsx";
import {DocumentRename} from "./document-rename.tsx";
import {DocumentMove, type DocumentMoveSource} from "./document-move.tsx";
import type {EditorContextTarget} from "./editor-context-target.ts";
import {NovelEditor} from "./novel-editors.tsx";
import {manuscriptVisibleText} from "@hetu/workbench-ui/manuscript-format";
import {documentTitleInSource} from "./document-title.ts";
import {WritingTools} from "./writing-tools.tsx";

export function Documents({ work, documentId, notify, ai, reviewTask }: SurfaceContext) {
  const showMenu = useContextMenu();
  const [renaming, setRenaming] = useState<any>(), [structureOpen, setStructureOpen] = useState(false);
  const [moving, setMoving] = useState<DocumentMoveSource>(), [moveRevision, setMoveRevision] = useState(0);
  const [lastMove, setLastMove] = useState<{document_id: string; move_ref: any}>();
  const preferences = usePreferences();
  const shell = useWorkbench();
  const [showSearch, setShowSearch] = useState(false);
  const searchVisible = shell.sidebarLayer === "document" && shell.sidebarPanel === "search";
  useEffect(() => {if (searchVisible) setShowSearch(true);}, [searchVisible]);
  const [searchMatches, setSearchMatches] = useState<SourceQuote[]>([]), [activeSearchMatch, setActiveSearchMatch] = useState(0), [textSelection, setTextSelection] = useState<SourceQuote | null>(null);
  const searchReturn = useRef<{source: string; quote?: SourceQuote; top: number; inset: number}>();
  const searchNavigation = useRef<{visible: boolean; focus: boolean}>();
  const searchHighlights = (matches: SourceQuote[], current: number) => {setSearchMatches(matches); setActiveSearchMatch(current);};
  const scroll = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLElement>(null), editorSurface = useRef<AuthorEditorHandle>(null);
  const saving = useRef(false);
  const [annotationList, setAnnotationList] = useState(0);
  const [annotationError, setAnnotationError] = useState("");
  const [commentRequest, setCommentRequest] = useState<{documentId: string; revision: string; quote: SourceQuote; nonce: number}>();
  const [searchRequest, setSearchRequest] = useState<{query: string; nonce: number}>();
  const [workJump, setWorkJump] = useState<WorkTextMatch>();
  const [editorContext, setEditorContext] = useState<EditorContext>({canUndo: false, canRedo: false});
  const updateEditorContext = (value: EditorContext) => setEditorContext(current => JSON.stringify(current) === JSON.stringify(value) ? current : value);
  const layout = useRef<HTMLDivElement>(null);
  const selectionKey = documentSelectionKey(work);
  const positionKey = selectionKey + ":positions";
  const remember = useReadingPersistence(work, notify);
  const [readingPreview, setReadingPreview] = useState<Record<string, any>>();
  const [composing, setComposing] = useState(false);
  const [zoom, setZoom] = useState(() => { const saved = Number(viewStorage.getItem(selectionKey + ":zoom")); return documentZooms.includes(saved as any) ? saved : 100; });
  const readingPreferences = readingPreview ?? preferences;
  const stableReading = useRef(readingPreferences);
  if (!composing) stableReading.current = readingPreferences;
  const profile = readingProfile(stableReading.current, work.kind === "drama" ? "screenplay" : "novel");
  const [documents, setDocuments] = useState<any[]>([]),
    [groups, setGroups] = useState<DocumentGroup[]>([]),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(""),
    [readError, setReadError] = useState(""),
    [reload, setReload] = useState(0),
    [selected, setSelected] = useState<any>(),
    [manuscript, setManuscript] = useState<any>(),
    [reference, setReference] = useState<any>(),
    [referenceContent, setReferenceContent] = useState(""),
    [content, setContent] = useState(""),
    [editing, setEditing] = useState(false),
    [sourceMode,setSourceMode]=useState(false),
    [sceneJump,setSceneJump]=useState<{offset:number;request:number}>(),
    [showImages, setShowImages] = useState(false),
    [busyState, setBusy] = useState<false | "loading" | "saving">(false),
    [history, setHistory] = useState<any[]>([]),
    [compare, setCompare] = useState<string>(),
    [recovery, setRecovery] = useState<any>(),
    [notes, setNotes] = useState<any>({ revision: 0, sha256: null, items: [] }),
    [quote, setQuote] = useState<ReturnType<typeof selectedSource>>(null),
    [noteRecovery, setNoteRecovery] = useState<any>();
  const typography = readingStyle(profile, zoom, sourceMode);
  const restoreReady = useRef(false);
  const busy = busyState !== false, editorLocked = busyState === "loading" && !restoreReady.current;
  const reader = useRef<HTMLElement>(null);
  const comparison = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (compare !== undefined) comparison.current?.showModal(); }, [compare]);
  const current = useRef<any>(),
    requested = useRef<any>(),
    text = useRef(""),
    pending = useRef<any>(),
    generation = useRef(0),
    composition = useRef(false);
  useEffect(() => {
    let active = true;
    const selectionGeneration = generation.current;
    setLoading(true);
    setLoadError("");
    Promise.all([readWorkContent(work), restoreReadingState(work, selectionKey, positionKey).catch(error => notify("阅读位置未能恢复：" + error.message))])
      .then(([result]) => {
        if (active) {
          setDocuments(result.documents);
          setGroups(result.groups);
          const previous = viewStorage.getItem(selectionKey);
          const document = result.documents.find((item) => item.document_id === previous) ?? result.groups[0]?.documents[0] ?? result.documents[0];
          // 当前文稿仍在目录中时只更新目录，避免刷新回包重新加载正文并短暂锁住编辑器。
          const currentId = current.current?.document.document_id;
          if (document && currentId !== document.document_id && generation.current === selectionGeneration) void load(document);
        }
      })
      .catch((error) => {
        if (active) {
          setLoadError(error.message);
          notify(error.message);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, [work, reload]);
  async function load(document: any, selectedByAuthor = false, expectedRevision?: string) {
    if (current.current && text.current !== current.current.content) {
      notify("请先保存当前修改。");
      return;
    }
    const epoch = ++generation.current;
    requested.current = document;
    setReadError("");
    if (selectedByAuthor && shell.directoryTarget && window.matchMedia("(max-width: 760px)").matches) shell.setNavigationVisible(false);
    restoreReady.current = false; setBusy("loading");
    try {
      const result = data(
        await desktop.read("hetu.documents.get", {
          document_id: document.document_id,
        }),
      );
      if (expectedRevision && result.revision.revision_id !== expectedRevision) throw new Error("搜索命中的修订已有变化，请重新查询；原编辑内容已保留。");
      const [annotations, saved, historyResult, noteBuffer, authorOperation, episode] = await Promise.all(
        [
          desktop.read("hetu.annotations.list", {
            document_id: document.document_id,
          }),
          desktop.buffer(document.document_id),
          desktop.read("hetu.documents.history", {
            document_id: document.document_id,
          }),
          desktop.buffer(document.document_id, undefined, "annotations"),
          desktop.author("journal", { document_id: document.document_id }),
          document.episode_id ? desktop.read("hetu.drama.episodes.get", { episode_id: document.episode_id }).then(data) : undefined,
        ],
      );
      const hasRecovery = saved && (saved.pending || saved.content !== result.content);
      const preferred = !hasRecovery && !result.content.trim() && episode?.manuscript.references.length
        ? episode.manuscript.references.find((item: any) => item.kind === "submitted") ?? episode.manuscript.references[0] : undefined;
      const preferredContent = preferred ? await readEpisodeReference(document.episode_id, preferred) : "";
      if (epoch !== generation.current) return;
      current.current = result;
      text.current = result.content;
      setSelected({ ...result, episode_id: document.episode_id });
      try {
        const move_ref = JSON.parse(viewStorage.getItem(selectionKey + ":move:" + document.document_id) ?? "null");
        setLastMove(move_ref ? {document_id: document.document_id, move_ref} : undefined);
      } catch {setLastMove(undefined);}
      setManuscript(episode?.manuscript);
      setReference(preferred);
      setReferenceContent(preferredContent);
      viewStorage.setItem(selectionKey, document.document_id);
      remember.document(document.document_id);
      setContent(result.content);
      setEditing(work.kind!=="drama");
      setSourceMode(false);
      setSceneJump(undefined);
      setShowImages(false);
      setCompare(undefined);
      setQuote(null);
      setCommentRequest(undefined); setAnnotationError("");
      setTextSelection(null); setShowSearch(false);
      setAnnotationList(0);
      setNotes(data(annotations));
      setNoteRecovery(noteBuffer);
      pending.current = undefined;
      setRecovery(saved);
      setHistory(data(historyResult).revisions ?? []);
      if (authorOperation?.status === "pending" || authorOperation?.status === "blocked") shell.setInspector(true);
      return result;
    } catch (error) {
      if (epoch === generation.current) {
        setReadError((error as Error).message);
        notify((error as Error).message);
      }
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!documentId || documentId === current.current?.document.document_id || !documents.length) return;
    const target = documents.find(item => item.document_id === documentId);
    if (target) void load(target, true);
  }, [documentId, documents]);
  async function selectManuscript(key: string) {
    if (current.current && text.current !== current.current.content) {
      notify("请先保存当前修改。");
      return;
    }
    setCommentRequest(undefined);
    if (key === "author") { setReference(undefined); setQuote(null); setSourceMode(false); setEditing(true); return; }
    const next = manuscript?.references.find((item: any) => manuscriptKey(item) === key);
    if (!next) return;
    const epoch = ++generation.current;
    restoreReady.current = false; setBusy("loading");
    try {
      const value = await readEpisodeReference(selected.episode_id, next);
      if (epoch !== generation.current) return;
      setReference(next); setReferenceContent(value); setQuote(null); setSourceMode(false); setEditing(false);
    } catch (error) { notify((error as Error).message); }
    finally { if (epoch === generation.current) setBusy(false); }
  }
  async function change(value: string) {
    setQuote(null);
    text.current = value;
    setContent(value);
    await desktop.dirty(value !== current.current?.content);
    if (current.current)
      await desktop.buffer(current.current.document.document_id, {
        content: value,
        base: current.current,
        pending: pending.current,
        work_ref: work,
      });
  }
  async function save() {
    if (!current.current || composition.current || reference || saving.current) return;
    saving.current = true;
    restoreReady.current = false; setBusy("saving");
    const base = current.current;
    if (!pending.current)
      pending.current = {
        document_id: base.document.document_id,
        base_revision_id: base.revision.revision_id,
        source_format: base.revision.source_format,
        content: text.current,
        operation_key: crypto.randomUUID(),
      };
    const fixed = pending.current;
    try {
      await desktop.buffer(fixed.document_id, {
        content: text.current,
        base: current.current,
        pending: fixed,
        work_ref: work,
      });
      const result = data(await desktop.read("hetu.documents.save", fixed));
      capturePosition(JSON.stringify([fixed.document_id, result.revision.revision_id]), text.current !== fixed.content);
      current.current = { ...result, content: fixed.content };
      setSelected({ ...current.current, episode_id: selected.episode_id });
      setQuote(null);
      pending.current = undefined;
      await desktop.dirty(text.current !== fixed.content);
      await desktop.buffer(
        fixed.document_id,
        text.current === fixed.content
          ? null
          : { content: text.current, base: current.current, work_ref: work },
      );
      notify("已保存新修订。");
      void desktop.read("hetu.documents.history", { document_id: fixed.document_id })
        .then((result) => setHistory(data(result).revisions ?? []))
        .catch((error) => notify("修订已保存，历史列表读取失败：" + error.message));
    } catch (error) {
      notify(
        (error as Error).message + " 原操作已保留，可用相同输入再次保存。",
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function saveNote(fixed: any) {
    setAnnotationError("");
    restoreReady.current = false; setBusy("loading");
    setNoteRecovery({ pending: fixed });
    try {
      await desktop.buffer(
        fixed.document_id,
        { pending: fixed },
        "annotations",
      );
      setNotes(data(await desktop.read("hetu.annotations.save", fixed)));
      await desktop.buffer(fixed.document_id, null, "annotations");
      setNoteRecovery(null);
      setQuote(null);
      notify("已记录固定原文批注。");
      return true;
    } catch (e) {
      setAnnotationError((e as Error).message);
      notify((e as Error).message + " 原批注输入已保留，可恢复。");
      return false;
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (reference || !preferences.autosave || !editing || busy || composing || !current.current ||
        pending.current || text.current === current.current.content) return;
    const timer = setTimeout(() => { void save(); }, 1800);
    return () => clearTimeout(timer);
  }, [preferences.autosave, editing, busy, composing, content, reference]);
  function display(edit: boolean, source = false) {
    if (edit === editing && source === sourceMode) return;
    capturePosition();
    setQuote(null);
    setTextSelection(null);
    if (edit && selected) shell.pinDocumentTab(selected.document.document_id);
    setEditing(edit); setSourceMode(source);
  }
  useEffect(() => {
    shell.setDocumentTools(selected ? {
      title: selected.document.title,
      readOnly: !!reference,
      dirty: !reference && (content !== selected.content || !!pending.current),
      busy, composing,
      save: () => void save(),
      ai: () => reference && reviewTask ? reviewTask(reference.task_ref.task_id) : ai({ document_id: selected.document.document_id, revision_id: selected.revision.revision_id, ...(quote ?? {}) }),
    } : undefined);
  }, [selected, content, busy, composing, quote, recovery, reference]);
  useEffect(() => {
    shell.setDocumentTab(selected ? { id: selected.document.document_id, title: selected.document.title, preview: true } : undefined);
  }, [selected?.document.document_id, selected?.document.title]);
  useEffect(() => () => shell.setDocumentTools(undefined), []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector("dialog[open]")) return;
      if (shell.directoryTarget && shell.navigationVisible && window.matchMedia("(max-width: 760px)").matches) shell.setNavigationVisible(false);
      else if (shell.inspector) shell.setInspector(false);
      else if (searchVisible) closeSearch();
      else if (shell.focus) shell.setFocus(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [shell.inspector, searchVisible, shell.focus, shell.directoryTarget, shell.navigationVisible]);
  const displayedContent = reference ? referenceContent : content;
  const positionIdentity = selected ? JSON.stringify([selected.document.document_id, reference ? manuscriptKey(reference) : selected.revision.revision_id]) : "";
  const capturePosition = useReadingPosition({ storageKey: positionKey, identity: positionIdentity, source: displayedContent,
    editing, readOnly: !!reference, reader, editor: editorSurface, scroll, composing,
    persist: reference || content === selected?.content ? remember.position : undefined,
    layoutKey: JSON.stringify([typography, readingPreferences.document_theme, shell.directoryVisible, shell.focus, shell.inspector]) });
  useEffect(() => {
    const capture = () => capturePosition(); window.addEventListener("hetu:before-interface-scale", capture);
    return () => window.removeEventListener("hetu:before-interface-scale", capture);
  }, [capturePosition]);
  const isScreenplay=work.kind==="drama"&&(reference?.source_format??selected?.revision.source_format)==="fountain";
  const sourceFormat = reference?.source_format ?? selected?.revision.source_format ?? "plain";
  const titleSource = selected?.document.title ? documentTitleInSource(displayedContent, selected.document.title, sourceFormat, isScreenplay) : {heading: false, plain: false};
  const titleFromSource = !sourceMode && titleSource.heading;
  const titleInBody = !sourceMode && !titleSource.heading && titleSource.plain;
  const screenplay=useMemo(()=>isScreenplay?parseFountain(displayedContent):undefined,[isScreenplay,displayedContent]);
  const scenes=screenplay?.lines.filter(line=>line.kind==="scene")??[];
  const currentNotes: DocumentNote[] = !reference && content === selected?.content ? notes.items.filter((note: DocumentNote) => !note.resolved && note.source_ref.revision_id === selected?.revision.revision_id) : [];
  function annotationSurface(): AnnotationSurface | null {
    if (reference) return null;
    if (editing) return editorSurface.current;
    if (content !== selected?.content) return null;
    const element = reader.current;
    if (!element) return null;
    return {
      rect: quote => readerRange(element, content, quote)?.[0]?.getBoundingClientRect() ?? null,
      reveal: quote => { const range = readerRange(element, content, quote, true)?.[0]; if (range) {const top = range.getBoundingClientRect().top; if (scroll.current) scroll.current.scrollTop += top - scroll.current.getBoundingClientRect().top - 16;} },
      contains: (quote, x, y) => (readerRange(element, content, quote) ?? []).some(range => [...range.getClientRects()].some(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)),
    };
  }
  useLayoutEffect(() => {
    const ranges = !editing && reader.current ? currentNotes.flatMap(note => readerRange(reader.current!, content, note.source_ref) ?? []) : [];
    CSS.highlights.set("hetu-annotations", new Highlight(...ranges));
    return () => { CSS.highlights.delete("hetu-annotations"); };
  }, [notes, selected, content, editing, reference, sourceMode]);
  function jumpScene(offset:number){
    setSceneJump({offset,request:Date.now()});
    if(editing&&!reference)return;
    const target=layout.current?.querySelector<HTMLElement>("#screenplay-line-"+offset);
    if(target&&scroll.current)scroll.current.scrollTop+=target.getBoundingClientRect().top-scroll.current.getBoundingClientRect().top-16;
    if(window.matchMedia("(max-width: 760px)").matches)shell.setNavigationVisible(false);
  }
  function selectQuote(){if(!reader.current)return;const value = isScreenplay&&!sourceMode?selectedScreenplaySource(reader.current,displayedContent):selectedSource(reader.current,displayedContent);setTextSelection(value);if(!reference&&content===selected.content)setQuote(value);}
  async function openWorkMatch(match: WorkTextMatch) {
    if (content !== selected?.content) throw new Error("请先保存当前修改，再打开其他稿件中的命中。");
    const document = documents.find(item => item.document_id === match.document_id);
    if (!document) throw new Error("命中文档已不在当前目录，请刷新后重新查询。");
    const result = await load(document, true, match.revision_id);
    if (!result || !sourceOffsets(result.content, match.quote)) throw new Error("无法核对命中的原文，请重新查询。");
    setEditing(false); setReference(undefined); setSourceMode(false); setWorkJump(match);
  }
  useLayoutEffect(() => {
    if (!workJump || workJump.document_id !== selected?.document.document_id || workJump.revision_id !== selected?.revision.revision_id || editing) return;
    const frame = requestAnimationFrame(() => { const element = reader.current, stage = scroll.current; if (!element || !stage) return;
      const ranges = readerRange(element, displayedContent, workJump.quote, true) ?? [];
      if (ranges[0]) {stage.scrollTop += ranges[0].getBoundingClientRect().top - stage.getBoundingClientRect().top - 24; CSS.highlights.set("hetu-work-search", new Highlight(...ranges));} });
    return () => {cancelAnimationFrame(frame); CSS.highlights.delete("hetu-work-search");};
  }, [workJump, selected, editing, displayedContent]);
  function openSearch() {
    shell.setSidebarLayer("document"); shell.setSidebarPanel("search");
    if (shell.searchTarget) {
      searchNavigation.current = {visible: shell.navigationVisible, focus: shell.focus};
      shell.setNavigationVisible(true); shell.setFocus(false);
    }
    const stage = scroll.current;
    if (stage) { const top = stage.getBoundingClientRect().top, quote = editing && !reference ? editorSurface.current?.anchorAt?.(top + 24) : reader.current ? readerAnchor(reader.current, displayedContent, top + 24) : undefined;
      const rect = quote && (editing && !reference ? editorSurface.current?.rect(quote) : reader.current && readerRange(reader.current, displayedContent, quote)?.[0]?.getBoundingClientRect());
      searchReturn.current = {source: displayedContent, quote, top: stage.scrollTop, inset: rect ? rect.top - top : 24}; }
    setShowSearch(true);
    requestAnimationFrame(() => (shell.searchTarget ?? workspace.current)?.querySelector<HTMLInputElement>(".search-main input")?.focus({preventScroll: true}));
  }
  function closeSearch() {
    shell.setSidebarPanel("directory"); setSearchMatches([]);
    if (editing && !reference) editorSurface.current?.focus(); else scroll.current?.focus({preventScroll: true});
    if (searchNavigation.current) {
      shell.setNavigationVisible(searchNavigation.current.visible); shell.setFocus(searchNavigation.current.focus);
      searchNavigation.current = undefined;
    }
    const position = searchReturn.current;
    if (!position || position.source !== displayedContent) return;
    const expectedTop = scroll.current?.scrollTop;
    requestAnimationFrame(() => { const stage = scroll.current; if (!stage || expectedTop === undefined || Math.abs(stage.scrollTop - expectedTop) > 1) return; const rect = position.quote && (editing && !reference ? editorSurface.current?.rect(position.quote) : reader.current && readerRange(reader.current, displayedContent, position.quote)?.[0]?.getBoundingClientRect());
      if (rect) stage.scrollTop += rect.top - stage.getBoundingClientRect().top - position.inset; else stage.scrollTop = position.top; });
  }
  useEffect(() => {
    const find = (event: KeyboardEvent) => { if (workspace.current?.clientHeight && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && !event.isComposing && !document.querySelector("dialog[open]")) {event.preventDefault(); if (!searchVisible) openSearch(); else {shell.setNavigationVisible(true); shell.setFocus(false); (shell.searchTarget ?? workspace.current)?.querySelector<HTMLInputElement>(".search-main input")?.focus();}} };
    window.addEventListener("keydown", find); return () => window.removeEventListener("keydown", find);
  }, [displayedContent, editing, reference, searchVisible, shell.searchTarget, shell.navigationVisible, shell.focus]);
  const statistics = useManuscriptStatistics(displayedContent);
  async function duplicate(doc: any) {
    restoreReady.current = false; setBusy("loading");
    try {
      const prepared = await desktop.author("duplicate", {document_id: doc.document_id, base_revision_id: doc.current_revision_id});
      const result = data(await desktop.author("commit", {token: prepared.token}));
      const record = await desktop.author("journal", {document_id: doc.document_id});
      if (record) await desktop.author("acknowledge", {document_id: doc.document_id, operation_key: record.input.operation_key});
      viewStorage.setItem(selectionKey, result.document.document_id);
      setReload(value => value + 1); window.dispatchEvent(new Event("hetu:work-changed"));
      notify("文稿副本已创建。");
    } catch (error) {
      viewStorage.setItem(selectionKey, doc.document_id); setReload(value => value + 1);
      throw error;
    } finally {setBusy(false);}
  }
  async function openMove(target: EditorContextTarget) {
    target.requireCurrent();
    const fixed = target.blockQuote, id = current.current?.document.document_id, source = text.current;
    if (!id || !fixed.quote) return;
    if (current.current.content !== source) await save();
    if (current.current?.document.document_id !== id || current.current.content !== source || text.current !== source)
      throw new Error("请先完成当前保存，再重新选择移动内容。");
    setMoving({document_id: id, revision_id: current.current.revision.revision_id, range: fixed});
  }
  async function receiveMove(result: any) {
    const source = {...result.source, content: data(await desktop.read("hetu.documents.get", {document_id: result.source.document.document_id, revision_id: result.source.revision.revision_id})).content};
    if (current.current?.document.document_id !== source.document.document_id || text.current !== current.current.content)
      throw new Error("移动已提交，当前文稿上下文发生变化，请刷新两端核对。");
    await desktop.buffer(source.document.document_id, null); await desktop.dirty(false);
    current.current = source; text.current = source.content; pending.current = undefined;
    setContent(source.content); setSelected({...source, episode_id: selected?.episode_id}); setMoveRevision(value => value + 1);
    setQuote(null); setCommentRequest(undefined); setTextSelection(null);
    viewStorage.setItem(selectionKey + ":move:" + source.document.document_id, JSON.stringify(result.move_ref ?? null));
    if (result.move_ref) setLastMove({document_id: source.document.document_id, move_ref: result.move_ref});
    else setLastMove(undefined);
    setDocuments(items => items.map(item => item.document_id === source.document.document_id
      ? {...item, ...source.document} : item.document_id === result.target.document.document_id ? {...item, ...result.target.document} : item));
    if (result.target_created) setReload(value => value + 1);
    setHistory(items => [source.revision, ...items]);
    window.dispatchEvent(new Event("hetu:work-changed"));
    notify(result.move_ref ? "所选内容已移至目标文稿。" : "已撤销跨文稿移动。");
  }
  async function restoreMove() {
    if (!lastMove || content !== selected?.content) return;
    restoreReady.current = false; setBusy("loading");
    try {
      const prepared = await desktop.author("restore_move", {document_id: lastMove.document_id, move_ref: lastMove.move_ref});
      await receiveMove(data(await desktop.author("commit", {token: prepared.token})));
      // 正文与目录已按提交回执回读完成；journal/ack 只确认原操作，不能继续锁住编辑器。
      restoreReady.current = true;
      flushSync(() => setBusy(false));
      const record = await desktop.author("journal", {document_id: lastMove.document_id});
      if (record) await desktop.author("acknowledge", {document_id: lastMove.document_id, operation_key: record.input.operation_key});
    } finally {setBusy(false);}
  }
  function documentMenu(event: React.MouseEvent | React.KeyboardEvent, doc: any) {
    if (doc.document_id === selected?.document.document_id) doc = {...doc, ...selected.document};
    const dirty = !!selected && content !== selected.content;
    const read = async () => data(await desktop.read("hetu.documents.get", {document_id: doc.document_id, revision_id: doc.current_revision_id}));
    showMenu(event, doc.title, [
      {id: "open", label: "打开", disabled: busy, action: async () => {await load(doc, true);}},
      {id: "rename", label: "重命名", disabled: busy || dirty, action: () => setRenaming({...doc})},
      {id: "structure", label: "整理卷章", disabled: busy || dirty || work.kind !== "novel", action: () => setStructureOpen(true)},
      {id: "duplicate", label: "复制文稿", disabled: busy || dirty || !!reference, action: () => duplicate(doc)},
      {id: "clipboard", separator: true},
      {id: "copy-title", label: "复制名称", action: () => desktop.copy(doc.title)},
      {id: "copy-as", label: "复制为", children: [
        {id: "plain", label: "纯文本", action: async () => {const value = await read(); await desktop.copy(value.revision.source_format === "markdown" ? manuscriptVisibleText(value.content) : value.content);}},
        {id: "source", label: "完整原稿", action: async () => {await desktop.copy((await read()).content);}},
      ]},
      {id: "review", separator: true},
      {id: "history", label: "版本历史与来源", disabled: busy || dirty, action: async () => {if (await load(doc, true)) shell.setInspector(true);}},
      {id: "ai", label: "让 AI 处理本稿", disabled: busy, action: () => ai({document_id: doc.document_id, revision_id: doc.current_revision_id})},
    ], {onError: error => notify(error.message)});
  }
  const documentContext = (doc: any) => ({onContextMenu: (event: React.MouseEvent) => documentMenu(event, doc), onKeyDown: (event: React.KeyboardEvent) => {if (contextKey(event)) documentMenu(event, doc);}});
  function readingMenu(event: React.MouseEvent | React.KeyboardEvent) {
    const element = reader.current; if (!element || !selected) return;
    const selection = getSelection();
    let fixed = selectedSource(element, displayedContent);
    const hit = event.target instanceof Element ? event.target.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote, .screenplay-line, .manuscript-paragraph") : null;
    if (!fixed && hit && element.contains(hit)) {
      const range = document.createRange(); range.selectNodeContents(hit); selection?.removeAllRanges(); selection?.addRange(range);
      fixed = selectedSource(element, displayedContent);
    }
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
    const plain = selection?.toString() ?? "", saved = !reference && content === selected.content;
    const restore = () => {if (range?.startContainer.isConnected && range.endContainer.isConnected) {selection?.removeAllRanges(); selection?.addRange(range);}};
    const requireCurrent = () => {
      if (!element.isConnected || reader.current !== element || current.current?.document.document_id !== selected.document.document_id || current.current?.revision.revision_id !== selected.revision.revision_id || text.current !== displayedContent)
        throw new Error("正文或修订已变化，请重新打开右键菜单。");
    };
    const comment = () => {requireCurrent(); if (fixed) {setQuote(fixed); setTextSelection(fixed); setCommentRequest({documentId: selected.document.document_id, revision: selected.revision.revision_id, quote: fixed, nonce: Date.now()});}};
    showMenu(event, "阅读右键菜单", [
      {id: "copy", label: "复制", disabled: !plain, action: () => desktop.copy(plain)},
      {id: "copy-as", label: "复制为", children: [
        {id: "plain", label: "纯文本", disabled: !plain, action: () => desktop.copy(plain)},
        {id: "raw", label: "完整原稿", action: () => desktop.copy(fixed?.quote ?? displayedContent)},
      ]},
      {id: "select-all", label: "全选", action: () => {const range = document.createRange(); range.selectNodeContents(element); selection?.removeAllRanges(); selection?.addRange(range); selectQuote();}},
      {id: "review", separator: true},
      {id: "comment", label: "添加批注", disabled: busy || !saved || !fixed, action: comment},
      {id: "ai", label: "让 AI 处理选区", disabled: busy || !saved || !fixed, action: () => {requireCurrent(); if (fixed) ai({document_id: selected.document.document_id, revision_id: selected.revision.revision_id, ...fixed});}},
      {id: "search", label: "查找所选文字", disabled: !plain, action: () => {setSearchRequest({query: plain, nonce: Date.now()}); openSearch();}},
      {id: "edit", label: "编辑", disabled: !!reference || busy, action: () => display(true)},
      {id: "info", label: "文稿信息与来源", action: () => shell.setInspector(true)},
    ], {onDismiss: restore, onError: error => notify(error.message)});
  }
  const contextMenu = useEditorContextMenu({surface: editorSurface, format: selected?.revision.source_format === "fountain" ? "fountain" : selected?.revision.source_format === "markdown" ? "markdown" : "plain", raw: sourceMode,
    disabled: editorLocked || composing || !!reference, saved: !!selected && !busy && content === selected.content, language: readingPreferences.language, notify,
    comment: quote => {setTextSelection(quote); setQuote(quote); setCommentRequest({documentId: selected.document.document_id, revision: selected.revision.revision_id, quote, nonce: Date.now()});},
    ai: quote => ai({document_id: selected.document.document_id, revision_id: selected.revision.revision_id, ...quote}),
    search: query => {setSearchRequest({query, nonce: Date.now()}); openSearch();}, info: () => shell.setInspector(true),
    move: openMove, restoreMove: lastMove?.document_id === selected?.document.document_id ? restoreMove : undefined});
  const final = selected?.document.finalization_ref;
  const readFailure = readError && <div className="manuscript-load-error" role="alert"><p>无法打开稿件：{readError}</p><button disabled={busy} onClick={() => void load(requested.current)}>重新读取稿件</button></div>;
  const searchPanel = showSearch && selected && <ManuscriptSearch source={displayedContent} title={titleFromSource ? "" : selected.document.title} format={reference?.source_format ?? selected.revision.source_format}
    queryRequest={searchRequest}
    visible={searchVisible}
    presentation={shell.searchTarget ? "sidebar" : "inline"} raw={sourceMode} editing={editing && !reference} disabled={busy || composing} selection={textSelection} reader={reader} editor={editorSurface} scroll={scroll} language={readingPreferences.language} highlights={searchHighlights} close={closeSearch} documents={documents} openWorkMatch={openWorkMatch}
    onReveal={() => {if (shell.searchTarget && window.matchMedia("(max-width: 760px)").matches) shell.setNavigationVisible(false);}}/>;
  const directory = (
      <nav className="documents manuscript-directory" aria-label="文稿目录" aria-busy={loading}>
        <div className="directory-heading"><strong>目录</strong><details className="popover-menu"><summary aria-label="目录操作"><Icon name="more"/></summary><div className="menu-panel"><button onClick={() => ai()}>让 AI 整理目录</button><button onClick={() => setReload((value) => value + 1)}>刷新目录</button></div></details><IconButton icon="close" label="收起目录" onClick={() => shell.setNavigationVisible(false)}/></div>
        <div className="directory-scroll">
          {loading && <p className="muted directory-message">正在读取完整目录…</p>}
          {loadError && <div className="directory-message" role="alert"><p>{loadError}</p><button onClick={() => setReload((value) => value + 1)}>重新读取文稿目录</button><button onClick={() => ai()}>让 AI 检查目录</button></div>}
          {groups.map((group, index) => work.kind==="drama"&&group.documents.length===1?<div className="chapter-group episode-entry" key={group.documents[0].document_id}>
            {group.documents.map(doc=><React.Fragment key={doc.document_id}><button {...documentContext(doc)} aria-label={doc.title} className={selected?.document.document_id===doc.document_id?"selected":""} aria-current={selected?.document.document_id===doc.document_id?"page":undefined} onClick={()=>void load(doc,true)} onDoubleClick={()=>shell.pinDocumentTab(doc.document_id)}><Icon name="file" size={13}/><span>{group.title}</span></button>
            {selected?.document.document_id===doc.document_id&&!!scenes.length&&<div className="screenplay-scenes" aria-label="当前分集场次">{scenes.map((scene,sceneIndex)=><button key={scene.from} aria-label={"定位场次 "+(scene.number??sceneIndex+1)+" "+displayedContent.slice(scene.textFrom,scene.textTo).trim()} onClick={()=>jumpScene(scene.from)}><span className="scene-index">{scene.number??sceneIndex+1}</span><span>{displayedContent.slice(scene.textFrom,scene.textTo).trim()}</span></button>)}</div>}</React.Fragment>)}
          </div>:<details key={index} open className="chapter-group"><summary>{group.title}</summary>{group.documents.map((doc) => <button {...documentContext(doc)} key={doc.document_id} className={selected?.document.document_id === doc.document_id ? "selected" : ""} aria-current={selected?.document.document_id === doc.document_id ? "page" : undefined} onClick={() => void load(doc, true)} onDoubleClick={() => shell.pinDocumentTab(doc.document_id)}><Icon name="file" size={13}/><span>{doc.title}</span></button>)}</details>)}
        </div>
        <div className="directory-footer">{documents.length} {work.kind === "drama" ? "集" : "章"}</div>
      </nav>
  );
  useLayoutEffect(() => {
    if (shell.sidebarLayer !== "document" || shell.sidebarPanel !== "directory") return;
    const frame = requestAnimationFrame(() => {
      const current = shell.directoryTarget?.querySelector<HTMLButtonElement>('button[aria-current="page"]');
      if (!current?.checkVisibility()) return;
      current.scrollIntoView({block: "nearest"});
    });
    return () => cancelAnimationFrame(frame);
  }, [selected?.document.document_id, shell.directoryTarget, shell.sidebarLayer, shell.sidebarPanel]);
  return (
    <div ref={layout} className="document-layout">
      {contextMenu.dialogs}
      {renaming && <DocumentRename document={renaming} onClose={() => setRenaming(undefined)} onSaved={() => {setRenaming(undefined); setReload(value => value + 1); notify("文稿已更新。");}}/>}
      {moving && <DocumentMove source={moving} documents={documents} workKind={work.kind as "novel" | "drama"} workId={work.object_id} onClose={() => {setMoving(undefined); editorSurface.current?.focus();}} onMoved={receiveMove}/>}
      {structureOpen && <NovelEditor kind="structure" documents={documents} onClose={() => setStructureOpen(false)} onSaved={() => setReload(value => value + 1)}/>}
      {shell.directoryTarget && createPortal(directory, shell.directoryTarget)}
      {shell.searchTarget && searchPanel && createPortal(searchPanel, shell.searchTarget)}
      <section ref={workspace} style={typography as React.CSSProperties} data-document-theme={readingPreferences.document_theme ?? "system"} className={"manuscript-workspace reading-surface"+(isScreenplay?" screenplay-workspace":"")} aria-label="正文工作区">
        {selected ? <>
              <header className="manuscript-header" aria-label="稿件页头">
                {titleFromSource && <span className="manuscript-source-state">{final ? "已定稿" : "未定稿"}</span>}
                {manuscript && <div className="episode-manuscript-selector"><select aria-label="分集稿件版本" title={reference?.title ?? "作者稿"} value={reference ? manuscriptKey(reference) : "author"} disabled={busy} onChange={(event) => void selectManuscript(event.target.value)}><option value="author">作者稿{manuscript.author_has_content ? "" : "（空）"}</option>{manuscript.references.map((item: any) => <option key={manuscriptKey(item)} value={manuscriptKey(item)} title={item.title}>{item.kind === "submitted" ? "参考稿" : "未提交工作稿"} {item.title}</option>)}</select>{reference && reviewTask && <button onClick={() => reviewTask(reference.task_ref.task_id)}>审阅与提意见</button>}</div>}
                {isScreenplay && <div className="screenplay-controls"><div role="tablist" aria-label="稿件显示"><button role="tab" aria-selected={!sourceMode && !editing} onClick={() => display(false)}>阅读</button>{!reference && <button role="tab" aria-selected={!sourceMode && editing} onClick={() => display(true)}>编辑</button>}</div>{screenplay && <ScreenplayMetadata script={screenplay}/>}</div>}
                <div className="paper-toolbar"><div className="paper-actions">{editing && !reference && <EditorControls surface={editorSurface} context={editorContext} format={selected.revision.source_format === "markdown" ? "markdown" : selected.revision.source_format === "fountain" ? "fountain" : "plain"} disabled={editorLocked || composing} language={readingPreferences.language} notify={notify}/>}<WritingTools key={selected.document.document_id + ":" + selected.revision.revision_id} work={work} documentId={selected.document.document_id} revisionId={selected.revision.revision_id} selection={quote} disabled={busy || !!reference} blocked={composing ? "请完成输入后生成提示词" : content !== selected.content || pending.current ? "请先保存正文，再生成提示词" : undefined}/><ReadingOptions kind={work.kind === "drama" ? "screenplay" : "novel"} composing={composing} zoom={zoom} beforeChange={() => capturePosition()} onPreview={setReadingPreview} onZoom={value => { setZoom(value); viewStorage.setItem(selectionKey + ":zoom", String(value)); }}/><IconButton icon="refresh" label="刷新当前稿件" disabled={busy} onClick={() => void load({ ...selected.document, episode_id: selected.episode_id })}/><IconButton icon="search" label="搜索正文" onClick={() => searchVisible ? closeSearch() : openSearch()}/><IconButton icon="comment" label="原文批注" disabled={!!reference} onClick={() => setAnnotationList(value => value + 1)}/><details className="popover-menu"><summary aria-label="文稿操作" title="文稿操作"><Icon name="more"/></summary><div className="menu-panel">
                  <button disabled={!!reference} onClick={() => display(true)}>编辑</button><button onClick={() => display(false)}>阅读</button>
                  <button onClick={() => display(!reference, true)}>查看原稿</button>
                  <button onClick={() => void desktop.copy(displayedContent).then(() => notify("已复制完整原稿。"), error => notify(error.message))}>复制原稿</button>
                  <button onClick={() => reference && reviewTask ? reviewTask(reference.task_ref.task_id) : ai({document_id: selected.document.document_id, revision_id: selected.revision.revision_id, ...(quote ?? {})})}>让 AI 处理本稿</button>
                  <button disabled={!!reference} onClick={() => {setShowImages(!showImages); shell.setInspector(true);}}>{showImages ? "收起本稿图片" : "本稿图片"}</button>
                  <button disabled={!!reference} onClick={() => shell.setInspector(true)}>比较修订与定稿</button>
                  <button disabled={!!reference} onClick={() => shell.setInspector(true)}>文稿信息</button>
                </div></details></div></div>
              </header>
          <div className="manuscript-stage" ref={scroll} tabIndex={0} aria-label="正文滚动区" onScroll={() => capturePosition()}>
            <section className={"manuscript-paper"+(isScreenplay?" screenplay-paper":"")}>
              {readFailure}
              {!shell.searchTarget && searchPanel}

                {!reference && recovery &&
                  (recovery.pending ||
                    recovery.content !== selected.content) && (
                    <div className="recover">
                      <span>发现本机未保存稿</span>
                      <button
                        onClick={() => {
                          current.current = recovery.base;
                          pending.current = recovery.pending;
                          setEditing(true);
                          void change(recovery.content);
                          setRecovery(null);
                        }}
                      >
                        恢复编辑
                      </button>
                      <button onClick={() => setRecovery(null)}>
                        继续阅读
                      </button>
                    </div>
                  )}
              <div className="manuscript-scroll" onContextMenu={event => {if (editing && !reference && (event.target as Element).closest(".author-editor")) contextMenu.open(event); else if (reader.current?.contains(event.target as Node)) readingMenu(event);}}
                onKeyDown={event => {if (contextKey(event)) {if (editing && !reference) contextMenu.open(event); else readingMenu(event);}}}>
                {!titleInBody && <div className="manuscript-title"><h1>{selected.document.title}</h1><span>{reference ? "只读" : final ? "已定稿" : "未定稿"}</span></div>}
                {reference ? isScreenplay&&!sourceMode?<ScreenplayText ref={reader} className="reference-reader" aria-label="剧本参考稿" text={referenceContent} title={selected.document.title} script={screenplay} onMouseUp={selectQuote} onKeyUp={selectQuote}/>:<ManuscriptText format={(reference?.source_format ?? selected.revision.source_format) === "markdown" && !sourceMode ? "markdown" : "plain"} title={selected.document.title} ref={reader} novel={work.kind === "novel"} className="reference-reader" aria-label="剧本参考稿" text={referenceContent} onMouseUp={selectQuote} onKeyUp={selectQuote}/> : editing ? <AuthorEditor ref={editorSurface} raw={sourceMode} annotations={currentNotes.map(note => note.source_ref)} externalScroll key={selected.document.document_id + ":" + moveRevision} content={content} disabled={editorLocked} format={selected.revision.source_format === "markdown" ? "markdown" : selected.revision.source_format === "fountain" ? "fountain" : "plain"} onContext={updateEditorContext} behavior={{focusParagraph: stableReading.current.focus_paragraph, typewriter: stableReading.current.typewriter_scroll, smartPairs: stableReading.current.smart_pairs}} searchMatches={searchMatches} activeSearchMatch={activeSearchMatch} indent={work.kind === "novel"} screenplay={isScreenplay&&!sourceMode} screenplayTitle={selected.document.title} jumpTo={sceneJump}
                  onChange={(value) => void change(value).catch((error) => notify(error.message))} onSave={() => void save()}
                  onCompositionChange={(active) => { composition.current = active; setComposing(active); }}
                  onSelectionChange={(selection) => { setTextSelection(selection); if (content === selected.content) setQuote(selection); }}/>
                  : isScreenplay&&!sourceMode?<ScreenplayText ref={reader} aria-label="分集剧本" text={content} title={selected.document.title} script={screenplay}
                    onDoubleClick={()=>display(true)} onMouseUp={selectQuote} onKeyUp={selectQuote}/>:<ManuscriptText format={selected.revision.source_format === "markdown" && !sourceMode ? "markdown" : "plain"} title={selected.document.title} novel={work.kind === "novel"} ref={reader} text={content}
                    onDoubleClick={() => display(true)} onMouseUp={selectQuote} onKeyUp={selectQuote}/>}
              </div>
              <footer className="manuscript-footer"><span>{isScreenplay?`${scenes.length} 场`:(reference?.source_format ?? selected.revision.source_format) === "fountain" ? "Fountain" : "Markdown"}</span><span title={statistics ? readingText("reading.statistics", readingPreferences.language, {...statistics}) : readingText("reading.counting_title", readingPreferences.language)}>{statistics ? readingText("reading.count", readingPreferences.language, {count: statistics.count}) : readingText("reading.counting", readingPreferences.language)}</span></footer>
            </section>
          </div>
          {!reference && <ManuscriptAnnotations key={selected.document.document_id} container={workspace} surface={annotationSurface} quote={editing ? textSelection : quote} notes={notes.items} revision={selected.revision.revision_id} documentId={selected.document.document_id} current={content === selected.content} busy={busy} recovery={!!noteRecovery?.pending} listRequest={annotationList}
            saveError={annotationError}
            composeRequest={commentRequest}
            formatting={editing && selected.revision.source_format !== "plain" ? <EditorInlineControls surface={editorSurface} context={editorContext} format={selected.revision.source_format === "fountain" ? "fountain" : "markdown"} disabled={editorLocked || composing} language={readingPreferences.language} notify={notify}/> : undefined}
            save={items => saveNote({document_id: selected.document.document_id, expected: {revision: notes.revision, sha256: notes.sha256}, items, operation_key: crypto.randomUUID()})}
            recover={() => void saveNote(noteRecovery.pending)} ai={source => ai({document_id: selected.document.document_id, revision_id: selected.revision.revision_id, ...source})}/>}
          {shell.inspector && !reference && <div className="manuscript-details" role="dialog" aria-label="文稿详情">
            <div className="inspector-heading"><strong>文稿详情</strong><IconButton icon="close" label="关闭文稿详情" onClick={() => shell.setInspector(false)}/></div>
            <h3>文稿信息</h3><dl className="inspector-metadata"><dt>名称</dt><dd>{selected.document.title}</dd><dt>格式</dt><dd>{selected.revision.source_format}</dd><dt>保存时间</dt><dd>{selected.revision.created_at ? new Date(selected.revision.created_at).toLocaleString() : "未记录"}</dd><dt>状态</dt><dd>{content !== selected.content ? "有未保存修改" : "修订已保存"}</dd></dl>
                <div className="row">
                  <label>
                    比较修订{" "}
                    <select
                      aria-label="比较修订"
                      value=""
                      onChange={(event) => {
                        if (!event.target.value) {
                          setCompare(undefined);
                          return;
                        }
                        void desktop
                          .read("hetu.documents.get", {
                            document_id: selected.document.document_id,
                            revision_id: event.target.value,
                          })
                          .then((r) => setCompare(data(r).content))
                          .catch((e) => notify(e.message));
                      }}
                    >
                      <option value="">选择历史修订</option>
                      {history.map((revision) => (
                        <option
                          key={revision.revision_id}
                          value={revision.revision_id}
                        >
                          {revision.created_at ??
                            revision.revision_id.slice(-8)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {compare !== undefined && (
                  <dialog ref={comparison} className="revision-comparison" style={typography as React.CSSProperties} onClose={() => setCompare(undefined)}>
                    <div className="dialog-heading"><h2>比较修订 {selected.document.title}</h2><IconButton icon="close" label="关闭修订比较" onClick={() => setCompare(undefined)}/></div>
                    <ManuscriptComparison before={compare} after={content} beforeLabel="历史修订" afterLabel="当前内容" title={selected.document.title} format={selected.revision.source_format} kind={work.kind === "drama" ? "screenplay" : "novel"} preferences={preferences}/>
                  </dialog>
                )}
                {content === selected.content && (
                  <AuthorLifecycle
                    key={
                      selected.document.document_id +
                      selected.revision.revision_id +
                      (selected.document.finalization_ref?.finalization_id ??
                        "")
                    }
                    value={selected}
                    notify={notify}
                    ai={() =>
                      ai({
                        document_id: selected.document.document_id,
                        revision_id: selected.revision.revision_id,
                      })
                    }
                    refresh={() => load(selected.document)}
                  />
                )}
                {showImages && (
                  <ArtworkLibrary
                    work={work}
                    notify={notify}
                    ai={ai}
                    subject={{
                      kind: "document",
                      document_id: selected.document.document_id,
                      revision_id: selected.revision.revision_id,
                    }}
                  />
                )}
          </div>}
        </> : busy ? <div className="empty" role="status">正在读取稿件…</div> : readError ? <div className="empty">{readFailure}</div> : <div className="empty"><Icon name="book" size={42}/><h2>{documents.length ? "选择一章或一集" : "从成果开始创作"}</h2><p>让外部 Agent 围绕当前作品准备章节或分集，回来阅读、比较并提出意见。</p><button onClick={() => ai()}>让 AI 处理</button></div>}
      </section>
    </div>
  );
}
