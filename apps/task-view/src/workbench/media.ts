import { object, type RecordValue, type WorkbenchGateway } from "./gateway.ts";

/** 固定文件逐块读取；每块重验权限，完整摘要通过后才创建本地媒体URL。 */
export async function readMedia(gateway: WorkbenchGateway, asset: RecordValue, reference: RecordValue, active: () => boolean) {
  const blob = object(asset.blob), size = Number(blob.size_bytes), mime = String(blob.media_type ?? "");
  if (!Number.isSafeInteger(size) || size < 1 || size > 64 * 1024 * 1024) throw new Error("此文件超出面板预览预算，请让 Agent 准备固定文件交付。");
  if (!/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|webm|ogg))$/.test(mime)) throw new Error("此格式请通过固定交付文件查看。");
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    if (!active()) throw new Error("预览已结束。");
    // MCP同时传输结构结果和文本投影，原字节预算须给base64及双份信封留余量。
    const chunk = await gateway.read("hetu.assets.read_blob", { asset_ref: reference, offset, length: Math.min(12000, size - offset) });
    if (!active()) throw new Error("预览已结束。");
    const returned = object(chunk.asset_ref);
    if (chunk.offset !== offset || chunk.total_bytes !== size || chunk.blob_sha256 !== blob.sha256 || returned.asset_id !== reference.asset_id || returned.revision !== reference.revision || returned.sha256 !== reference.sha256) throw new Error("媒体身份或分块摘要不一致。");
    if (typeof chunk.base64 !== "string") throw new Error("媒体分块未返回原字节，请按传输预算重新读取。");
    const raw = Uint8Array.from(atob(chunk.base64), value => value.charCodeAt(0));
    if (raw.length < 1 || chunk.size_bytes !== raw.length || offset + raw.length > size) throw new Error("媒体分块范围无效。");
    bytes.set(raw, offset); offset += raw.length;
    if (chunk.next_offset !== (offset < size ? offset : null)) throw new Error("媒体分块不连续。");
  }
  if (!globalThis.crypto?.subtle) throw new Error("宿主未提供文件摘要验证能力，请通过固定交付查看。");
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  if (digest !== blob.sha256 || !active()) throw new Error("媒体文件摘要不一致或预览已结束。");
  // 摘要完成后再重验一次原授权，避免撤权期间完成的旧响应继续呈现。
  await gateway.read("hetu.assets.get", { asset_id: reference.asset_id, revision: reference.revision });
  if (!active()) throw new Error("预览已结束。");
  return { url: URL.createObjectURL(new Blob([bytes], { type: mime })), mime };
}
