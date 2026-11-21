import React, {useRef, useState} from "react";
import type {AuthorEditorHandle, EditorContext} from "./editor.tsx";
import type {TextCommand, TextFormat, ScreenplayElement} from "./text-commands.ts";
import {desktop} from "./bridge.ts";
import {editingText, type EditingKey as Key} from "./editing-labels.ts";
import {PresentationControls, GroupingControls} from "./presentation-controls.tsx";
export {editingText} from "./editing-labels.ts";

function CommandButton({value, context, disabled, language, run, children}: {value: TextCommand; context: EditorContext; disabled: boolean; language?: string; run: (value: TextCommand) => void; children?: React.ReactNode}) {
  const label = editingText("editing." + value as Key, language);
  return <button type="button" aria-label={label} title={label} aria-pressed={["undo", "redo", "separator", "previous_scene", "next_scene"].includes(value) ? undefined : context.activeCommands?.includes(value)}
    data-command={value} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => run(value)}>{children ?? label}</button>;
}

export function EditorInlineControls({surface, context, format, disabled, language, notify}: {surface: React.RefObject<AuthorEditorHandle>; context: EditorContext; format: TextFormat; disabled: boolean; language?: string; notify: (message: string) => void}) {
  if (format === "plain") return null;
  const run = (value: TextCommand) => {try {surface.current?.command(value);} catch (error) {notify((error as Error).message);}};
  const button = (value: TextCommand, children: React.ReactNode) => <CommandButton key={value} value={value} context={context} disabled={disabled} language={language} run={run}>{children}</CommandButton>;
  return <div className="selection-format-controls" role="group" aria-label={editingText("editing.title", language)}>
    {button("bold", <strong>B</strong>)}{button("italic", <em>I</em>)}{format === "fountain" ? button("underline", <u>U</u>) : <>{button("strike", <s>S</s>)}{button("code", "</>")}</>}
  </div>;
}

export function EditorControls({surface, context, format, disabled, language, notify}: {
  surface: React.RefObject<AuthorEditorHandle>; context: EditorContext; format: TextFormat; disabled: boolean; language?: string; notify: (message: string) => void;
}) {
  const t = (key: Key) => editingText(key, language), [pending, setPending] = useState(false), working = useRef(false);
  const command = (value: TextCommand) => { try { surface.current?.command(value); } catch (error) { notify((error as Error).message); } };
  const button = (value: TextCommand, unavailable = false, glyph?: React.ReactNode) => <CommandButton key={value} value={value} context={context} disabled={disabled || pending || unavailable} language={language} run={command}>{glyph}</CommandButton>;
  async function paste() {
    const insert = surface.current?.captureInsertion();
    if (!insert || working.current) return;
    working.current = true; setPending(true);
    try { const text = await desktop.paste(); if (!insert(text)) notify(t("editing.target_changed")); }
    catch (error) { notify((error as Error).message); }
    finally { working.current = false; setPending(false); }
  }
  const elements: ScreenplayElement[] = ["scene", "action", "character", "dialogue", "parenthetical", "transition"];
  return <div className="editor-controls">
    {format === "fountain" && <select aria-label={t("editing.element")} title={t("editing.element")} value={elements.includes(context.element as ScreenplayElement) ? context.element : ""} disabled={disabled || pending}
      onChange={event => { try { surface.current?.element(event.target.value as ScreenplayElement); } catch (error) { notify((error as Error).message); } }}>
      <option value="" disabled>{t("editing.raw_element")}</option>{elements.map(value => <option key={value} value={value}>{t("editing." + value as Key)}</option>)}
    </select>}
    <details className="popover-menu editor-format-menu"><summary className="editor-format-trigger" aria-label={t("editing.title")} title={t("editing.title")}>Aa</summary><div className="menu-panel editor-command-menu">
      <div className="editor-format-heading"><strong>{t("editing.format")}</strong><div>{button("undo", !context.canUndo, "↶")}{button("redo", !context.canRedo, "↷")}</div></div>
      {format === "markdown" && <div className="editor-style-grid" role="group" aria-label={t("editing.format")}>
        <span className="editor-group-label">{t("editing.headings")}</span>{(["heading1", "heading2", "heading3"] as const).map(value => button(value, false, t("editing.style_" + value as Key)))}
        <span className="editor-group-label">{t("editing.content")}</span>{(["heading4", "paragraph", "quote"] as const).map(value => button(value, false, t("editing.style_" + value as Key)))}
      </div>}
      {format === "markdown" && <GroupingControls surface={surface} context={context} disabled={disabled || pending} language={language} notify={notify}/>}
      {format !== "plain" && <div className="editor-inline-group" role="group" aria-label={t("editing.title")}>
        {button("bold", false, <strong>B</strong>)}{button("italic", false, <em>I</em>)}{format === "fountain" ? button("underline", false, <u>U</u>) : <>{button("strike", false, <s>S</s>)}{button("code", false, "</>")}</>}
      </div>}
      {format === "markdown" && <div className="editor-inline-group editor-list-group" role="group" aria-label={t("editing.lists")}>{button("task_list", false, "☑")}{button("bullet_list", false, "• ≡")}{button("ordered_list", false, "1. ≡")}</div>}
      {format === "markdown" && <PresentationControls surface={surface} context={context} disabled={disabled || pending} language={language} notify={notify}/>}
      {format === "fountain" ? <div className="editor-scene-commands">{button("previous_scene", !context.previousScene)}{button("next_scene", !context.nextScene)}</div>
        : format === "markdown" && <><details className="editor-headings"><summary>{t("editing.headings")}</summary>{([5, 6] as const).map(level => button("heading" + level as TextCommand))}</details>{button("separator")}</>}
      <button type="button" disabled={disabled || pending} onMouseDown={event => event.preventDefault()} onClick={() => void paste()}>{t("editing.paste_plain")}</button>
      <details className="editor-symbols"><summary>{t("editing.symbols")}</summary><div>{["“”", "‘’", "（）", "【】", "《》", "……", "——"].map(symbol => <button key={symbol} type="button" disabled={disabled || pending} aria-label={t("editing.insert") + " " + symbol} onMouseDown={event => event.preventDefault()} onClick={() => surface.current?.insert(symbol)}>{symbol}</button>)}</div></details>
    </div></details>
  </div>;
}
