import {manuscriptStyles, presentationStyle, type CardPresentation} from "./manuscript-styles.ts";
import type {ManuscriptGroup} from "./manuscript-groups.ts";

export const cardConfigurationEvent = "hetu:configure-card";

/** 阅读、编辑与配置预览复用同一结构；缩略内文不产生第二套原文坐标。 */
export function styleCardPreview(element: HTMLElement, group: ManuscriptGroup, value: CardPresentation = group.attributes) {
  element.dataset.cardLayout = value.cardLayout ?? manuscriptStyles.card.default_layout;
  element.dataset.cardPreview = value.cardPreview ?? manuscriptStyles.card.default_preview;
  element.style.backgroundColor = ""; element.style.backgroundImage = "";
  if (value.cardColor) element.style.backgroundColor = `color-mix(in srgb, ${presentationStyle({color: value.cardColor}).color} 18%, var(--page))`;
  else if (value.cardGradient) {
    const [from, to] = value.cardGradient.split(",");
    element.style.backgroundImage = `linear-gradient(160deg, color-mix(in srgb, ${from} 24%, var(--page)), color-mix(in srgb, ${to} 24%, var(--page)))`;
  } else if (value.cardImage) element.style.backgroundImage = `linear-gradient(color-mix(in srgb, var(--page) 78%, transparent), color-mix(in srgb, var(--page) 78%, transparent)), url("${value.cardImage}")`;
  element.querySelector(":scope > .manuscript-card-art")?.remove();
  const art = document.createElement("span"); art.className = "manuscript-card-art"; art.setAttribute("aria-hidden", "true");
  const mode = value.cardPreview ?? manuscriptStyles.card.default_preview;
  if (mode === "icon") {
    art.textContent = (group.title + group.preview).match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u)?.[0] ?? "▤";
  } else if (mode === "images") {
    for (const source of [...new Set([value.cardImage, ...(group.images ?? [])].filter((image): image is string => !!image))].slice(0, 3)) {
      const image = document.createElement("img"); image.src = source; image.alt = ""; art.append(image);
    }
  } else if (mode !== "none") {
    for (let index = 0; index < (mode === "pages" ? 2 : 1); index++) {
      const page = document.createElement("span"); page.className = "manuscript-card-paper";
      const heading = document.createElement("strong"); heading.textContent = group.title;
      const text = document.createElement("span"); text.textContent = group.preview; page.append(heading, text); art.append(page);
    }
  }
  element.append(art);
}

export function cardPreviewElement(group: ManuscriptGroup, value: CardPresentation = group.attributes) {
  const card = document.createElement("span"), description = document.createElement("span"), title = document.createElement("strong"), preview = document.createElement("span");
  card.className = "manuscript-group-link manuscript-group-card"; description.className = "manuscript-group-description";
  title.textContent = group.title; preview.className = "manuscript-group-preview"; preview.textContent = group.preview;
  description.append(title, preview); card.append(description); styleCardPreview(card, group, value); return card;
}
