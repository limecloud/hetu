import { domainText } from "./strings.ts";

export const canonKinds = [
  { section: "characters", kind: "character", label: "人物", id: "character_id" },
  { section: "factions", kind: "faction", label: "势力", id: "faction_id" },
  { section: "locations", kind: "location", label: "地点", id: "location_id" },
  { section: "timeline", kind: "event", label: "事件", id: "event_id" },
  { section: "world", kind: "world", label: "世界", id: "entry_id" },
  { section: "rules", kind: "rule", label: "规则", id: "rule_id" },
];
export type CanonKind = typeof canonKinds[number];
export type CanonEntry = CanonKind & { value: any };
export function entityName(entry: CanonEntry) {
  return entry.value.name || entry.value.title || entry.value.rationale ||
    (entry.kind === "rule" ? domainText("rule.type." + entry.value.type, "未命名规则") : "未命名" + entry.label);
}
export function canonEntries(blueprint: any): CanonEntry[] {
  return canonKinds.flatMap(kind => (blueprint?.[kind.section] ?? []).map((value: any) => ({ ...kind, value })));
}
export function expectedCanon(snapshot: any) {
  return { blueprint_id: snapshot.blueprint.blueprint_id, revision: snapshot.revision, sha256: snapshot.sha256 };
}
export function newEntity(kind: CanonKind) {
  const id = `${kind.kind === "world" ? "entry" : kind.kind}_${crypto.randomUUID()}`;
  const common = { [kind.id]: id };
  if (kind.kind === "character") return { ...common, name: "", description: "", aliases: [], traits: [], facts: [], archived: false };
  if (kind.kind === "faction") return { ...common, name: "", description: "", relations: [], archived: false };
  if (kind.kind === "location") return { ...common, name: "", description: "", aliases: [], interior_exterior: "unknown", archived: false };
  if (kind.kind === "event") return { ...common, title: "", before_refs: [], after_refs: [], source_refs: [] };
  if (kind.kind === "world") return { ...common, title: "", description: "", source_refs: [] };
  return { ...common, revision: 1, type: "advisory", severity: "warning", exception_policy: "author_review", rationale: "", scope: { packages: ["novel", "drama"], document_ids: [], entity_refs: [] }, parameters: { text: "" } };
}
