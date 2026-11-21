import {open, readdir, realpath, stat} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {FontCatalog} from "@hetu/workbench-ui";

type ReadBytes = (offset: number, length: number) => Promise<Buffer>;

/** 只解析SFNT名称表；不加载字形、不执行字体代码，也不把文件交给视图。 */
export async function readFontFamilies(read: ReadBytes): Promise<string[]> {
  const header = await read(0, 12), offsets = [0];
  if (header.toString("ascii", 0, 4) === "ttcf") {
    const count = header.readUInt32BE(8);
    if (count < 1 || count > 128) throw new Error("字体集合数量超出预算。");
    const table = await read(12, count * 4);
    offsets.splice(0, 1, ...Array.from({length: count}, (_, i) => table.readUInt32BE(i * 4)));
  }
  const families = new Set<string>();
  for (const offset of offsets) {
    const face = await read(offset, 12), signature = face.toString("ascii", 0, 4);
    if (face.readUInt32BE(0) !== 0x00010000 && !["OTTO", "true", "typ1"].includes(signature)) continue;
    const count = face.readUInt16BE(4);
    if (count < 1 || count > 256) throw new Error("字体表数量超出预算。");
    const tables = await read(offset + 12, count * 16);
    for (let i = 0; i < count; i++) {
      if (tables.toString("ascii", i * 16, i * 16 + 4) !== "name") continue;
      const start = tables.readUInt32BE(i * 16 + 8), size = tables.readUInt32BE(i * 16 + 12);
      if (size < 6 || size > 262144) throw new Error("字体名称表超出预算。");
      const names = await read(start, size), records = names.readUInt16BE(2), strings = names.readUInt16BE(4);
      if (records > 4096 || 6 + records * 12 > size || strings > size) throw new Error("字体名称表损坏。");
      for (let j = 0; j < records; j++) {
        const record = 6 + j * 12, platform = names.readUInt16BE(record), id = names.readUInt16BE(record + 6);
        if (![1, 16].includes(id)) continue;
        const length = names.readUInt16BE(record + 8), from = strings + names.readUInt16BE(record + 10);
        if (from + length > size || length > 1024) continue;
        const bytes = names.subarray(from, from + length);
        let value: string;
        if (platform === 0 || platform === 3) {
          if (length % 2) continue;
          value = Buffer.from(bytes).swap16().toString("utf16le");
        } else if (platform === 1 && names.readUInt16BE(record + 2) === 0) value = new TextDecoder("macintosh").decode(bytes);
        else continue;
        const family = value.trim();
        if (family && family.length <= 128 && !/[\x00-\x1f\x7f"\\;{}<>]|[\uD800-\uDFFF]/u.test(family) && !family.startsWith(".")) families.add(family);
      }
    }
  }
  return [...families];
}

async function fontDirectories() {
  if (process.platform === "darwin") {
    const assets = "/System/Library/AssetsV2", entries = await readdir(assets).catch(() => [] as string[]);
    return ["/System/Library/Fonts", "/Library/Fonts", path.join(os.homedir(), "Library/Fonts"), ...entries.filter(name => /^com_apple_MobileAsset_Font\d+$/.test(name)).map(name => path.join(assets, name))];
  }
  if (process.platform === "win32") return [path.join(process.env.WINDIR ?? "C:/Windows", "Fonts"), ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Microsoft/Windows/Fonts")] : [])];
  return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(os.homedir(), ".fonts"), path.join(os.homedir(), ".local/share/fonts")];
}

let cached: {time: number; value: FontCatalog} | undefined, pending: Promise<FontCatalog> | undefined;
export function localFontCatalog(refresh = false): Promise<FontCatalog> {
  if (pending) return pending;
  if (!refresh && cached && Date.now() - cached.time < 300000) return Promise.resolve(cached.value);
  pending = fontDirectories().then(scanFontDirectories).then(value => {cached = {time: Date.now(), value}; return value;}).finally(() => {pending = undefined;});
  return pending;
}

export async function scanFontDirectories(directories: string[]): Promise<FontCatalog> {
  const files: string[] = [], seenFiles = new Set<string>(), visited = new Set<string>(), families = new Set<string>(), deadline = Date.now() + 10000;
  let skipped = 0, complete = true;
  async function walk(directory: string, depth = 0) {
    if (depth > 12 || files.length >= 5000 || visited.size >= 2000 || Date.now() >= deadline) {complete = false; return;}
    let canonical: string;
    try {canonical = await realpath(directory);} catch (error: any) {if (error.code !== "ENOENT") {complete = false; skipped++;} return;}
    if (visited.has(canonical)) return; visited.add(canonical);
    let entries;
    try {entries = await readdir(canonical, {withFileTypes: true});} catch {complete = false; skipped++; return;}
    for (const entry of entries) {
      if (files.length >= 5000 || Date.now() >= deadline) {complete = false; break;}
      const file = path.join(canonical, entry.name);
      const info = entry.isSymbolicLink() ? await stat(file).catch(() => undefined) : entry;
      if (!info) {skipped++; complete = false; continue;}
      if (info.isDirectory()) await walk(file, depth + 1);
      else if (info.isFile() && /\.(ttf|otf|ttc|otc)$/i.test(entry.name)) {
        const canonical = await realpath(file).catch(() => undefined);
        if (!canonical) {skipped++; complete = false; continue;}
        if (!seenFiles.has(canonical)) {seenFiles.add(canonical); files.push(canonical);}
      } else if (info.isFile() && /\.dfont$/i.test(entry.name)) {skipped++; complete = false;}
    }
  }
  for (const directory of directories) await walk(directory);
  for (let i = 0; i < files.length; i += 4) {
    if (Date.now() >= deadline) {skipped += files.length - i; complete = false; break;}
    const results = await Promise.allSettled(files.slice(i, i + 4).map(async file => {
      const handle = await open(file, "r"); let budget = 0;
      try {
        return await readFontFamilies(async (offset, length) => {
          if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || length > 262144 || (budget += length) > 1048576) throw new Error("字体读取超过预算。");
          const bytes = Buffer.alloc(length), {bytesRead} = await handle.read(bytes, 0, length, offset);
          if (bytesRead !== length) throw new Error("字体名称表不完整。");
          return bytes;
        });
      } finally {await handle.close();}
    }));
    for (const result of results) if (result.status === "fulfilled") result.value.forEach(value => families.add(value)); else {skipped++; complete = false;}
  }
  return {families: [...families].sort((a, b) => a.localeCompare(b, "zh-CN")), scanned: files.length, skipped, complete};
}
