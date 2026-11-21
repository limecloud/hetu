import path from "node:path";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {WorkRef} from "@hetu/plugin-sdk";
import type {ReadingState, SavedReadingPosition} from "../reading-state.ts";
import {RecoveryStore} from "./recovery.ts";
import {withLibraryLock} from "./library-lock.ts";

function documentId(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
}
function validPosition(value: SavedReadingPosition) {
  if (!value || typeof value.identity !== "string" || value.identity.length > 8192 || !Number.isFinite(value.top) || value.top < 0 || value.top > 1e9 || !Number.isFinite(value.inset) || Math.abs(value.inset) > 1e6) return false;
  try {
    const identity = JSON.parse(value.identity);
    if (!Array.isArray(identity) || identity.length !== 2 || !documentId(identity[0]) || typeof identity[1] !== "string") return false;
  } catch {return false;}
  const quote = value.quote;
  return !quote || (Number.isSafeInteger(quote.byte_start) && Number.isSafeInteger(quote.byte_end) && quote.byte_start >= 0 && quote.byte_end > quote.byte_start
    && typeof quote.quote === "string" && (quote.quote === "\r\n" || [...quote.quote].length === 1 && !/[\uD800-\uDFFF]/u.test(quote.quote)) && Buffer.byteLength(quote.quote) === quote.byte_end - quote.byte_start);
}

/** 作者视图的持久位置；没有正文、偏好写入或Agent授权能力。 */
export class ReadingStateStore {
  private directory: string;
  private recovery: RecoveryStore;
  constructor(directory: string, recovery: RecoveryStore) {this.directory = directory; this.recovery = recovery;}
  private file(work: WorkRef) {
    return path.join(this.directory, createHash("sha256").update(JSON.stringify([work.workspace_id, work.kind, work.object_id])).digest("hex") + ".json");
  }
  async get(work: WorkRef): Promise<ReadingState> {
    const value = await this.recovery.read(this.file(work)) as ReadingState | null;
    if (!value) return {schema_version: 1, work_ref: work, positions: {}};
    if (value.schema_version !== 1 || !isDeepStrictEqual(value.work_ref, work) || value.selected_document_id !== undefined && !documentId(value.selected_document_id)
      || !value.positions || typeof value.positions !== "object" || Array.isArray(value.positions) || Object.keys(value.positions).length > 100
      || Object.entries(value.positions).some(([key, position]) => key !== position?.identity || !validPosition(position))) throw new Error("本机阅读位置无法核对，请保留记录后检查。");
    return value;
  }
  async save(work: WorkRef, patch: {selected_document_id?: string; position?: SavedReadingPosition}) {
    if (!patch || Object.keys(patch).some(key => !["selected_document_id", "position"].includes(key))
      || patch.selected_document_id !== undefined && !documentId(patch.selected_document_id) || patch.position !== undefined && !validPosition(patch.position)) throw new Error("阅读位置格式无效。");
    return withLibraryLock(this.file(work), async () => {
      const value = await this.get(work);
      if (patch.selected_document_id !== undefined) value.selected_document_id = patch.selected_document_id;
      if (patch.position) {
        const position = patch.position;
        delete value.positions[position.identity];
        value.positions[position.identity] = {identity: position.identity, top: position.top, inset: position.inset, ...(position.quote ? {quote: {byte_start: position.quote.byte_start, byte_end: position.quote.byte_end, quote: position.quote.quote}} : {})};
        for (const key of Object.keys(value.positions).slice(0, -100)) delete value.positions[key];
      }
      await this.recovery.write(this.file(work), value, 1024 * 1024);
      return {saved: true};
    });
  }
}
