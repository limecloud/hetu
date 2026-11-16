import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { desktop, data } from "./bridge.ts";
import { IconButton } from "./workbench.tsx";
import { domainText } from "./strings.ts";
import { canonEntries, canonKinds, entityName, expectedCanon, newEntity, type CanonKind } from "./canon-model.ts";
import "./canon-editors.css";

const lines = (value: string) => [...new Set(value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
const CanonClose = createContext({ close: () => {}, held: false });
function CancelCanon({ label = "取消" }: { label?: string }) { const { close, held } = useContext(CanonClose); return <button disabled={held} onClick={close}>{label}</button>; }
function CanonSheet({ title, className = "", dirty = false, held = false, protect = false, onClose, children }: { title: string; className?: string; dirty?: boolean; held?: boolean; protect?: boolean; onClose: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), [discarding, setDiscarding] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { if (protect) void desktop.dirty(dirty || held); return () => { if (protect) void desktop.dirty(false); }; }, [protect, dirty, held]);
  function close() { if (held) return; if (dirty) setDiscarding(true); else dialog.current?.close(); }
  return <CanonClose.Provider value={{ close, held }}><dialog ref={dialog} className={"canon-sheet " + className} aria-label={title} onClose={e => { e.stopPropagation(); onClose(); }} onCancel={e => { e.preventDefault(); e.stopPropagation(); close(); }}>
    <header><h2>{title}</h2><IconButton icon="close" label="关闭" disabled={held} onClick={close}/></header>
    {discarding && <div className="recover"><p>修改尚未保存。</p><button onClick={() => setDiscarding(false)}>继续编辑</button><button onClick={() => dialog.current?.close()}>放弃修改并关闭</button></div>}
    {children}
  </dialog></CanonClose.Provider>;
}
function Sources({ value }: { value?: any[] }) { return value?.length ? <section className="canon-editor-section"><h3>原文依据</h3>{value.map((s, i) => <blockquote key={i}>{s.quote || "已有固定原文依据"}</blockquote>)}</section> : null; }
function Choices({ title, choices, value, onChange, disabled }: { title: string; choices: { id: string; name: string }[]; value: string[]; onChange: (value: string[]) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  return <fieldset className="canon-choices" disabled={disabled}><legend>{title}</legend>{choices.length > 8 && <input aria-label={"筛选" + title} value={query} placeholder="筛选" onChange={e => setQuery(e.target.value)}/>}
    <div>{choices.filter(c => c.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(c => <label key={c.id}><input type="checkbox" checked={value.includes(c.id)} onChange={e => onChange(e.target.checked ? [...value, c.id] : value.filter(v => v !== c.id))}/>{c.name}</label>)}{!choices.length && <span className="muted">没有可选条目</span>}</div>
  </fieldset>;
}
function Reference({ title, choices, value, onChange, optional = false }: { title: string; choices: { id: string; name: string }[]; value: string; onChange: (value: string) => void; optional?: boolean }) {
  return <label>{title}<select aria-label={title} value={value} onChange={e => onChange(e.target.value)}><option value="">{optional ? "无" : "请选择"}</option>{choices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>;
}
function options(values: string[], prefix: string) { return values.map(value => <option key={value} value={value}>{domainText(prefix + value, value)}</option>); }

export function CanonEditor({ snapshot, category, entity, ai, onClose, onSaved }: { snapshot: any; category: CanonKind; entity?: any; ai: (object?: any) => void; onClose: () => void; onSaved: () => void }) {
  const [original] = useState(() => structuredClone(entity ?? newEntity(category))), [draft, setDraft] = useState(original),
    [text, setText] = useState(() => Object.fromEntries(["aliases", "traits"].map(k => [k, (original[k] ?? []).join("\n")]).concat(["terms", "exceptions"].map(k => [k, (original.parameters?.[k] ?? []).join("\n")])))),
    [fact, setFact] = useState<any>(), [busy, setBusy] = useState(false), [error, setError] = useState(""), [journal, setJournal] = useState(snapshot.journal), [documents, setDocuments] = useState<any[]>([]);
  const entries = canonEntries(snapshot.blueprint), id = draft[category.id], held = busy || journal?.status === "pending";
  const choices = (kind?: string, excluding = id) => entries.filter(e => (!kind || e.kind === kind) && e.value[e.id] !== excluding).map(e => ({ id: e.value[e.id], name: entityName(e) + (e.value.archived ? "（已归档）" : "") }));
  function value() {
    const result = structuredClone(draft);
    if (["character", "location"].includes(category.kind)) result.aliases = lines(text.aliases);
    if (category.kind === "character") result.traits = lines(text.traits);
    if (category.kind === "location" && !result.parent_ref) delete result.parent_ref;
    if (category.kind === "rule" && result.type === "forbidden_term") { result.parameters.terms = lines(text.terms); result.parameters.exceptions = lines(text.exceptions); }
    return result;
  }
  const output = value(), dirty = JSON.stringify(output) !== JSON.stringify(original) || fact !== undefined;
  const titleKey = category.kind === "rule" ? "rationale" : ["character", "faction", "location"].includes(category.kind) ? "name" : "title";
  let valid = category.kind === "rule" || !!draft[titleKey]?.trim();
  if (category.kind === "event" && draft.time_anchor) valid = valid && !!draft.time_anchor.calendar.trim() && Number.isSafeInteger(draft.time_anchor.tick);
  if (category.kind === "rule") {
    const p = output.parameters;
    valid = !!output.scope.packages.length && (output.type === "required_reference" ? !!p.entity_types.length : output.type === "fact_equals" ? !!p.predicates.length : output.type === "event_precedes" ? !!p.before_event_id && !!p.after_event_id && p.before_event_id !== p.after_event_id : output.type === "forbidden_term" ? !!p.terms.length : output.type === "world_constraint" ? !!p.location_ref && !!p.forbidden_capability.trim() : !!p.text.trim());
  }
  const update = (key: string, value: any) => setDraft({ ...draft, [key]: value });
  const parameter = (key: string, value: any) => update("parameters", { ...draft.parameters, [key]: value });
  async function run(save: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await save(); await desktop.canon("acknowledge"); onSaved(); onClose(); }
    catch (e) { setError((e as Error).message); try { setJournal((await desktop.canon("get")).journal); } catch { /* 原错误与输入保留。 */ } }
    finally { setBusy(false); }
  }
  useEffect(() => { if (category.kind !== "rule") return; let active = true; void (async () => {
    const all: any[] = []; let cursor;
    do { const page = data(await desktop.read("hetu.documents.list", { limit: 100, ...(cursor ? { cursor } : {}) })); all.push(...page.documents); cursor = page.next_cursor; } while (cursor && active);
    if (active) setDocuments(all);
  })().catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
  return <CanonSheet title={(entity ? "编辑" : "新增") + category.label + "设定"} dirty={dirty} held={held} protect onClose={onClose}>
    <div className="canon-editor-ai"><button disabled={held} onClick={() => ai({ entity_ref: id, blueprint_revision: snapshot.revision })}>让 AI 处理</button></div>
    {error && <p role="alert">{error}</p>}
    {journal?.status === "pending" && <div className="recover"><p>原设定操作尚未确认。</p><button disabled={busy} onClick={() => void run(() => desktop.canon("recover"))}>恢复原设定操作</button></div>}
    <fieldset className="canon-editor-content" disabled={held}>
      {category.kind !== "rule" && <label>名称<input value={draft[titleKey]} maxLength={200} onChange={e => update(titleKey, e.target.value)}/></label>}
      {["character", "faction", "location", "world"].includes(category.kind) && <label>描述<textarea aria-label="描述" rows={3} maxLength={10000} value={draft.description} onChange={e => update("description", e.target.value)}/></label>}
      {["character", "location"].includes(category.kind) && <label>别名<textarea aria-label="别名" rows={2} value={text.aliases} placeholder="每行一个" onChange={e => setText({ ...text, aliases: e.target.value })}/></label>}
      {category.kind === "character" && <section className="canon-editor-section"><h3>人物事实</h3><label>特征<textarea aria-label="特征" rows={2} value={text.traits} placeholder="每行一个" onChange={e => setText({ ...text, traits: e.target.value })}/></label>
        {draft.facts.map((item: any, index: number) => <div className="canon-edit-row" key={item.fact_id}><span><strong>{domainText("fact.predicate." + item.predicate, item.predicate)}</strong> {item.predicate === "primary_faction" ? choices("faction").find(c => c.id === item.value)?.name : item.predicate === "life_state" ? domainText("fact.life." + item.value, item.value) : String(item.value)}</span><button onClick={() => setFact(item)}>编辑事实</button><IconButton icon="close" label="移除事实" onClick={() => update("facts", draft.facts.filter((_: any, i: number) => i !== index))}/></div>)}
        <button disabled={!choices("event").length} onClick={() => setFact(null)}>添加事实</button>{!choices("event").length && <p className="muted">请先建立事件，作为事实生效的时间依据。</p>}
      </section>}
      {category.kind === "faction" && <section className="canon-editor-section"><h3>势力关系</h3>{draft.relations.map((item: any, index: number) => <div className="canon-edit-row" key={index}>
        <Reference title="关联势力" choices={choices("faction")} value={item.target_ref} onChange={v => update("relations", draft.relations.map((r: any, i: number) => i === index ? { ...r, target_ref: v } : r))}/>
        <label>关系<select aria-label="关系" value={item.type} onChange={e => update("relations", draft.relations.map((r: any, i: number) => i === index ? { ...r, type: e.target.value } : r))}>{options(["ally", "enemy", "neutral", "subordinate"], "faction.relation.")}</select></label>
        <IconButton icon="close" label="移除关系" onClick={() => update("relations", draft.relations.filter((_: any, i: number) => i !== index))}/></div>)}
        <button disabled={!choices("faction").length} onClick={() => update("relations", [...draft.relations, { target_ref: choices("faction")[0].id, type: "neutral" }])}>添加关系</button></section>}
      {category.kind === "location" && <><Reference title="所属地点" choices={choices("location")} optional value={draft.parent_ref ?? ""} onChange={v => update("parent_ref", v)}/><label>内外景<select aria-label="内外景" value={draft.interior_exterior} onChange={e => update("interior_exterior", e.target.value)}>{options(["interior", "exterior", "mixed", "unknown"], "location.")}</select></label></>}
      {category.kind === "event" && <><Choices title={domainText("timeline.before", "前置关系")} choices={choices("event")} value={draft.before_refs} onChange={v => update("before_refs", v)}/><Choices title={domainText("timeline.after", "后置关系")} choices={choices("event")} value={draft.after_refs} onChange={v => update("after_refs", v)}/>
        <label className="canon-checkbox"><input type="checkbox" checked={!!draft.time_anchor} onChange={e => { if (e.target.checked) update("time_anchor", { calendar: "", tick: 0 }); else { const next = { ...draft }; delete next.time_anchor; setDraft(next); } }}/>设置时间锚点</label>
        {draft.time_anchor && <div className="canon-edit-row"><label>历法<input maxLength={100} value={draft.time_anchor.calendar} onChange={e => update("time_anchor", { ...draft.time_anchor, calendar: e.target.value })}/></label><label>时间位置<input type="number" value={draft.time_anchor.tick} onChange={e => update("time_anchor", { ...draft.time_anchor, tick: e.target.value === "" ? "" : Number(e.target.value) })}/></label></div>}</>}
      {category.kind === "rule" && <>
        <label>规则类型<select aria-label="规则类型" value={draft.type} onChange={e => {
          const type = e.target.value, parameters = type === "required_reference" ? { entity_types: ["character", "location", "faction"] } : type === "fact_equals" ? { predicates: ["identity", "primary_faction", "life_state", "age"] } : type === "event_precedes" ? { before_event_id: "", after_event_id: "" } : type === "forbidden_term" ? { terms: [], exceptions: [], case_sensitive: true } : type === "world_constraint" ? { location_ref: "", forbidden_capability: "" } : { text: "" };
          setDraft({ ...draft, type, parameters });
        }}>{options(["required_reference", "fact_equals", "event_precedes", "forbidden_term", "world_constraint", "advisory"], "rule.type.")}</select></label>
        <label>严重程度<select aria-label="严重程度" value={draft.severity} onChange={e => update("severity", e.target.value)}>{options(["error", "warning", "info"], "rule.severity.")}</select></label>
        <label>规则说明<textarea aria-label="规则说明" rows={2} value={draft.rationale} maxLength={10000} onChange={e => update("rationale", e.target.value)}/></label>
        <label>例外处理<select aria-label="例外处理" value={draft.exception_policy} onChange={e => update("exception_policy", e.target.value)}>{options(["author_review", "none"], "rule.exception.")}</select></label>
        {draft.type === "required_reference" && <Choices title="必须引用" choices={canonKinds.filter(k => ["character", "location", "faction"].includes(k.kind)).map(k => ({ id: k.kind, name: k.label }))} value={draft.parameters.entity_types} onChange={v => parameter("entity_types", v)}/>}
        {draft.type === "fact_equals" && <Choices title="核对事实" choices={["identity", "primary_faction", "life_state", "age"].map(k => ({ id: k, name: domainText("fact.predicate." + k, k) }))} value={draft.parameters.predicates} onChange={v => parameter("predicates", v)}/>}
        {draft.type === "event_precedes" && <><Reference title="较早事件" choices={choices("event")} value={draft.parameters.before_event_id} onChange={v => parameter("before_event_id", v)}/><Reference title="较晚事件" choices={choices("event")} value={draft.parameters.after_event_id} onChange={v => parameter("after_event_id", v)}/></>}
        {draft.type === "forbidden_term" && <><label>禁止用语<textarea aria-label="禁止用语" rows={3} value={text.terms} placeholder="每行一个" onChange={e => setText({ ...text, terms: e.target.value })}/></label><label>用语例外<textarea aria-label="用语例外" rows={2} value={text.exceptions} placeholder="每行一个" onChange={e => setText({ ...text, exceptions: e.target.value })}/></label><label className="canon-checkbox"><input type="checkbox" checked={draft.parameters.case_sensitive} onChange={e => parameter("case_sensitive", e.target.checked)}/>区分大小写</label></>}
        {draft.type === "world_constraint" && <><Reference title="地点限制" choices={choices("location")} value={draft.parameters.location_ref} onChange={v => parameter("location_ref", v)}/><label>禁止能力<input value={draft.parameters.forbidden_capability} maxLength={200} onChange={e => parameter("forbidden_capability", e.target.value)}/></label></>}
        {draft.type === "advisory" && <label>创作建议<textarea aria-label="创作建议" rows={4} value={draft.parameters.text} maxLength={10000} onChange={e => parameter("text", e.target.value)}/></label>}
        <section className="canon-editor-section"><h3>适用范围</h3><Choices title="作品类型" choices={["novel", "drama", "music-cue", "visual-prompt"].map(k => ({ id: k, name: domainText("package." + k, k) }))} value={draft.scope.packages} onChange={v => update("scope", { ...draft.scope, packages: v })}/>
          <Choices title="指定文稿" choices={documents.map(d => ({ id: d.document_id, name: d.title }))} value={draft.scope.document_ids} onChange={v => update("scope", { ...draft.scope, document_ids: v })}/>
          <Choices title="指定设定" choices={choices()} value={draft.scope.entity_refs} onChange={v => update("scope", { ...draft.scope, entity_refs: v })}/>
        </section>
      </>}
      {["character", "faction", "location"].includes(category.kind) && <label className="canon-checkbox"><input type="checkbox" checked={draft.archived} onChange={e => update("archived", e.target.checked)}/>归档此条目</label>}
      <Sources value={draft.source_refs}/>
    </fieldset>
    <footer><CancelCanon/><span className="muted">第 {snapshot.revision} 版</span><button className="primary" disabled={held || !valid || (!dirty && !!entity)} onClick={() => void run(() => desktop.canon("save", { expected: expectedCanon(snapshot), typed_changes: [{ type: "upsert_" + category.kind, entity: output }] }))}>保存设定</button></footer>
    {fact !== undefined && <FactEditor subject={id} fact={fact} choices={choices} onClose={() => setFact(undefined)} onSave={item => { update("facts", draft.facts.some((f: any) => f.fact_id === item.fact_id) ? draft.facts.map((f: any) => f.fact_id === item.fact_id ? item : f) : [...draft.facts, item]); setFact(undefined); }}/ >}
  </CanonSheet>;
}

function FactEditor({ subject, fact, choices, onClose, onSave }: { subject: string; fact: any; choices: (kind: string) => { id: string; name: string }[]; onClose: () => void; onSave: (item: any) => void }) {
  const [original] = useState(() => structuredClone(fact ?? { fact_id: "fact_" + crypto.randomUUID(), subject_ref: subject, predicate: "identity", value: "", valid_from: "", source_refs: [] })), [draft, setDraft] = useState(original);
  const update = (key: string, value: any) => setDraft({ ...draft, [key]: value });
  const valid = draft.valid_from && draft.valid_from !== draft.valid_to && (draft.predicate === "age" ? Number.isInteger(draft.value) && draft.value >= 0 && draft.value <= 1000000000 : typeof draft.value === "string" && draft.value.trim());
  return <CanonSheet title="编辑人物事实" className="canon-fact-sheet" dirty={JSON.stringify(draft) !== JSON.stringify(original)} onClose={onClose}>
    <div className="canon-editor-content"><label>事实类型<select aria-label="事实类型" value={draft.predicate} onChange={e => setDraft({ ...draft, predicate: e.target.value, value: e.target.value === "life_state" ? "alive" : e.target.value === "age" ? 0 : "" })}>{options(["identity", "primary_faction", "life_state", "age"], "fact.predicate.")}</select></label>
      {draft.predicate === "primary_faction" ? <Reference title="所属势力" choices={choices("faction")} value={draft.value} onChange={v => update("value", v)}/> : draft.predicate === "life_state" ? <label>生命状态<select aria-label="生命状态" value={draft.value} onChange={e => update("value", e.target.value)}>{options(["alive", "dead"], "fact.life.")}</select></label> : <label>{draft.predicate === "age" ? "年龄" : "事实内容"}<input type={draft.predicate === "age" ? "number" : "text"} value={draft.value} maxLength={500} min={0} max={1000000000} onChange={e => update("value", draft.predicate === "age" && e.target.value !== "" ? Number(e.target.value) : e.target.value)}/></label>}
      <Reference title="生效事件" choices={choices("event")} value={draft.valid_from} onChange={v => update("valid_from", v)}/><Reference title="结束事件" optional choices={choices("event").filter(c => c.id !== draft.valid_from)} value={draft.valid_to ?? ""} onChange={v => { const next = { ...draft }; if (v) next.valid_to = v; else delete next.valid_to; setDraft(next); }}/><Sources value={draft.source_refs}/>
    </div><footer><CancelCanon/><button className="primary" disabled={!valid} onClick={() => onSave(draft)}>保存事实</button></footer>
  </CanonSheet>;
}

export function CanonLock({ snapshot, onClose, onSaved }: { snapshot: any; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [pending, setPending] = useState(false);
  const locked = !snapshot.blueprint.lock.locked;
  async function run(recover = false) {
    setBusy(true); setError("");
    try { await desktop.canon(recover ? "recover" : "lock", { locked, reason, expected: expectedCanon(snapshot) }); await desktop.canon("acknowledge"); onSaved(); onClose(); }
    catch (e) { setError((e as Error).message); try { setPending((await desktop.canon("get")).journal?.status === "pending"); } catch { /* 保留原操作。 */ } }
    finally { setBusy(false); }
  }
  return <CanonSheet title={locked ? "锁定设定" : "解锁设定"} className="canon-lock-sheet" dirty={!!reason} held={busy || pending} protect onClose={onClose}>
    <p>{locked ? "锁定后可继续阅读和查看历史，修改需先解锁。" : "解锁后可以修改当前作品设定。"}</p>
    <label>原因<input value={reason} disabled={busy || pending} maxLength={1000} onChange={e => setReason(e.target.value)}/></label>{error && <p role="alert">{error}</p>}
    <footer><CancelCanon/>{pending ? <button disabled={busy} onClick={() => void run(true)}>恢复原设定操作</button> : <button className="primary" disabled={busy || !reason.trim()} onClick={() => void run()}>{locked ? "确认锁定" : "确认解锁"}</button>}</footer>
  </CanonSheet>;
}

export function CanonRemoval({ snapshot, entry, onClose, onSaved }: { snapshot: any; entry: { id: string; label: string; kind: string; value: any }; onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [pending, setPending] = useState(false);
  async function submit(recover = false) {
    setBusy(true); setError("");
    try { await desktop.canon(recover ? "recover" : "save", { expected: expectedCanon(snapshot), typed_changes: [{ type: "remove_entity", entity_ref: entry.id }] }); await desktop.canon("acknowledge"); onSaved(); onClose(); }
    catch (e) { setError((e as Error).message); try { setPending((await desktop.canon("get")).journal?.status === "pending"); } catch { /* 保留原操作。 */ } }
    finally { setBusy(false); }
  }
  return <CanonSheet title="移除设定" className="canon-lock-sheet" held={busy || pending} protect onClose={onClose}><p>确认移除“{entityName({ ...entry, section: "" })}”？历史版本将保留。</p>{error && <p role="alert">{error}</p>}<footer><CancelCanon/>{pending ? <button disabled={busy} onClick={() => void submit(true)}>恢复原设定操作</button> : <button className="danger" disabled={busy} onClick={() => void submit()}>确认移除</button>}</footer></CanonSheet>;
}

export function CanonHistory({ snapshot, ai, onClose }: { snapshot: any; ai: (object?: any) => void; onClose: () => void }) {
  const [revision, setRevision] = useState(snapshot.revision), [value, setValue] = useState(snapshot), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const entries = canonEntries(value.blueprint), name = (id: string) => { const entry = entries.find(e => e.value[e.id] === id); return entry ? entityName(entry) : "所引设定不可用"; };
  async function load() { setBusy(true); setError(""); try { setValue(await desktop.canon("get", { revision })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <CanonSheet title="设定历史" className="canon-history-sheet" held={busy} onClose={onClose}>
    <div className="canon-history-controls"><label>设定修订<input type="number" value={revision} min={1} max={snapshot.revision} onChange={e => setRevision(Number(e.target.value))}/></label><button disabled={busy || !Number.isInteger(revision) || revision < 1 || revision > snapshot.revision} onClick={() => void load()}>查看修订</button><button onClick={() => ai({ blueprint_revision: value.revision })}>让 AI 处理</button></div>
    {error && <p role="alert">{error}</p>}<div className="canon-history-content"><p className="canon-status">第 {value.revision} 版 {value.blueprint.lock.locked ? "已锁定" : "可编辑"}</p>{canonKinds.filter(kind => entries.some(entry => entry.kind === kind.kind)).map(kind => <section key={kind.kind}><h3>{kind.label}</h3>{entries.filter(e => e.kind === kind.kind).map(entry => <article key={entry.value[entry.id]}><h4>{entityName(entry)}</h4>
      {entry.value.description && <p>{entry.value.description}</p>}{entry.value.aliases?.length > 0 && <p>别名：{entry.value.aliases.join("、")}</p>}{entry.value.traits?.length > 0 && <p>特征：{entry.value.traits.join("、")}</p>}{entry.value.archived && <p className="muted">已归档</p>}
      {entry.kind === "location" && <p>{domainText("location." + entry.value.interior_exterior, "未标明")}{entry.value.parent_ref ? `，属于${name(entry.value.parent_ref)}` : ""}</p>}
      {entry.value.facts?.map((fact: any) => <div key={fact.fact_id}><p>{domainText("fact.predicate." + fact.predicate, fact.predicate)}：{fact.predicate === "primary_faction" ? name(fact.value) : fact.predicate === "life_state" ? domainText("fact.life." + fact.value, fact.value) : String(fact.value)}</p><p className="muted">从{name(fact.valid_from)}起{fact.valid_to ? `，至${name(fact.valid_to)}` : "，持续有效"}</p><Sources value={fact.source_refs}/></div>)}
      {entry.value.relations?.map((r: any, i: number) => <p key={i}>{name(r.target_ref)}：{domainText("faction.relation." + r.type, r.type)}</p>)}
      {entry.kind === "event" && <>{entry.value.time_anchor && <p>{entry.value.time_anchor.calendar} {entry.value.time_anchor.tick}</p>}{["before_refs", "after_refs"].map(key => entry.value[key]?.length > 0 && <p key={key}>{domainText(key === "before_refs" ? "timeline.before" : "timeline.after", key)}：{entry.value[key].map(name).join("、")}</p>)}</>}
      {entry.kind === "rule" && <><p>{domainText("rule.type." + entry.value.type, entry.value.type)} {domainText("rule.severity." + entry.value.severity, entry.value.severity)} {domainText("rule.exception." + entry.value.exception_policy, entry.value.exception_policy)}</p><dl className="canon-fields"><dt>适用作品</dt><dd>{entry.value.scope.packages.map((v: string) => domainText("package." + v, v)).join("、")}</dd><dt>指定设定</dt><dd>{entry.value.scope.entity_refs.map(name).join("、") || "全部"}</dd></dl>{Object.entries(entry.value.parameters).map(([key, parameter]) => <p key={key}>{domainText("rule.parameter." + key, ({ text: "创作建议", entity_types: "必须引用", predicates: "核对事实", terms: "禁止用语", exceptions: "用语例外", case_sensitive: "区分大小写", before_event_id: "较早事件", after_event_id: "较晚事件", location_ref: "地点限制", forbidden_capability: "禁止能力" } as any)[key] ?? key)}：{Array.isArray(parameter) ? parameter.map(v => ["entity_types", "predicates"].includes(key) ? domainText((key === "entity_types" ? "entity.kind." : "fact.predicate.") + v, v) : v).join("、") : ["before_event_id", "after_event_id", "location_ref"].includes(key) ? name(String(parameter)) : typeof parameter === "boolean" ? parameter ? "是" : "否" : String(parameter)}</p>)}</>}
      <Sources value={entry.value.source_refs}/>
    </article>)}</section>)}</div>
  </CanonSheet>;
}
