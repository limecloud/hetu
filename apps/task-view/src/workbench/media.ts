import { readFixedAssetBytes, type FixedAssetRef } from "@hetu/workbench-ui";
import { object, type RecordValue, type WorkbenchGateway } from "./gateway.ts";

/** 固定文件逐块读取；每块重验权限，完整摘要通过后才创建本地媒体URL。 */
export async function readMedia(gateway: WorkbenchGateway, asset: RecordValue, reference: RecordValue, active: () => boolean) {
  const blob = object(asset.blob), size = Number(blob.size_bytes), mime = String(blob.media_type ?? "");
  if (!Number.isSafeInteger(size) || size < 1 || size > 64 * 1024 * 1024) throw new Error("此文件超出面板预览预算，请让 Agent 准备固定文件交付。");
  if (!/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|webm|ogg))$/.test(mime)) throw new Error("此格式请通过固定交付文件查看。");
  const bytes = await readFixedAssetBytes(asset, reference as FixedAssetRef,
    (action, input) => gateway.read(action, input), active, 64 * 1024 * 1024);
  return { url: URL.createObjectURL(new Blob([bytes], { type: mime })), mime };
}
