import React, {useEffect, useLayoutEffect, useRef, useState} from "react";
import {cardPreviewElement} from "./card-preview.ts";
import {editingText, type EditingKey} from "./editing-labels.ts";
import {manuscriptStyles, presentationStyle, validCardValue, type CardPresentation, type CardLayout, type CardPreview} from "./manuscript-styles.ts";
import type {ManuscriptGroup} from "./manuscript-groups.ts";
import {Icon} from "./icons.tsx";

export interface CardEdit {group: ManuscriptGroup; apply: (value: CardPresentation) => boolean}
function Preview({group, value}: {group: ManuscriptGroup; value: CardPresentation}) {
  const node = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {node.current?.replaceChildren(cardPreviewElement(group, value));}, [group, value]);
  return <div className="card-configuration-preview" ref={node}/>;
}

/** 本地选择的图片规范为有界内嵌字节，取消时不写正文，也不联系远程图片服务。 */
async function backgroundImage(file: File) {
  if (!manuscriptStyles.card.image_types.includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error("image");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas"), scale = Math.min(1, manuscriptStyles.card.max_image_dimension / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d"); if (!context) throw new Error("image");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [.9, .75, .55, .35]) {
      const value = canvas.toDataURL("image/webp", quality);
      if (validCardValue("cardImage", value)) return value;
    }
    throw new Error("image");
  } finally {bitmap.close();}
}

export function CardConfiguration({edit, language, onClose}: {edit: CardEdit; language?: string; onClose: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null), upload = useRef<HTMLInputElement>(null), alive = useRef(true), imageRequest = useRef(0);
  const embedded = typeof window !== "undefined" && window.top !== window;
  const [value, setValue] = useState<CardPresentation>(() => {
    const {cardLayout, cardPreview, cardColor, cardGradient, cardImage} = edit.group.attributes;
    return {cardLayout, cardPreview, cardColor, cardGradient, cardImage};
  }), [background, setBackground] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [kind, setKind] = useState(edit.group.attributes.cardImage ? "image" : edit.group.attributes.cardGradient ? "gradient" : edit.group.attributes.cardColor ? "color" : "none");
  const t = (key: string) => editingText("editing.card_" + key as EditingKey, language);
  const close = () => {if (embedded) dialog.current?.removeAttribute("open"); else dialog.current?.close(); onClose();};
  useEffect(() => {
    alive.current = true;
    // MCP App 运行在宿主 iframe 内时，原生 dialog 顶层会脱离 iframe 的点击坐标。
    // 保留 dialog 语义，改用 iframe 内的 open 状态；桌面窗口继续使用原生模态层。
    if (embedded) dialog.current?.setAttribute("open", ""); else dialog.current?.showModal();
    return () => {alive.current = false; imageRequest.current++;};
  }, [embedded]);
  const layout = value.cardLayout ?? manuscriptStyles.card.default_layout, mode = value.cardPreview ?? manuscriptStyles.card.default_preview;
  const layouts = manuscriptStyles.card.layouts as CardLayout[], previews = manuscriptStyles.card.previews as CardPreview[];
  const chooseLayout = (cardLayout: CardLayout) => setValue(current => ({...current, cardLayout, ...(cardLayout === "compact" && !["page", "icon", "none"].includes(mode) ? {cardPreview: "page" as const} : {})}));
  const step = (delta: number) => chooseLayout(layouts[(layouts.indexOf(layout as CardLayout) + delta + layouts.length) % layouts.length]);
  const patchBackground = (patch: CardPresentation) => {imageRequest.current++; setBusy(false); setError(""); setKind(patch.cardImage ? "image" : patch.cardGradient ? "gradient" : patch.cardColor ? "color" : "none"); setValue(current => ({...current, cardColor: undefined, cardGradient: undefined, cardImage: undefined, ...patch}));};
  const gradients = [["#46a99b", "#d6eda3"], ["#92d4b2", "#e69dba"], ["#c2ced5", "#6e7b92"], ["#d0a37e", "#9ab6b9"], ["#9981d5", "#e6b4ce"], ["#ead3a2", "#ad8650"]];
  return <dialog className="card-configuration" ref={dialog} aria-labelledby="card-configuration-title" onCancel={event => {event.preventDefault(); if (background) setBackground(false); else close();}}
    onKeyDown={event => {if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); if (background) setBackground(false); else close();}}}>
    <header><h2 id="card-configuration-title">{t("configure")}</h2><button type="button" aria-label={t("close")} onClick={close}>×</button></header>
    <div className="card-configuration-body">
      <section className="card-configuration-stage" aria-label={t("actual_preview")}>
        <div className="card-configuration-carousel"><button type="button" className="card-carousel-arrow" aria-label={t("previous_layout")} onClick={() => step(-1)}>←</button>
          <Preview group={edit.group} value={value}/><button type="button" className="card-carousel-arrow" aria-label={t("next_layout")} onClick={() => step(1)}>→</button></div>
        <div className="card-layout-dots" role="group" aria-label={t("layout")}>{layouts.map(item => <button key={item} type="button" aria-label={t("layout_" + item)} aria-pressed={layout === item} title={t("layout_" + item)} onClick={() => chooseLayout(item)}><span/></button>)}</div>
        <button type="button" className="primary card-apply" disabled={busy} onClick={() => {if (edit.apply(value)) close(); else setError(t("source_changed"));}}>{t("apply")}</button>
        {error && <p role="alert">{error}</p>}
      </section>
      <aside className="card-configuration-options">
        <h3>{t("previews")}</h3><div className="card-preview-options" role="group" aria-label={t("previews")}>{previews.filter(item => layout !== "compact" || ["page", "icon", "none"].includes(item)).map(item => <button key={item} type="button" aria-label={t("preview_" + item)} title={t("preview_" + item)} aria-pressed={mode === item} onClick={() => setValue(current => ({...current, cardPreview: item}))}>
          <span className={"card-preview-sample card-preview-sample-" + item} aria-hidden="true">{item === "icon" ? <Icon name="file" size={26}/> : item === "none" ? "⊘" : item === "images" ? <Icon name="image" size={30}/> : <span/>}</span></button>)}</div>
        <h3>{t("custom_background")}</h3><button type="button" className="card-background-trigger" aria-expanded={background} onClick={() => setBackground(!background)}>{t("custom")}<span style={{background: value.cardGradient ? `linear-gradient(135deg, ${value.cardGradient.split(",").join(",")})` : value.cardColor ? presentationStyle({color: value.cardColor}).color : "var(--hover)"}} aria-hidden="true">{kind === "none" ? "+" : kind === "image" ? "▧" : ""}</span></button>
        {background && <section className="card-background-panel" aria-label={t("background")}>
          <div className="card-background-heading"><h3>{t("background")}</h3><button type="button" aria-label={t("close_background")} onClick={() => setBackground(false)}>×</button></div>
          <div className="card-background-tabs" role="group" aria-label={t("background")}>{["none", "color", "gradient", "image"].map((item, index) => <button key={item} type="button" aria-label={t("background_" + item)} title={t("background_" + item)} aria-pressed={kind === item} onClick={() => {
            if (item === "none") patchBackground({}); else if (item === "color") patchBackground({cardColor: value.cardColor ?? "yellow"});
            else if (item === "gradient") patchBackground({cardGradient: value.cardGradient ?? gradients[0].join(",")}); else setKind("image");
          }}><span aria-hidden="true">{["⊘", "□", "▣", "▧"][index]}</span></button>)}</div>
          {kind === "color" && <><div className="card-color-options">{(Object.keys(manuscriptStyles.colors) as (keyof typeof manuscriptStyles.colors)[]).map(color => <button key={color} type="button" aria-label={editingText("editing.color_" + color as EditingKey, language)} aria-pressed={value.cardColor === color} style={{background: presentationStyle({color}).color}} onClick={() => patchBackground({cardColor: color})}/>)}</div><label className="card-color-value">{t("custom_color")}<input type="color" value={value.cardColor?.startsWith("#") ? value.cardColor : "#d6bb77"} onChange={event => patchBackground({cardColor: event.target.value})}/></label></>}
          {kind === "gradient" && <><div className="card-gradient-options">{gradients.map(pair => <button key={pair.join()} type="button" aria-label={t("gradient") + " " + pair.join(" → ")} aria-pressed={value.cardGradient === pair.join(",")} style={{background: `linear-gradient(135deg, ${pair.join(",")})`}} onClick={() => patchBackground({cardGradient: pair.join(",")})}/>)}</div>{["start_color", "end_color"].map((label, index) => <label key={label} className="card-color-value">{t(label)}<input type="color" value={value.cardGradient!.split(",")[index]} onChange={event => {const pair = value.cardGradient!.split(","); pair[index] = event.target.value; patchBackground({cardGradient: pair.join(",")});}}/></label>)}</>}
          {kind === "image" && <><button type="button" className="card-image-upload" disabled={busy} onClick={() => upload.current?.click()}>{busy ? t("loading_image") : t("upload_image")}</button>
            {value.cardImage && <><img className="card-background-image" src={value.cardImage} alt={t("background_image")}/><button type="button" onClick={() => patchBackground({})}>{t("remove_image")}</button></>}</>}
        </section>}
        <input ref={upload} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label={t("upload_image")} onChange={async event => {
          const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
          const request = ++imageRequest.current; setBusy(true); setError("");
          try {const image = await backgroundImage(file); if (alive.current && request === imageRequest.current) {setKind("image"); setValue(current => ({...current, cardImage: image, cardColor: undefined, cardGradient: undefined}));}}
          catch {if (alive.current && request === imageRequest.current) setError(t("invalid_image"));}
          finally {if (alive.current && request === imageRequest.current) setBusy(false);}
        }}/>
      </aside>
    </div>
  </dialog>;
}
