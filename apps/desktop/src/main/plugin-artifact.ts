import { createHash, randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export interface ArtifactInput {
  suggested_name: string; media_type: string; base64: string; sha256: string;
}
const formats: Record<string, { extension: string; signature: (b: Buffer) => boolean }> = {
  'image/png': { extension: '.png', signature: b => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  'model/gltf-binary': { extension: '.glb', signature: b => b.length >= 20 && b.toString('ascii', 0, 4) === 'glTF' && b.readUInt32LE(4) === 2 && b.readUInt32LE(8) === b.length },
  'application/zip': { extension: '.zip', signature: b => ['504b0304', '504b0506'].includes(b.subarray(0, 4).toString('hex')) },
  'video/webm': { extension: '.webm', signature: b => b.subarray(0, 4).toString('hex') === '1a45dfa3' },
  'video/mp4': { extension: '.mp4', signature: b => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' },
  'audio/wav': { extension: '.wav', signature: b => b.length >= 12 && b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WAVE' && b.readUInt32LE(4)+8===b.length },
  'application/pdf': { extension: '.pdf', signature: b => b.toString('ascii',0,5)==='%PDF-' && b.subarray(-1024).includes(Buffer.from('%%EOF')) },
  'application/epub+zip': { extension: '.epub', signature: b => b.length >= 58 && b.readUInt32LE(0)===0x04034b50 && b.readUInt16LE(8)===0 && b.readUInt16LE(26)===8 && b.readUInt16LE(28)===0 && b.toString('ascii',30,38)==='mimetype' && b.toString('ascii',38,58)==='application/epub+zip' },
  'text/html': { extension: '.html', signature: b => textSignature(b, text => /^<!doctype html[\s>]/i.test(text)||/^<html[\s>]/i.test(text)) },
  'application/xliff+xml': { extension: '.xlf', signature: b => textSignature(b, text => /^(?:<\?xml[^?]*\?>\s*)?<xliff[\s>]/.test(text)) },
};
function textSignature(bytes:Buffer, check:(text:string)=>boolean) {
  try { const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trimStart();return !text.includes('\u0000')&&check(text); } catch { return false; }
}

/** 保存派生文件，不登记素材或认可内容；目标只来自作者文件选择。 */
export async function savePluginArtifact(input: ArtifactInput, context: {
  choose(name: string): Promise<string | undefined>; check(): void;
}) {
  context.check();
  const format = formats[input.media_type];
  if (!format || typeof input.suggested_name !== 'string' || !input.suggested_name.trim() ||
      input.suggested_name.length > 120 || /[\\/\u0000-\u001f]/.test(input.suggested_name) ||
      !input.suggested_name.toLowerCase().endsWith(format.extension) ||
      typeof input.base64 !== 'string' || input.base64.length > Math.ceil(32 * 1024 * 1024 / 3) * 4 ||
      input.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(input.base64) ||
      !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error('派生文件格式、名称或预算无效。');
  const bytes = Buffer.from(input.base64, 'base64');
  if (!bytes.length || bytes.length > 32 * 1024 * 1024 || bytes.toString('base64') !== input.base64 ||
      createHash('sha256').update(bytes).digest('hex') !== input.sha256 || !format.signature(bytes))
    throw new Error('派生文件字节、摘要或类型签名不一致。');
  const target = await context.choose(input.suggested_name);
  if (!target) return { saved: false, cancelled: true };
  context.check();
  const temporary = path.join(path.dirname(target), '.hetu-artifact-' + randomUUID() + '.tmp');
  const file = await open(temporary, 'wx', 0o600);
  let complete = false;
  try {
    await file.writeFile(bytes); await file.sync(); await file.close(); context.check();
    await rename(temporary, target); complete = true;
    return { saved: true, bytes: bytes.length, sha256: input.sha256 };
  } finally {
    if (!complete) { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
  }
}
