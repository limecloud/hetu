use hetu_core::Kernel;
use serde_json::{Value, json};

const CHAR: &str = "character_11111111-1111-4111-8111-111111111111";
const FACTION: &str = "faction_22222222-2222-4222-8222-222222222222";
const LOCATION: &str = "location_33333333-3333-4333-8333-333333333333";
const START: &str = "event_44444444-4444-4444-8444-444444444444";
const END: &str = "event_55555555-5555-4555-8555-555555555555";
const WORLD: &str = "entry_66666666-6666-4666-8666-666666666666";
const RULE: &str = "rule_77777777-7777-4777-8777-777777777777";
fn kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(json!({"workspace_path":root,"mode":"author","create":{"title":"雾港纪事","locale":"zh-CN","operation_key":"new"}})).unwrap()
}
fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn get(k: &Kernel) -> Value {
    let result = call(k, "blueprints.get", json!({}));
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn save(k: &Kernel, changes: Value, key: &str) -> Value {
    let current = get(k);
    call(
        k,
        "blueprints.save",
        json!({"expected":{"revision":current["revision"],"sha256":current["sha256"]},"typed_changes":changes,"operation_key":key}),
    )
}
fn event(reference: &str, tick: i64) -> Value {
    json!({"event_id":reference,"title":format!("时间 {tick}"),"time_anchor":{"calendar":"雾港历","tick":tick},"before_refs":[],"after_refs":[],"source_refs":[]})
}
fn character(facts: Value) -> Value {
    json!({"character_id":CHAR,"name":"林舟","aliases":["巡夜人"],"description":"信使","traits":["谨慎"],"facts":facts,"archived":false})
}
fn scope() -> Value {
    json!({"packages":["novel","drama"],"document_ids":[],"entity_refs":[]})
}
fn rule(kind: &str, parameters: Value) -> Value {
    json!({"rule_id":RULE,"revision":1,"type":kind,"scope":scope(),"severity":"warning","parameters":parameters,"rationale":"作者明确约束","exception_policy":"author_review"})
}
fn upsert(kind: &str, value: Value) -> Value {
    json!({"type":format!("upsert_{kind}"),"entity":value})
}
fn base_changes() -> Value {
    json!([
        upsert("character", character(json!([]))),
        upsert(
            "location",
            json!({"location_id":LOCATION,"name":"灯塔","aliases":[],"interior_exterior":"exterior","description":"雾港入口","archived":false})
        ),
        upsert(
            "faction",
            json!({"faction_id":FACTION,"name":"守夜会","description":"巡夜组织","relations":[],"archived":false})
        ),
        upsert("event", event(START, 0)),
        upsert("event", event(END, 10)),
        upsert(
            "world",
            json!({"entry_id":WORLD,"title":"雾港历","description":"以灯塔点灯为纪时基准","source_refs":[]})
        ),
        upsert(
            "rule",
            rule(
                "forbidden_term",
                json!({"terms":["瞬间移动"],"case_sensitive":true,"exceptions":["传说中的瞬间移动"]})
            )
        )
    ])
}
fn fact(reference: &str, value: &str, from: &str, to: Option<&str>) -> Value {
    let mut item = json!({"fact_id":reference,"subject_ref":CHAR,"predicate":"life_state","value":value,"valid_from":from,"source_refs":[]});
    if let Some(to) = to {
        item["valid_to"] = json!(to);
    }
    item
}

#[test]
fn full_bible_changes_are_atomic_previewable_and_historical() {
    let root = tempfile::tempdir().unwrap();
    let k = kernel(root.path());
    let initial = get(&k);
    let input = json!({"expected":{"revision":initial["revision"],"sha256":initial["sha256"]},"typed_changes":base_changes()});
    let preview = call(&k, "blueprints.preview_change", input);
    assert_eq!(preview["status"], "succeeded", "{preview}");
    assert_eq!(
        preview["data"]["impact"]["changes"]
            .as_array()
            .unwrap()
            .len(),
        7
    );
    assert_eq!(get(&k), initial, "预览不能更改设定集");
    let saved = save(&k, base_changes(), "full");
    assert_eq!(saved["status"], "succeeded", "{saved}");
    let old = call(&k, "blueprints.get", json!({"revision":1}));
    assert_eq!(old["data"], initial);
    assert_eq!(saved["data"]["blueprint"]["characters"][0]["name"], "林舟");
    assert_eq!(saved["data"]["blueprint"]["locations"][0]["name"], "灯塔");
    let mut changed = saved["data"]["blueprint"]["rules"][0].clone();
    changed["rationale"] = json!("修订规则说明");
    let next = save(&k, json!([upsert("rule", changed)]), "rule-v2");
    assert_eq!(next["data"]["blueprint"]["rules"][0]["revision"], 2);
    let earlier = call(&k, "blueprints.get", json!({"revision":2}));
    assert_eq!(earlier["data"]["blueprint"]["rules"][0]["revision"], 1);
    std::fs::write(root.path().join("shared/blueprint-revisions/2.json"), "{}").unwrap();
    assert_eq!(
        call(&k, "blueprints.get", json!({"revision":2}))["error"]["code"],
        "hetu.integrity_failure"
    );
}
#[test]
fn forward_references_work_but_dangling_deletions_and_cycles_do_not_commit() {
    let root = tempfile::tempdir().unwrap();
    let k = kernel(root.path());
    let mut changes = base_changes();
    changes[0]["entity"]["facts"] = json!([{"fact_id":"fact_88888888-8888-4888-8888-888888888888","subject_ref":CHAR,"predicate":"primary_faction","value":FACTION,"valid_from":START,"source_refs":[]}]);
    assert_eq!(save(&k, changes, "forward")["status"], "succeeded");
    let before = get(&k);
    let removed = save(
        &k,
        json!([{"type":"remove_entity","entity_ref":FACTION}]),
        "bad-remove",
    );
    assert_eq!(removed["error"]["code"], "hetu.reference_in_use");
    assert_eq!(get(&k), before);
    let mut location = before["blueprint"]["locations"][0].clone();
    location["parent_ref"] = json!(LOCATION);
    assert_eq!(
        save(&k, json!([upsert("location", location)]), "cycle")["error"]["code"],
        "hetu.location_cycle"
    );
    let removed = save(
        &k,
        json!([upsert("character",character(json!([]))),{"type":"remove_entity","entity_ref":FACTION}]),
        "remove-with-migration",
    );
    assert_eq!(removed["status"], "succeeded", "{removed}");
    assert!(
        removed["data"]["blueprint"]["factions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call(&k, "blueprints.get", json!({"revision":2}))["data"]["blueprint"]["factions"][0]["name"],
        "守夜会"
    );
}
#[test]
fn absolute_and_relative_time_are_checked_together_including_simultaneous_events() {
    let root = tempfile::tempdir().unwrap();
    let k = kernel(root.path());
    assert_eq!(save(&k, base_changes(), "base")["status"], "succeeded");
    let mut late = event(END, 10);
    late["before_refs"] = json!([START]);
    assert_eq!(
        save(&k, json!([upsert("event", late)]), "reversed")["error"]["code"],
        "hetu.timeline_cycle"
    );
    let mut same = event(END, 0);
    assert_eq!(
        save(&k, json!([upsert("event", same.clone())]), "simultaneous")["status"],
        "succeeded"
    );
    same["before_refs"] = json!([START]);
    assert_eq!(
        save(&k, json!([upsert("event", same)]), "same-before")["error"]["code"],
        "hetu.timeline_cycle"
    );
    let preceding = rule(
        "event_precedes",
        json!({"before_event_id":START,"after_event_id":END}),
    );
    assert_eq!(
        save(&k, json!([upsert("rule", preceding)]), "rule-cycle")["error"]["code"],
        "hetu.timeline_cycle"
    );
}
#[test]
fn facts_require_typed_values_and_explicit_noncontradictory_intervals() {
    let root = tempfile::tempdir().unwrap();
    let k = kernel(root.path());
    save(&k, base_changes(), "base");
    let first = fact(
        "fact_88888888-8888-4888-8888-888888888888",
        "alive",
        START,
        None,
    );
    let second = fact(
        "fact_99999999-9999-4999-8999-999999999999",
        "dead",
        START,
        None,
    );
    assert_eq!(
        save(
            &k,
            json!([upsert(
                "character",
                character(json!([first.clone(), second.clone()]))
            )]),
            "contradiction"
        )["error"]["code"],
        "hetu.fact_conflict"
    );
    let mut earlier = first.clone();
    earlier["valid_to"] = json!(END);
    let mut later = second;
    later["valid_from"] = json!(END);
    assert_eq!(
        save(
            &k,
            json!([upsert("character", character(json!([earlier, later])))]),
            "boundary"
        )["status"],
        "succeeded"
    );
    let mut invalid = first;
    invalid["value"] = json!(false);
    assert_eq!(
        save(
            &k,
            json!([upsert("character", character(json!([invalid])))]),
            "bad-value"
        )["error"]["code"],
        "invalid_input"
    );
}
#[test]
fn source_evidence_must_match_immutable_utf8_boundaries_and_quote() {
    let root = tempfile::tempdir().unwrap();
    let k = kernel(root.path());
    let doc = call(
        &k,
        "documents.create",
        json!({"title":"原文","kind":"novel_chapter","source_format":"markdown","content":"林舟🌿\r\n旧宅。","operation_key":"doc"}),
    );
    let source = json!({"document_id":doc["data"]["document"]["document_id"],"revision_id":doc["data"]["revision"]["revision_id"],"byte_start":0,"byte_end":10,"quote":"林舟🌿"});
    let mut world = json!({"entry_id":WORLD,"title":"来源证据","description":"手工确认","source_refs":[source]});
    assert_eq!(
        save(&k, json!([upsert("world", world.clone())]), "evidence")["status"],
        "succeeded"
    );
    world["source_refs"][0]["byte_end"] = json!(9);
    assert_eq!(
        save(&k, json!([upsert("world", world.clone())]), "split-emoji")["error"]["code"],
        "hetu.invalid_source_ref"
    );
    world["source_refs"][0]["byte_end"] = json!(10);
    world["source_refs"][0]["quote"] = json!("伪造引文");
    assert_eq!(
        save(&k, json!([upsert("world", world)]), "wrong-quote")["error"]["code"],
        "hetu.invalid_source_ref"
    );
}
#[test]
fn rules_and_entities_reject_unknown_fields_duplicate_ids_and_empty_names() {
    let root = tempfile::tempdir().unwrap();
    let k = kernel(root.path());
    let mut unsafe_rule = rule(
        "advisory",
        json!({"text":"不能自动执行","shell":"touch /tmp/forbidden"}),
    );
    assert_eq!(
        save(&k, json!([upsert("rule", unsafe_rule.clone())]), "script")["error"]["code"],
        "invalid_input"
    );
    unsafe_rule["parameters"] = json!({"text":"只供作者参考"});
    unsafe_rule["revision"] = json!(9);
    assert_eq!(
        save(&k, json!([upsert("rule", unsafe_rule)]), "revision")["error"]["code"],
        "revision_conflict"
    );
    let mut blank = character(json!([]));
    blank["name"] = json!("　 \n");
    assert_eq!(
        save(&k, json!([upsert("character", blank)]), "blank")["error"]["code"],
        "invalid_input"
    );
    assert_eq!(
        save(
            &k,
            json!([
                upsert("character", character(json!([]))),
                upsert("character", character(json!([])))
            ]),
            "duplicate"
        )["error"]["code"],
        "invalid_input"
    );
}
