import React from "react";
import type { WorkRef } from "@hetu/plugin-sdk";
import { Icon } from "./icons.tsx";

const defaultCoverAssets = ["cover-river-jade.jpg", "cover-cloud-rose.jpg", "cover-stars-ink.jpg"];
function defaultCover(identity: string) {
  let hash = 0n;
  for (const byte of new TextEncoder().encode(identity)) hash = BigInt.asUintN(64, hash * 31n + BigInt(byte));
  return Number(hash % 3n);
}

/** 创作库使用已有摘要中的封面，不跨作品发起读取。 */
export function WorkCoverPreview({ work, title, author = "", compact = false, preview, presentation, error = "", defaultCovers = defaultCoverAssets }: {
  work: WorkRef; title: string; author?: string; compact?: boolean; preview?: any; presentation?: any; error?: string; defaultCovers?: readonly string[];
}) {
  const image = preview?.media_type === "image/jpeg" && typeof preview.base64 === "string"
    ? "data:image/jpeg;base64," + preview.base64 : undefined;
  const variant = defaultCover(work.workspace_id);
  const placeholder = !image && !error && work.kind === "novel";
  return <div className={"work-cover" + (compact ? " compact-cover" : "") + (placeholder ? " default-cover" : "")} data-cover-variant={placeholder ? variant : undefined} title={error || (image ? title + "的封面" : "默认封面，尚未选用封面")}>
    {image ? <><img src={image} alt={title + "的封面"}/>{!compact && (presentation?.title_overlay || presentation?.author_overlay) && <div className="cover-text"><strong>{presentation.title_overlay}</strong><small>{presentation.author_overlay}</small></div>}</>
      : placeholder ? <><img src={defaultCovers[variant]} alt={`${title}的默认封面，尚未选用封面`}/>{!compact && <div className="cover-text"><strong>{title}</strong>{author && <small>{author}</small>}</div>}</>
      : <><Icon name={work.kind === "novel" ? "book" : work.kind === "video" ? "film" : "file"} size={compact ? 21 : 32}/>{!compact && <><strong>{title}</strong><small>{error ? "封面读取失败" : "尚未选用封面"}</small></>}</>}
  </div>;
}
