import React, { useEffect, useRef, useState } from "react";
import { desktop } from "./bridge.ts";

/** 只接收固定素材身份，原文件路径与Rust句柄不进入renderer。 */
export function MediaPreview({
  asset,
  sha256,
  onPosition,
}: {
  asset: any;
  sha256: string;
  onPosition?: (seconds: number) => void;
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [reload, setReload] = useState(0);
  const element = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    let active = true,
      address = "";
    setUrl("");
    setError("");
    setReady(false);
    desktop
      .media("open", {
        asset_id: asset.asset_id,
        revision: asset.revision,
        sha256,
      })
      .then((value) => {
        address = value.url;
        if (active) setUrl(address);
        else void desktop.media("release", { url: address }).catch(() => {});
      })
      .catch((e) => {
        if (active)
          setError(
            "无法预览此素材。" +
              String(e.message).replace(
                /^Error invoking remote method '[^']+': Error:\s*/,
                "",
              ),
          );
      });
    return () => {
      active = false;
      const player = element.current;
      if (player) {
        player.pause();
        player.removeAttribute("src");
        player.load();
      }
      if (address)
        void desktop.media("release", { url: address }).catch(() => {});
    };
  }, [asset.asset_id, asset.revision, sha256, reload]);
  const image = asset.blob.media_type.startsWith("image/"),
    audio = asset.kind === "music";
  function failed() {
    setError("无法预览此素材。文件可能不完整，或当前系统不支持其编码。");
  }
  return (
    <section
      className="media-preview"
      aria-label="固定素材预览"
      aria-busy={!ready && !error}
    >
      {!ready && !error && <p role="status">正在载入素材预览……</p>}
      {error ? (
        <div>
          <p role="alert">{error}</p>
          <button onClick={() => setReload((n) => n + 1)}>重新加载预览</button>
        </div>
      ) : (
        url &&
        (image ? (
          <img
            src={url}
            alt={asset.title}
            onLoad={() => setReady(true)}
            onError={failed}
          />
        ) : audio ? (
          <audio
            ref={(value) => {
              element.current = value;
            }}
            src={url}
            aria-label={asset.title}
            controls
            onTimeUpdate={event => onPosition?.(event.currentTarget.currentTime)}
            preload="metadata"
            onLoadedMetadata={() => setReady(true)}
            onError={failed}
          />
        ) : (
          <video
            ref={(value) => {
              element.current = value;
            }}
            src={url}
            aria-label={asset.title}
            controls
            onTimeUpdate={event => onPosition?.(event.currentTarget.currentTime)}
            playsInline
            preload="metadata"
            onLoadedMetadata={() => setReady(true)}
            onError={failed}
          />
        ))
      )}
    </section>
  );
}
