use super::{Error, Result, ensure};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::OnceLock;

pub const URI: &str = "urn:hetu:schema:blueprint:1.0.0";
const SOURCE_URI: &str = "urn:hetu:schema:source-ref:1.0.0";
pub const SECTIONS: [(&str, &str, &str); 6] = [
    ("character", "characters", "character_id"),
    ("faction", "factions", "faction_id"),
    ("location", "locations", "location_id"),
    ("event", "timeline", "event_id"),
    ("world", "world", "entry_id"),
    ("rule", "rules", "rule_id"),
];

pub fn schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../../contracts/schemas/blueprint.schema.json"
        ))
        .expect("embedded story bible schema");
        assert_eq!(value["$id"], URI);
        value["$defs"]["source_ref_resource"] = source_schema();
        value
    })
}
fn source_schema() -> Value {
    let mut source: Value = serde_json::from_str(include_str!(
        "../../../contracts/schemas/source-ref.schema.json"
    ))
    .expect("embedded source schema");
    source["$id"] = json!(SOURCE_URI);
    source
}
// 对外返回的输入 Schema 自包含；验证过程只解析内存资源，不访问网络。
pub fn bundle(mut input: Value) -> Value {
    input["$defs"]["blueprint_resource"] = schema().clone();
    input
}
pub fn validate_structure(value: &Value) -> Result<()> {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    ensure(
        value["schema_version"] == "1.0.0",
        "unsupported_version",
        "设定集格式版本不受支持。",
    )?;
    let validator = VALIDATOR.get_or_init(|| {
        jsonschema::validator_for(schema()).expect("embedded story bible validator")
    });
    if let Some(error) = validator.iter_errors(value).next() {
        return Err(Error::new(
            "invalid_input",
            format!("设定集结构无效：{}", error.instance_path),
        ));
    }
    Ok(())
}

fn rows<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value[field].as_array().expect("validated array")
}
fn string<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field].as_str().expect("validated string")
}
fn nonblank(value: &str) -> Result<()> {
    ensure(
        !value.trim().is_empty(),
        "invalid_input",
        "名称、词条和明确事实不能只含空白。",
    )
}
fn referenced<'a>(entities: &BTreeMap<&'a str, &'a Value>, reference: &str) -> Result<()> {
    ensure(
        entities.contains_key(reference),
        "hetu.reference_in_use",
        "关联对象不存在或仍被引用，请检查人物、地点、事件及规则范围。",
    )
}

pub fn apply(current: &Value, changes: &[Value]) -> Result<(Value, Value)> {
    let mut next = current.clone();
    let mut touched = BTreeSet::new();
    let mut impact = Vec::new();
    for change in changes {
        let change_type = string(change, "type");
        if change_type == "remove_entity" {
            let reference = string(change, "entity_ref");
            ensure(
                touched.insert(reference.to_owned()),
                "invalid_input",
                "一次变更只能更新同一实体一次。",
            )?;
            let mut found = false;
            for (_, section, key) in SECTIONS {
                let items = next[section].as_array_mut().unwrap();
                if let Some(index) = items.iter().position(|item| item[key] == reference) {
                    items.remove(index);
                    found = true;
                    impact
                        .push(json!({"entity_ref":reference,"change":"removed","section":section}));
                    break;
                }
            }
            ensure(found, "not_found", "要移除的设定实体不存在。")?;
            continue;
        }
        let kind = change_type
            .strip_prefix("upsert_")
            .expect("validated change");
        let (_, section, key) = SECTIONS
            .iter()
            .find(|(name, _, _)| *name == kind)
            .expect("validated entity type");
        let mut entity = change["entity"].clone();
        let reference = string(&entity, key).to_owned();
        ensure(
            touched.insert(reference.clone()),
            "invalid_input",
            "一次变更只能更新同一实体一次。",
        )?;
        let items = next[*section].as_array_mut().unwrap();
        let old = items.iter().position(|item| item[*key] == reference);
        if kind == "rule" {
            let revision = old.map_or(1, |i| items[i]["revision"].as_u64().unwrap());
            ensure(
                entity["revision"] == revision,
                "revision_conflict",
                "规则修订已变化，请刷新设定集。",
            )?;
            if let Some(i) = old
                && entity != items[i]
            {
                entity["revision"] =
                    json!(revision.checked_add(1).ok_or_else(|| Error::new(
                        "hetu.budget_exceeded",
                        "规则修订超过支持上限。"
                    ))?);
            }
        }
        let action = if let Some(index) = old {
            items[index] = entity;
            "updated"
        } else {
            items.push(entity);
            "added"
        };
        impact.push(json!({"entity_ref":reference,"change":action,"section":section}));
    }
    next["revision"] = json!(
        current["revision"]
            .as_u64()
            .unwrap()
            .checked_add(1)
            .ok_or_else(|| Error::new("hetu.budget_exceeded", "设定集修订超过支持上限。"))?
    );
    validate(&next)?;
    Ok((next, json!({"changes":impact})))
}

pub fn validate(value: &Value) -> Result<()> {
    validate_structure(value)?;
    let mut entities = BTreeMap::new();
    for (_, section, key) in SECTIONS {
        for item in rows(value, section) {
            let reference = string(item, key);
            ensure(
                entities.insert(reference, item).is_none(),
                "hetu.duplicate_entity",
                "设定集中有重复实体标识。",
            )?;
            nonblank(string(
                item,
                if item.get("name").is_some() {
                    "name"
                } else if item.get("title").is_some() {
                    "title"
                } else {
                    continue;
                },
            ))?;
            for field in ["aliases", "traits"] {
                if let Some(items) = item[field].as_array() {
                    for item in items {
                        nonblank(item.as_str().unwrap())?;
                    }
                }
            }
        }
    }
    let mut parents = BTreeMap::new();
    for location in rows(value, "locations") {
        if let Some(parent) = location["parent_ref"].as_str() {
            referenced(&entities, parent)?;
            parents.insert(string(location, "location_id"), parent);
        }
    }
    for reference in parents.keys() {
        let mut current = *reference;
        let mut visited = BTreeSet::new();
        while let Some(parent) = parents.get(current) {
            ensure(
                visited.insert(current),
                "hetu.location_cycle",
                "地点的父子关系不能成环。",
            )?;
            current = parent;
        }
    }
    for faction in rows(value, "factions") {
        for relation in rows(faction, "relations") {
            let target = string(relation, "target_ref");
            referenced(&entities, target)?;
            ensure(
                target != string(faction, "faction_id"),
                "invalid_input",
                "势力关系不能指向自身。",
            )?;
        }
    }
    let mut chronology = Chronology::new(value, &entities)?;
    let mut fact_ids = BTreeSet::new();
    for character in rows(value, "characters") {
        let facts = rows(character, "facts");
        for fact in facts {
            ensure(
                fact_ids.insert(string(fact, "fact_id")),
                "hetu.duplicate_entity",
                "设定集中有重复事实标识。",
            )?;
            ensure(
                fact["subject_ref"] == character["character_id"],
                "invalid_input",
                "事实必须归属于当前角色。",
            )?;
            if fact["predicate"] == "primary_faction" {
                referenced(&entities, fact["value"].as_str().unwrap())?;
            }
            if fact["predicate"] == "identity" {
                nonblank(fact["value"].as_str().unwrap())?;
            }
        }
        for (index, left) in facts.iter().enumerate() {
            for right in &facts[index + 1..] {
                if left["predicate"] != right["predicate"] || left["value"] == right["value"] {
                    continue;
                }
                ensure(
                    !chronology.overlap(left, right)?,
                    "hetu.fact_conflict",
                    "同一角色在同一已知时段有互相矛盾的明确事实，请调整事实或有效期。",
                )?;
            }
        }
    }
    for rule in rows(value, "rules") {
        for reference in rows(&rule["scope"], "entity_refs") {
            referenced(&entities, reference.as_str().unwrap())?;
        }
        let parameters = &rule["parameters"];
        if rule["type"] == "world_constraint" {
            referenced(&entities, string(parameters, "location_ref"))?;
            nonblank(string(parameters, "forbidden_capability"))?;
        }
        if rule["type"] == "forbidden_term" {
            for field in ["terms", "exceptions"] {
                for term in rows(parameters, field) {
                    nonblank(term.as_str().unwrap())?;
                }
            }
        }
        if rule["type"] == "advisory" {
            nonblank(string(parameters, "text"))?;
        }
    }
    Ok(())
}

pub fn source_refs(value: &Value) -> Vec<&Value> {
    let mut result = Vec::new();
    for character in rows(value, "characters") {
        for fact in rows(character, "facts") {
            result.extend(rows(fact, "source_refs"));
        }
    }
    for section in ["timeline", "world"] {
        for item in rows(value, section) {
            result.extend(rows(item, "source_refs"));
        }
    }
    result
}

pub(crate) struct Chronology {
    groups: BTreeMap<String, String>,
    edges: BTreeMap<String, BTreeSet<String>>,
    budget: usize,
}
impl Chronology {
    pub(crate) fn from_blueprint(value: &Value) -> Result<Self> {
        let entities = SECTIONS
            .iter()
            .flat_map(|(_, section, key)| {
                rows(value, section)
                    .iter()
                    .map(move |item| (string(item, key), item))
            })
            .collect();
        Self::new(value, &entities)
    }
    fn new(value: &Value, entities: &BTreeMap<&str, &Value>) -> Result<Self> {
        let mut this = Self {
            groups: BTreeMap::new(),
            edges: BTreeMap::new(),
            budget: 1_000_000,
        };
        let mut calendars: BTreeMap<String, BTreeMap<i64, String>> = BTreeMap::new();
        for event in rows(value, "timeline") {
            let id = string(event, "event_id").to_owned();
            let group = if let Some(anchor) = event.get("time_anchor") {
                let calendar = string(anchor, "calendar");
                nonblank(calendar)?;
                let tick = anchor["tick"].as_i64().unwrap();
                let group = format!("@{calendar}\0{tick}");
                calendars
                    .entry(calendar.to_owned())
                    .or_default()
                    .insert(tick, group.clone());
                group
            } else {
                id.clone()
            };
            this.edges.entry(group.clone()).or_default();
            this.groups.insert(id, group);
        }
        for ticks in calendars.values() {
            let groups: Vec<_> = ticks.values().collect();
            for pair in groups.windows(2) {
                this.edges.get_mut(pair[0]).unwrap().insert(pair[1].clone());
            }
        }
        for event in rows(value, "timeline") {
            let id = string(event, "event_id");
            for target in rows(event, "before_refs") {
                this.edge(id, target.as_str().unwrap(), entities)?;
            }
            for target in rows(event, "after_refs") {
                this.edge(target.as_str().unwrap(), id, entities)?;
            }
        }
        for character in rows(value, "characters") {
            for fact in rows(character, "facts") {
                let from = string(fact, "valid_from");
                referenced(entities, from)?;
                if let Some(to) = fact["valid_to"].as_str() {
                    this.edge(from, to, entities)?;
                }
            }
        }
        for rule in rows(value, "rules") {
            if rule["type"] == "event_precedes" {
                this.edge(
                    string(&rule["parameters"], "before_event_id"),
                    string(&rule["parameters"], "after_event_id"),
                    entities,
                )?;
            }
        }
        let mut degrees: BTreeMap<_, usize> =
            this.edges.keys().map(|key| (key.clone(), 0)).collect();
        for targets in this.edges.values() {
            for target in targets {
                *degrees.get_mut(target).unwrap() += 1;
            }
        }
        let mut queue: VecDeque<_> = degrees
            .iter()
            .filter(|(_, degree)| **degree == 0)
            .map(|(key, _)| key.clone())
            .collect();
        let mut seen = 0;
        while let Some(node) = queue.pop_front() {
            seen += 1;
            for target in &this.edges[&node] {
                let degree = degrees.get_mut(target).unwrap();
                *degree -= 1;
                if *degree == 0 {
                    queue.push_back(target.clone());
                }
            }
        }
        ensure(
            seen == degrees.len(),
            "hetu.timeline_cycle",
            "时间关系、时间刻度或事实有效期互相矛盾，请检查先后关系。",
        )?;
        Ok(this)
    }
    fn edge(&mut self, from: &str, to: &str, entities: &BTreeMap<&str, &Value>) -> Result<()> {
        referenced(entities, from)?;
        referenced(entities, to)?;
        let left = &self.groups[from];
        let right = &self.groups[to];
        ensure(
            left != right,
            "hetu.timeline_cycle",
            "同一时刻的事件不能互相声明严格先后关系。",
        )?;
        self.edges.get_mut(left).unwrap().insert(right.clone());
        Ok(())
    }
    pub(crate) fn before(&mut self, from: &str, to: &str, equal: bool) -> Result<bool> {
        ensure(
            self.budget > 0,
            "hetu.budget_exceeded",
            "时间关系校验超过预算。",
        )?;
        self.budget -= 1;
        let start = &self.groups[from];
        let end = &self.groups[to];
        if start == end {
            return Ok(equal);
        }
        let mut queue = vec![start];
        let mut visited = BTreeSet::new();
        while let Some(node) = queue.pop() {
            ensure(
                self.budget > 0,
                "hetu.budget_exceeded",
                "时间关系校验超过预算，请拆分复杂的事实与关联。",
            )?;
            self.budget -= 1;
            if !visited.insert(node) {
                continue;
            }
            for target in &self.edges[node] {
                if target == end {
                    return Ok(true);
                }
                queue.push(target);
            }
        }
        Ok(false)
    }
    fn overlap(&mut self, left: &Value, right: &Value) -> Result<bool> {
        let a = string(left, "valid_from");
        let b = string(right, "valid_from");
        let inside_left = self.before(a, b, true)?
            && match left["valid_to"].as_str() {
                None => true,
                Some(end) => self.before(b, end, false)?,
            };
        let inside_right = self.before(b, a, true)?
            && match right["valid_to"].as_str() {
                None => true,
                Some(end) => self.before(a, end, false)?,
            };
        Ok(inside_left || inside_right)
    }
}
