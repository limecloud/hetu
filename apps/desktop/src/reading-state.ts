import type {WorkRef} from "@hetu/plugin-sdk";
export interface SavedReadingPosition {
  identity: string;
  quote?: {byte_start: number; byte_end: number; quote: string};
  inset: number;
  top: number;
}
export interface ReadingState {
  schema_version: 1;
  work_ref: WorkRef;
  selected_document_id?: string;
  positions: Record<string, SavedReadingPosition>;
}
