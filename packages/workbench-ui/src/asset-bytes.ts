export type FixedAssetRef = { asset_id: string; revision: number; sha256: string };
type Read = (action: string, input: Record<string, unknown>) => Promise<any>;

/** 原Owner逐块读取、连续范围及完整摘要通过后，才把字节交给浏览器。 */
export async function readFixedAssetBytes(asset: any, reference: FixedAssetRef, read: Read, active: () => boolean, limit: number) {
  const blob = asset.blob, size = Number(blob?.size_bytes);
  if (!Number.isSafeInteger(size) || size < 1 || size > limit) throw new Error("文件超出预览预算，请通过固定交付查看。");
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    if (!active()) throw new Error("预览已结束。");
    // 为MCP的Base64、文本与结构化双份信封保留传输余量。
    const chunk = await read("hetu.assets.read_blob", { asset_ref: reference, offset, length: Math.min(12000, size - offset) });
    if (!active()) throw new Error("预览已结束。");
    const ref = chunk.asset_ref;
    if (chunk.offset !== offset || chunk.total_bytes !== size || chunk.blob_sha256 !== blob.sha256 || ref?.asset_id !== reference.asset_id || ref?.revision !== reference.revision || ref?.sha256 !== reference.sha256) throw new Error("媒体身份或分块摘要不一致。");
    if (typeof chunk.base64 !== "string") throw new Error("未收到文件原字节，请重新读取。");
    const raw = Uint8Array.from(atob(chunk.base64), value => value.charCodeAt(0));
    if (!raw.length || chunk.size_bytes !== raw.length || offset + raw.length > size) throw new Error("媒体分块范围无效。");
    bytes.set(raw, offset); offset += raw.length;
    if (chunk.next_offset !== (offset < size ? offset : null)) throw new Error("媒体分块不连续。");
  }
  if (!globalThis.crypto?.subtle) throw new Error("宿主未提供文件摘要验证能力，请通过固定交付查看。");
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  if (sha !== blob.sha256 || !active()) throw new Error("媒体摘要不一致或预览已结束。");
  const verified = await read("hetu.assets.get", {asset_id: reference.asset_id, revision: reference.revision});
  if (!active()) throw new Error("预览已结束。");
  if (verified.sha256 !== reference.sha256 || verified.asset?.blob?.sha256 !== blob.sha256) throw new Error("固定素材已变化。");
  return bytes;
}
