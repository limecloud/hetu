import { viewStorage } from "./view-storage.ts";
import { ManuscriptText } from "@hetu/workbench-ui";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SurfaceContext } from "./contributions.tsx";
import { desktop, data } from "./bridge.ts";
import { AuthorEditor, selectedSource } from "./editor.tsx";
import { AuthorLifecycle } from "./author-review.tsx";
import { ArtworkLibrary } from "./artwork.tsx";
import { usePreferences } from "./preferences.tsx";
import { readWorkContent, type DocumentGroup } from "./work-content.ts";
import { Icon, IconButton, useWorkbench } from "./workbench.tsx";
import { manuscriptKey, readEpisodeReference } from "./episode-manuscript.ts";

export function Documents({ work, notify, ai, reviewTask }: SurfaceContext) {
  const preferences = usePreferences();
  const shell = useWorkbench();
  const [showSearch, setShowSearch] = useState(false);
  const [search, setSearch] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const [floatingDirectory, setFloatingDirectory] = useState(false);
  const [floatingInspector, setFloatingInspector] = useState(false);
  const previousLayout = useRef<{ width: number; floatingDirectory: boolean }>();
  const selectionKey = "hetu-document:" + work.workspace_id + ":" + work.object_id;
  const positionKey = selectionKey + ":positions";
  const positions = useRef<Record<string, number>>(JSON.parse(viewStorage.getItem(positionKey) ?? "{}"));
  function rememberPosition(id: string, top: number) {
    positions.current[id] = top;
    viewStorage.setItem(positionKey, JSON.stringify(positions.current));
  }
  const [composing, setComposing] = useState(false);
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
    [showImages, setShowImages] = useState(false),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState<any[]>([]),
    [compare, setCompare] = useState<string>(),
    [recovery, setRecovery] = useState<any>(),
    [notes, setNotes] = useState<any>({ revision: 0, sha256: null, items: [] }),
    [quote, setQuote] = useState<ReturnType<typeof selectedSource>>(null),
    [comment, setComment] = useState(""),
    [noteRecovery, setNoteRecovery] = useState<any>();
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
    setLoading(true);
    setLoadError("");
    readWorkContent(work)
      .then((result) => {
        if (active) {
          setDocuments(result.documents);
          setGroups(result.groups);
          const previous = viewStorage.getItem(selectionKey);
          const document = result.documents.find((item) => item.document_id === previous) ?? result.groups[0]?.documents[0] ?? result.documents[0];
          if (document) void load(document);
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
  async function load(document: any, selectedByAuthor = false) {
    if (current.current && text.current !== current.current.content) {
      notify("请先保存当前修改。");
      return;
    }
    const epoch = ++generation.current;
    requested.current = document;
    setReadError("");
    if (selectedByAuthor && floatingDirectory) shell.setDirectoryVisible(false);
    setBusy(true);
    try {
      const result = data(
        await desktop.read("hetu.documents.get", {
          document_id: document.document_id,
        }),
      );
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
      setManuscript(episode?.manuscript);
      setReference(preferred);
      setReferenceContent(preferredContent);
      viewStorage.setItem(selectionKey, document.document_id);
      setContent(result.content);
      setEditing(true);
      setShowImages(false);
      setCompare(undefined);
      setQuote(null);
      setComment("");
      setNotes(data(annotations));
      setNoteRecovery(noteBuffer);
      pending.current = undefined;
      setRecovery(saved);
      setHistory(data(historyResult).revisions ?? []);
      if (authorOperation?.status === "pending" || authorOperation?.status === "blocked") shell.setInspector(true);
    } catch (error) {
      if (epoch === generation.current) {
        setReadError((error as Error).message);
        notify((error as Error).message);
      }
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }
  async function selectManuscript(key: string) {
    if (current.current && text.current !== current.current.content) {
      notify("请先保存当前修改。");
      return;
    }
    if (key === "author") { setReference(undefined); setQuote(null); return; }
    const next = manuscript?.references.find((item: any) => manuscriptKey(item) === key);
    if (!next) return;
    const epoch = ++generation.current;
    setBusy(true);
    try {
      const value = await readEpisodeReference(selected.episode_id, next);
      if (epoch !== generation.current) return;
      setReference(next); setReferenceContent(value); setQuote(null);
    } catch (error) { notify((error as Error).message); }
    finally { if (epoch === generation.current) setBusy(false); }
  }
  async function change(value: string) {
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
    if (!current.current || composition.current || reference) return;
    setBusy(true);
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
      current.current = { ...result, content: fixed.content };
      setSelected({ ...current.current, episode_id: selected.episode_id });
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
      setBusy(false);
    }
  }
  async function saveNote(fixed: any) {
    setBusy(true);
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
      setComment("");
      notify("已记录固定原文批注。");
    } catch (e) {
      notify((e as Error).message + " 原批注输入已保留，可恢复。");
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
  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(() => {
      if (scroll.current) scroll.current.scrollTop = positions.current[selected.document.document_id] ?? 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [selected?.document.document_id]);
  useEffect(() => {
    shell.setDocumentTools(selected ? {
      title: selected.document.title,
      readOnly: !!reference,
      dirty: !reference && (content !== selected.content || !!pending.current),
      busy: busy || composing,
      save: () => void save(),
      ai: () => reference && reviewTask ? reviewTask(reference.task_ref.task_id) : ai({ document_id: selected.document.document_id, revision_id: selected.revision.revision_id, ...(quote ?? {}) }),
    } : undefined);
  }, [selected, content, busy, composing, quote, recovery, reference]);
  useEffect(() => () => shell.setDocumentTools(undefined), []);
  useEffect(() => { if (quote || noteRecovery?.pending) shell.setInspector(true); }, [quote, noteRecovery]);
  useLayoutEffect(() => {
    if (!layout.current) return;
    const measure = (width: number) => {
      const inspectorFloats = width < 680 + 280 + 36 + (shell.directoryVisible ? 210 : 0);
      const directoryFloats = width < 680 + 210 + 36 + (shell.inspector && !inspectorFloats ? 280 : 0);
      setFloatingInspector(inspectorFloats);
      setFloatingDirectory(directoryFloats);
      const previous = previousLayout.current;
      // 首次窄窗或缩窄至浮层时收起；加载和面板切换保留作者刚打开的目录。
      if (directoryFloats && (!previous || (width < previous.width && !previous.floatingDirectory))) shell.setDirectoryVisible(false);
      previousLayout.current = { width, floatingDirectory: directoryFloats };
    };
    measure(layout.current.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(layout.current);
    return () => observer.disconnect();
  }, [shell.inspector, shell.directoryVisible]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      if (floatingDirectory && shell.directoryVisible) shell.setDirectoryVisible(false);
      else if (shell.inspector) shell.setInspector(false);
      else if (showSearch) { setShowSearch(false); setSearch(""); }
      else if (shell.focus) shell.setFocus(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [floatingDirectory, shell.directoryVisible, shell.inspector, showSearch, shell.focus]);
  const displayedContent = reference ? referenceContent : content;
  const { count, words, characters } = useMemo(() => {
    let characters = 0;
    for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(displayedContent)) characters++;
    return { count: displayedContent.match(/\p{Script=Han}/gu)?.length ?? 0,
      words: displayedContent.match(/[A-Za-z]+(?:[’-][A-Za-z]+)*/g)?.length ?? 0, characters };
  }, [displayedContent]);
  const final = selected?.document.finalization_ref;
  const readFailure = readError && <div className="manuscript-load-error" role="alert"><p>无法打开稿件：{readError}</p><button disabled={busy} onClick={() => void load(requested.current)}>重新读取稿件</button></div>;
  return (
    <div ref={layout} className={"document-layout" + (!shell.directoryVisible || shell.focus ? " directory-hidden" : "") + (floatingDirectory ? " directory-floating" : "") + (floatingInspector ? " inspector-floating" : "")}>
      {floatingDirectory && shell.directoryVisible && !shell.focus && <button className="pane-backdrop" aria-label="关闭目录浮层" onClick={() => shell.setDirectoryVisible(false)}/>}
      <nav className="documents manuscript-directory" aria-label="文稿目录">
        <div className="directory-heading"><strong>{work.kind === "drama" ? "分集目录" : "卷章目录"}</strong><details className="popover-menu"><summary aria-label="目录操作"><Icon name="more"/></summary><div className="menu-panel"><button onClick={() => ai()}>让 AI 整理目录</button><button onClick={() => setReload((value) => value + 1)}>刷新目录</button></div></details><IconButton icon="close" label="收起目录" onClick={() => shell.setDirectoryVisible(false)}/></div>
        <div className="directory-scroll">
          {loading && <p className="muted directory-message">正在读取完整目录…</p>}
          {loadError && <div className="directory-message" role="alert"><p>{loadError}</p><button onClick={() => setReload((value) => value + 1)}>重新读取文稿目录</button><button onClick={() => ai()}>让 AI 检查目录</button></div>}
          {groups.map((group, index) => <details key={index} open className="chapter-group"><summary>{group.title}</summary>{group.documents.map((doc) => <button key={doc.document_id} className={selected?.document.document_id === doc.document_id ? "selected" : ""} aria-current={selected?.document.document_id === doc.document_id ? "page" : undefined} onClick={() => void load(doc, true)}><Icon name="file" size={13}/><span>{doc.title}</span></button>)}</details>)}
        </div>
        <div className="directory-footer">{documents.length} {work.kind === "drama" ? "集" : "章"}</div>
      </nav>
      <section className="manuscript-workspace" aria-label="正文工作区">
        {selected ? <>
          <div className="manuscript-stage">
            <section className="manuscript-paper">
              {readFailure}
              <div className="paper-toolbar"><div className="paper-actions"><IconButton icon="refresh" label="刷新当前稿件" disabled={busy} onClick={() => void load({ ...selected.document, episode_id: selected.episode_id })}/><IconButton icon="search" label="搜索正文" disabled={!!reference} onClick={() => setShowSearch(!showSearch)}/><IconButton icon="comment" label="原文批注" disabled={!!reference} onClick={() => shell.setInspector(!shell.inspector)}/><details className="popover-menu"><summary aria-label="文稿操作" title="文稿操作"><Icon name="more"/></summary><div className="menu-panel">
                <button disabled={!!reference} onClick={() => setEditing(true)}>编辑</button><button onClick={() => setEditing(false)}>阅读</button>
                <button onClick={() => reference && reviewTask ? reviewTask(reference.task_ref.task_id) : ai({ document_id: selected.document.document_id, revision_id: selected.revision.revision_id, ...(quote ?? {}) })}>让 AI 处理本稿</button>
                <button onClick={() => { setShowImages(!showImages); shell.setInspector(true); }}>{showImages ? "收起本稿图片" : "本稿图片"}</button>
                <button onClick={() => shell.setInspector(true)}>比较修订与定稿</button>
              </div></details></div></div>
              {showSearch && !reference && <div className="document-search"><Icon name="search"/><input autoFocus aria-label="搜索正文内容" placeholder="搜索当前正文" value={search} onChange={(event) => { setSearch(event.target.value); setEditing(true); }}/><span>{search ? content.split(search).length - 1 : 0} 处</span><IconButton icon="close" label="关闭正文搜索" onClick={() => { setShowSearch(false); setSearch(""); }}/></div>}
              {manuscript && <div className="episode-manuscript-selector"><label>稿件版本<select aria-label="分集稿件版本" value={reference ? manuscriptKey(reference) : "author"} disabled={busy} onChange={(event) => void selectManuscript(event.target.value)}><option value="author">作者稿{manuscript.author_has_content ? "" : "（空）"}</option>{manuscript.references.map((item: any) => <option key={manuscriptKey(item)} value={manuscriptKey(item)}>{item.kind === "submitted" ? "参考稿" : "未提交工作稿"} {item.title}</option>)}</select></label>{reference && reviewTask && <button onClick={() => reviewTask(reference.task_ref.task_id)}>审阅与提意见</button>}</div>}
              <div className="manuscript-title"><h1>{selected.document.title}</h1><span>{reference ? reference.kind === "submitted" ? "参考稿" : "未提交工作稿" : final ? "已定稿" : "未定稿"}</span></div>
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
              <div className="manuscript-scroll" ref={scroll} onScroll={() => { if (scroll.current && !editing) rememberPosition(selected.document.document_id, scroll.current.scrollTop); }}>
                {reference ? <ManuscriptText className="reference-reader" aria-label="剧本参考稿" text={referenceContent}/> : editing ? <AuthorEditor key={selected.document.document_id} content={content} disabled={busy} search={search} indent={work.kind === "novel"}
                  scrollTop={positions.current[selected.document.document_id]} onScroll={(top) => rememberPosition(selected.document.document_id, top)}
                  onChange={(value) => void change(value).catch((error) => notify(error.message))} onSave={() => void save()}
                  onCompositionChange={(active) => { composition.current = active; setComposing(active); }}
                  onSelectionChange={(selection) => { if (content === selected.content) setQuote(selection); }}/>
                  : <ManuscriptText novel={work.kind === "novel"} ref={reader} text={content}
                    onDoubleClick={() => setEditing(true)} onMouseUp={() => reader.current && setQuote(selectedSource(reader.current, selected.content))}
                    onKeyUp={() => reader.current && setQuote(selectedSource(reader.current, selected.content))}/>}
              </div>
              <footer className="manuscript-footer"><span>{(reference?.source_format ?? selected.revision.source_format) === "fountain" ? "Fountain" : "Markdown"}</span><span title={`汉字 ${count}、英文词 ${words}、总字符 ${characters}`}>{count} 字</span></footer>
            </section>
          </div>
          {shell.inspector && !reference && <aside className="manuscript-inspector" aria-label="检查器">
            <div className="inspector-heading"><strong>检查器</strong><IconButton icon="close" label="关闭检查器" onClick={() => shell.setInspector(false)}/></div>
            <h3>文稿信息</h3><dl className="inspector-metadata"><dt>名称</dt><dd>{selected.document.title}</dd><dt>格式</dt><dd>{selected.revision.source_format}</dd><dt>保存时间</dt><dd>{selected.revision.created_at ? new Date(selected.revision.created_at).toLocaleString() : "未记录"}</dd><dt>状态</dt><dd>{content !== selected.content ? "有未保存修改" : "修订已保存"}</dd></dl>
            <h3>批注与修订</h3>{!quote && !notes.items.length && <p className="muted">选中文字添加批注。</p>}
                {noteRecovery?.pending && (
                  <div className="recover">
                    <span>发现未确认的批注操作</span>
                    <button
                      disabled={busy}
                      onClick={() => void saveNote(noteRecovery.pending)}
                    >
                      恢复原批注
                    </button>
                  </div>
                )}
                {quote && !noteRecovery?.pending && (
                  <section className="feedback-box">
                    <blockquote>{quote.quote}</blockquote>
                    <label>
                      对这段的意见
                      <textarea
                        aria-label="原文批注意见"
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                      />
                    </label>
                    <button
                      disabled={busy || !comment.trim()}
                      onClick={() =>
                        void (async () => {
                          const fixed = {
                            document_id: selected.document.document_id,
                            expected: {
                              revision: notes.revision,
                              sha256: notes.sha256,
                            },
                            items: [
                              ...notes.items,
                              {
                                id: "note_" + crypto.randomUUID(),
                                text: comment.trim(),
                                source_ref: {
                                  document_id: selected.document.document_id,
                                  revision_id: selected.revision.revision_id,
                                  ...quote,
                                },
                                resolved: false,
                              },
                            ],
                            operation_key: crypto.randomUUID(),
                          };
                          await saveNote(fixed);
                        })()
                      }
                    >
                      保存批注
                    </button>
                  </section>
                )}
                {notes.items.length > 0 && (
                  <details>
                    <summary>原文批注 {notes.items.length}</summary>
                    {notes.items.map((note: any) => (
                      <div className="feedback-box" key={note.id}>
                        <blockquote>{note.source_ref.quote}</blockquote>
                        <p>{note.text}</p>
                        <span className="muted">
                          {note.source_ref.revision_id ===
                          selected.revision.revision_id
                            ? "当前修订"
                            : "历史修订，保留原位置"}
                        </span>
                      </div>
                    ))}
                  </details>
                )}
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
                  <dialog ref={comparison} className="revision-comparison" onClose={() => setCompare(undefined)}>
                    <div className="dialog-heading"><h2>比较修订 {selected.document.title}</h2><IconButton icon="close" label="关闭修订比较" onClick={() => setCompare(undefined)}/></div>
                    <div className="comparison-columns">
                    <section>
                      <h3>历史修订</h3>
                      <pre>{compare}</pre>
                    </section>
                    <section>
                      <h3>当前内容</h3>
                      <pre>{content}</pre>
                    </section>
                    </div>
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
          </aside>}
        </> : busy ? <div className="empty" role="status">正在读取稿件…</div> : readError ? <div className="empty">{readFailure}</div> : <div className="empty"><Icon name="book" size={42}/><h2>{documents.length ? "选择一章或一集" : "从成果开始创作"}</h2><p>让外部 Agent 围绕当前作品准备章节或分集，回来阅读、比较并提出意见。</p><button onClick={() => ai()}>让 AI 处理</button></div>}
      </section>
    </div>
  );
}
