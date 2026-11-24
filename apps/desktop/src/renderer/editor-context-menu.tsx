import React, {useRef, useState} from "react";
import {createPortal} from "react-dom";
import {useContextMenu, contextText, type ContextMenuItem, type ContextKey} from "@hetu/workbench-ui";
import {manuscriptStyles} from "@hetu/workbench-ui/manuscript-styles";
import {CardConfiguration, type CardEdit} from "@hetu/workbench-ui/card-configuration";
import type {AuthorEditorHandle} from "./editor.tsx";
import type {EditorContextTarget} from "./editor-context-target.ts";
import type {TextCommand, TextFormat, ScreenplayElement} from "./text-commands.ts";
import {editingText, type EditingKey} from "./editing-labels.ts";
import {desktop} from "./bridge.ts";
import {contextShortcut} from "./text-context-menus.tsx";
import {clipboardMarkdown} from "./clipboard-markdown.ts";

export function useEditorContextMenu(props: {
  surface: React.RefObject<AuthorEditorHandle>; format: TextFormat; raw: boolean; disabled: boolean; saved: boolean; language?: string;
  notify(message: string): void; comment(quote: EditorContextTarget["quote"]): void; ai(quote: EditorContextTarget["quote"]): void;
  search(text: string): void; info(): void;
  move?(target: EditorContextTarget): void | Promise<void>;
  restoreMove?: () => void | Promise<void>;
}) {
  const show = useContextMenu(), [card, setCard] = useState<CardEdit>();
  const colorInput = useRef<HTMLInputElement>(null), colorTarget = useRef<EditorContextTarget>();
  const t = (key: string) => contextText("context." + key as ContextKey, props.language);
  const e = (key: string) => editingText("editing." + key as EditingKey, props.language);
  function open(event: React.MouseEvent | React.KeyboardEvent) {
    let target: EditorContextTarget | undefined;
    try {target = props.surface.current?.contextMenu(event.type === "contextmenu" ? {x: (event as React.MouseEvent).clientX, y: (event as React.MouseEvent).clientY, target: event.target} : undefined);}
    catch (error) {event.preventDefault(); props.notify((error as Error).message); return;}
    if (!target) return;
    const unavailable = props.disabled || target.readOnly;
    const action = (id: string, label: string, run: () => void | Promise<void>, disabled = false, extra: {shortcut?: string; checked?: boolean; danger?: boolean} = {}): ContextMenuItem => ({id, label, disabled, action: run, ...extra, ...(extra.shortcut ? {shortcut: extra.shortcut.replace(/^(⇧)?⌘(.+)$/, (_all, shift, key) => contextShortcut(key, !!shift))} : {})});
    const command = (id: TextCommand): ContextMenuItem => action(id, e(id), () => {target.command(id);}, unavailable, {checked: target.context.activeCommands?.includes(id)});
    const separator = (id: string): ContextMenuItem => ({id, separator: true});
    const change = (patch: Parameters<EditorContextTarget["blockPresentation"]>[0]) => {target.blockPresentation(patch);};
    const items: ContextMenuItem[] = [
      action("undo", e("undo"), () => {target.command("undo");}, unavailable || !target.context.canUndo, {shortcut: "⌘Z"}),
      action("redo", e("redo"), () => {target.command("redo");}, unavailable || !target.context.canRedo, {shortcut: "⇧⌘Z"}), separator("history"),
      action("cut", t("cut"), async () => {await desktop.copy(target.text); target.cut();}, unavailable || !target.text, {shortcut: "⌘X"}),
      action("copy", t("copy"), () => desktop.copy(target.text), !target.text, {shortcut: "⌘C"}),
      {id: "copy-as", label: t("copy_as"), children: [action("copy-plain", t("plain"), () => desktop.copy(target.text)), action("copy-source", props.format === "markdown" ? t("markdown") : t("raw"), () => desktop.copy(target.sourceText))]},
      action("paste", t("paste"), async () => {const value = await desktop.paste("rich"); target.insert(props.format === "markdown" && !props.raw ? clipboardMarkdown(value) : value.text);}, unavailable, {shortcut: "⌘V"}),
      action("paste-plain", t("paste_plain"), async () => {const text = await desktop.paste(); target.insert(text);}, unavailable, {shortcut: "⇧⌘V"}), separator("clipboard"),
    ];
    if (props.format !== "plain" && !props.raw) {
      const formats = props.format === "markdown" ? (["heading1", "heading2", "heading3", "heading4", "heading5", "heading6", "paragraph", "quote", "bullet_list", "ordered_list", "task_list", "separator"] as TextCommand[]).map(command)
        : (["scene", "action", "character", "dialogue", "parenthetical", "transition"] as ScreenplayElement[]).map(element => action(element, e(element), () => {target.requireCurrent(); props.surface.current?.element(element);}, unavailable, {checked: target.context.element === element}));
      const inline = (props.format === "fountain" ? ["bold", "italic", "underline"] : ["bold", "italic", "strike", "code"]) as TextCommand[];
      items.push({id: "format", label: t("format"), children: [...formats, separator("inline"), ...inline.map(command)]});
      if (props.format === "markdown") {
        const presentation = target.context.presentation ?? {};
        items.push({id: "alignment", label: t("alignment"), children: (["left", "center", "right", "justify"] as const).map(alignment => action(alignment, e("align_" + alignment), () => change({alignment}), unavailable, {checked: (presentation.alignment ?? "left") === alignment}))},
          {id: "indent", label: t("indent"), children: [action("indent-more", t("indent_more"), () => {target.indent(true);}, unavailable), action("indent-less", t("indent_less"), () => {target.indent(false);}, unavailable)]},
          {id: "color", label: t("color"), children: [action("default", e("default_color"), () => {target.presentation({color: undefined});}, unavailable),
            ...Object.keys(manuscriptStyles.colors).map(color => action(color, e("color_" + color), () => {target.presentation({color});}, unavailable, {checked: presentation.color === color})),
            action("custom", e("custom_color"), () => {target.requireCurrent(); colorTarget.current = target; colorInput.current!.value = presentation.color?.startsWith("#") ? presentation.color : "#202020"; colorInput.current!.showPicker();}, unavailable)]},
          {id: "font", label: t("font"), children: [action("default", e("reset_font"), () => {target.presentation({font: undefined});}, unavailable),
            ...(Object.keys(manuscriptStyles.fonts) as (keyof typeof manuscriptStyles.fonts)[]).map(font => action(font, e("font_" + font), () => {target.presentation({font});}, unavailable, {checked: presentation.font === font}))]},
          separator("block-style"),
          action("group", t("group"), () => change({block: "page"}), unavailable, {shortcut: "⌘G"}),
          action("card", e("block_card"), () => change({block: "card"}), unavailable),
        );
        if (presentation.block === "page" || presentation.block === "card") items.push(action("ungroup", t("ungroup"), () => change({block: undefined}), unavailable, {shortcut: "⇧⌘G"}));
        if (target.captureCard()) items.push(action("configure-card", t("configure_card"), () => setCard(target.captureCard()), unavailable));
      }
      items.push(separator("formatting"));
    }
    items.push(action("above", t("above"), () => {target.editBlock("above");}, unavailable),
      action("below", t("below"), () => {target.editBlock("below");}, unavailable),
      {id: "order", label: t("order"), children: [
        action("move-up", t("move_up"), () => {target.editBlock("up");}, unavailable || !target.canMoveUp),
        action("move-down", t("move_down"), () => {target.editBlock("down");}, unavailable || !target.canMoveDown),
      ]},
      {id: "sort", label: t("sort"), children: [
        action("sort-ascending", t("sort_ascending"), () => {target.sortBlocks("ascending", props.language);}, unavailable || !target.canSort),
        action("sort-descending", t("sort_descending"), () => {target.sortBlocks("descending", props.language);}, unavailable || !target.canSort),
      ]},
      ...(props.move ? [action("move-to", t("move_to"), () => props.move!(target), unavailable || !target.blockQuote.quote)] : []),
      ...(props.restoreMove ? [action("restore-move", t("restore_move"), () => props.restoreMove!(), unavailable || !props.saved)] : []),
      action("duplicate", t("duplicate"), () => {target.editBlock("duplicate");}, unavailable),
      action("select-block", t("select_block"), target.selectBlock), action("select-all", t("select_all"), target.selectAll, false, {shortcut: "⌘A"}),
      action("delete", target.empty ? t("delete_block") : t("delete"), () => {target.cut();}, unavailable, {danger: true}), separator("review"),
      action("comment", t("comment"), () => {target.requireCurrent(); props.comment(target.quote);}, !props.saved || props.disabled || !target.quote.quote),
      action("ai", t("ai"), () => {target.requireCurrent(); props.ai(target.quote);}, !props.saved || props.disabled || !target.quote.quote),
      action("search", t("search"), () => {target.requireCurrent(); props.search(target.text);}, !target.text),
      action("info", t("info"), props.info),
    );
    show(event, t("editor"), items, {onDismiss: () => props.surface.current?.focus(), onError: error => props.notify(error.message)});
  }
  return {open, dialogs: <>
    <input ref={colorInput} type="color" aria-label={e("custom_color")} className="context-color-input" onChange={event => {
      try {colorTarget.current?.presentation({color: event.target.value});} catch (error) {props.notify((error as Error).message);}
    }}/>
    {card && createPortal(<CardConfiguration edit={card} language={props.language} onClose={() => {setCard(undefined); props.surface.current?.focus();}}/>, document.body)}
  </>};
}
