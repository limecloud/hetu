import React, {useEffect, useState} from "react";
import {createPortal} from "react-dom";
import {manuscriptStyles, presentationStyle, type InlinePresentation, type BlockPresentation, type ManuscriptFont} from "@hetu/workbench-ui/manuscript-styles";
import type {AuthorEditorHandle, EditorContext} from "./editor.tsx";
import {editingText, type EditingKey} from "./editing-labels.ts";
import {CardConfiguration, type CardEdit} from "@hetu/workbench-ui/card-configuration";
import {cardConfigurationEvent} from "@hetu/workbench-ui/card-preview";

interface PresentationControlProps {
  surface: React.RefObject<AuthorEditorHandle>; context: EditorContext; disabled: boolean; language?: string; notify: (message: string) => void;
}
function blockAction(props: PresentationControlProps, patch: BlockPresentation) {
  try {if (!props.surface.current?.blockPresentation(patch)) props.notify(editingText("editing.presentation_unavailable", props.language));}
  catch (error) {props.notify((error as Error).message);}
}
export function GroupingControls(props: PresentationControlProps) {
  const {context, disabled, language} = props, value = context.presentation ?? {};
  const [card, setCard] = useState<CardEdit>();
  const t = (key: string) => editingText("editing." + key as EditingKey, language);
  useEffect(() => {
    if (disabled) return;
    const open = (event: Event) => {
      const edit = props.surface.current?.captureCard((event as CustomEvent<{from: number}>).detail.from, event.target);
      if (edit) setCard(edit);
    };
    document.addEventListener(cardConfigurationEvent, open); return () => document.removeEventListener(cardConfigurationEvent, open);
  }, [disabled, props.surface]);
  return <>
    <span className="editor-presentation-label">{t("grouping")}</span>
    <div className="editor-block-decorations" role="group" aria-label={t("grouping")}>{(["page", "card"] as const).map(block => <button key={block} type="button" disabled={disabled}
      aria-label={t("block_" + block)} aria-pressed={value.block === block} onMouseDown={event => event.preventDefault()}
      onClick={() => blockAction(props, {block})}><span className="manuscript-group-icon" aria-hidden="true">▤</span>{t("block_" + block)}</button>)}</div>
    {(value.block === "page" || value.block === "card") && <button type="button" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => blockAction(props, {block: undefined})}>{t("ungroup")}</button>}
    {value.block === "card" && <button type="button" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => {const edit = props.surface.current?.captureCard(); if (edit) setCard(edit);}}>{t("card_configure")}</button>}
    {card && createPortal(<CardConfiguration edit={card} language={language} onClose={() => {setCard(undefined); props.surface.current?.focus();}}/>, document.body)}
  </>;
}
export function PresentationControls(props: PresentationControlProps) {
  const {surface, context, disabled, language, notify} = props;
  const t = (key: string) => editingText("editing." + key as EditingKey, language), value = context.presentation ?? {}, mixed = context.mixedPresentation ?? [];
  const apply = (patch: InlinePresentation) => {try {if (!surface.current?.presentation(patch)) notify(t("presentation_unavailable"));} catch (error) {notify((error as Error).message);}};
  const applyBlock = (patch: BlockPresentation) => blockAction(props, patch);
  const color = (name?: keyof typeof manuscriptStyles.colors) => {
    const label = t(name ? "color_" + name : "default_color"), selected = !mixed.includes("color") && value.color === name;
    return <button key={name ?? "default"} type="button" className="editor-color-swatch" aria-label={label} title={label} aria-pressed={selected} disabled={disabled}
      style={{"--swatch-color": name ? presentationStyle({color: name}).color : "var(--ink)"} as React.CSSProperties}
      onMouseDown={event => event.preventDefault()} onClick={() => apply({color: name})}><span aria-hidden="true"/></button>;
  };
  const fonts = Object.keys(manuscriptStyles.fonts) as ManuscriptFont[], samples = ["Aa", "Ss", "00", "Rr"];
  return <>
    <div className="editor-inline-group editor-alignment" role="group" aria-label={t("alignment")}>{(["left", "center", "right", "justify"] as const).map(alignment => <button key={alignment} type="button" disabled={disabled}
      aria-label={t("align_" + alignment)} title={t("align_" + alignment)} aria-pressed={!mixed.includes("alignment") && (value.alignment ?? "left") === alignment}
      onMouseDown={event => event.preventDefault()} onClick={() => applyBlock({alignment})}>
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">{[3, 7, 11, 15].map((y, index) => {
        const short = index % 2 === 1 && alignment !== "justify", x = short ? alignment === "center" ? 4 : alignment === "right" ? 7 : 1 : 1;
        return <path key={y} d={`M${x} ${y}h${short ? 10 : 16}`}/>;
      })}</svg>
    </button>)}</div>
    <span className="editor-presentation-label">{t("decorations")}</span>
    <div className="editor-block-decorations" role="group" aria-label={t("decorations")}>{(["focus", "panel"] as const).map(block => <button key={block} type="button" disabled={disabled}
      aria-label={t("block_" + block)} title={t("block_" + block)} aria-pressed={value.block === block} onMouseDown={event => event.preventDefault()}
      onClick={() => applyBlock({block: value.block === block ? undefined : block})}><span className={"editor-block-sample editor-block-sample-" + block} aria-hidden="true"/>{t("block_" + block)}</button>)}</div>
    <span className="editor-presentation-label">{t("colors")}</span>
    <div className="editor-colors" role="group" aria-label={t("colors")}>{color()}{(Object.keys(manuscriptStyles.colors) as (keyof typeof manuscriptStyles.colors)[]).map(name => color(name))}
      <input type="color" aria-label={t("custom_color")} title={t("custom_color")} disabled={disabled} value={value.color?.startsWith("#") ? value.color : "#202020"}
        onChange={event => apply({color: event.target.value})}/>
    </div>
    <div className="editor-presentation-label"><span>{t("fonts")}</span><button type="button" title={t("reset_font")} aria-label={t("reset_font")} disabled={disabled || !value.font && !mixed.includes("font")}
      onMouseDown={event => event.preventDefault()} onClick={() => apply({font: undefined})}>↶</button></div>
    <div className="editor-fonts" role="group" aria-label={t("fonts")}>{fonts.map((font, index) => <button key={font} type="button" disabled={disabled} aria-label={t("font_" + font)} title={t("font_" + font)}
      aria-pressed={!mixed.includes("font") && value.font === font} style={{fontFamily: manuscriptStyles.fonts[font].css}}
      onMouseDown={event => event.preventDefault()} onClick={() => apply({font})}><span aria-hidden="true">{samples[index]}</span><small>{t("font_sample_" + font)}</small></button>)}</div>
  </>;
}
