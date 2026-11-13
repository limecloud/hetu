use super::{Error, Result, digest, ensure, id, now};
use aho_corasick::AhoCorasick;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
pub(crate) mod parser;

pub const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
pub const QUOTE_LIMIT: usize = 16 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceRevision {
    pub document_id: String,
    pub revision_id: String,
    pub sha256: String,
    pub source_format: String,
    pub size_bytes: usize,
}
pub struct Document {
    pub source: SourceRevision,
    pub content: String,
    pub scope_document_id: Option<String>,
    pub package: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceRef {
    pub document_id: String,
    pub revision_id: String,
    pub byte_start: usize,
    pub byte_end: usize,
    pub quote: String,
}
impl Document {
    pub fn reference(&self, range: Range<usize>) -> SourceRef {
        SourceRef {
            document_id: self.source.document_id.clone(),
            revision_id: self.source.revision_id.clone(),
            byte_start: range.start,
            byte_end: range.end,
            quote: self.content[range].to_owned(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Options {
    pub max_bytes: usize,
    pub max_nodes: usize,
    pub max_matches: usize,
    pub max_duration_ms: u64,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            max_bytes: 2 * 1024 * 1024,
            max_nodes: 2000,
            max_matches: 20_000,
            max_duration_ms: 3000,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Scene,
    Action,
    Dialogue,
    ConflictCandidate,
    ForeshadowCandidate,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verification {
    NeedsAuthorReview,
    Confirmed,
    Dismissed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeOfDay {
    Day,
    Night,
    Dawn,
    Dusk,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    MarkdownHeading,
    FountainScene,
    SceneMarker,
    QuotedDialogue,
    SpeakerLabel,
    FountainDialogue,
    DashDialogue,
    ActionTerms,
    ConflictMarker,
    ForeshadowMarker,
    AuthorAnnotation,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntityCandidate {
    pub entity_ref: String,
    pub kind: String,
    pub matched_text: String,
    pub source_ref: SourceRef,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnresolvedName {
    pub kind: String,
    pub name: String,
    pub source_ref: SourceRef,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub node_id: String,
    pub kind: Kind,
    pub source_refs: Vec<SourceRef>,
    pub entity_refs: Vec<String>,
    pub entity_candidates: Vec<EntityCandidate>,
    pub location_ref: Option<String>,
    pub location_candidates: Vec<String>,
    pub time_ref: Option<String>,
    pub speaker_ref: Option<String>,
    pub speaker_candidates: Vec<String>,
    pub time_of_day: TimeOfDay,
    pub unresolved_names: Vec<UnresolvedName>,
    pub verification: Verification,
    pub extraction_method: Method,
    pub missing_prerequisites: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotation: Option<Annotation>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Annotation {
    pub context: String,
    pub facts: Vec<FactAssertion>,
    pub capabilities: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FactAssertion {
    pub subject_ref: String,
    pub predicate: String,
    pub value: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edge {
    pub edge_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub relation: String,
    pub verification: Verification,
    pub source_refs: Vec<SourceRef>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRange {
    pub document_id: String,
    pub revision_id: String,
    pub byte_start: usize,
    pub byte_end: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UnparsedRange {
    #[serde(flatten)]
    pub range: SourceRange,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BudgetStop {
    pub document_id: String,
    pub revision_id: String,
    pub byte_offset: usize,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Coverage {
    pub status: String,
    pub requested_refs: Vec<SourceRevision>,
    pub scanned_ranges: Vec<SourceRange>,
    pub scanned_bytes: usize,
    pub unparsed_ranges: Vec<UnparsedRange>,
    pub budget_stop: Option<BudgetStop>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plot {
    pub schema_version: String,
    pub plot_revision_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_plot_revision_id: Option<String>,
    pub blueprint_revision: u64,
    pub blueprint_sha256: String,
    pub source_revisions: Vec<SourceRevision>,
    pub engine_version: String,
    pub options: Options,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub coverage: Coverage,
    pub created_at: String,
    pub actor_ref: String,
}
pub fn schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contracts/schemas/plot.schema.json"))
            .expect("embedded plot schema")
    })
}
pub fn bundle(mut input: Value) -> Value {
    input["$defs"]["plot_resource"] = schema().clone();
    input
}
pub fn decode(value: &Value) -> Result<Plot> {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    let validator = VALIDATOR
        .get_or_init(|| jsonschema::validator_for(schema()).expect("embedded plot validator"));
    if let Some(error) = validator.iter_errors(value).next() {
        return Err(Error::new(
            "hetu.integrity_failure",
            format!("剧情修订不符合合同：{}", error.instance_path),
        ));
    }
    Ok(serde_json::from_value(value.clone())?)
}
fn source_range(source: &SourceRevision, range: Range<usize>) -> SourceRange {
    SourceRange {
        document_id: source.document_id.clone(),
        revision_id: source.revision_id.clone(),
        byte_start: range.start,
        byte_end: range.end,
    }
}
struct Dictionary {
    matcher: Option<AhoCorasick>,
    names: Vec<String>,
    entries: BTreeMap<String, Vec<(String, String)>>,
}
impl Dictionary {
    fn new(blueprint: &Value) -> Result<Self> {
        let mut entries: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        for (section, key, kind) in [
            ("characters", "character_id", "character"),
            ("factions", "faction_id", "faction"),
            ("locations", "location_id", "location"),
        ] {
            for entity in blueprint[section].as_array().unwrap() {
                let mut names = vec![entity["name"].as_str().unwrap()];
                if let Some(aliases) = entity["aliases"].as_array() {
                    names.extend(aliases.iter().map(|item| item.as_str().unwrap()));
                }
                for name in names {
                    let values = entries.entry(name.to_owned()).or_default();
                    let item = (entity[key].as_str().unwrap().to_owned(), kind.to_owned());
                    if !values.contains(&item) {
                        values.push(item);
                    }
                }
            }
        }
        let names: Vec<_> = entries.keys().cloned().collect();
        let matcher =
            if names.is_empty() {
                None
            } else {
                Some(AhoCorasick::new(&names).map_err(|_| {
                    Error::new("hetu.budget_exceeded", "设定名称词典超过匹配预算。")
                })?)
            };
        Ok(Self {
            matcher,
            names,
            entries,
        })
    }
    fn matches(
        &self,
        text: &str,
        offset: usize,
        document: &Document,
        remaining: &mut usize,
        deadline: Instant,
    ) -> std::result::Result<Vec<EntityCandidate>, &'static str> {
        let Some(matcher) = &self.matcher else {
            return Ok(Vec::new());
        };
        let mut spans: BTreeMap<usize, (usize, usize)> = BTreeMap::new();
        for matched in matcher.find_overlapping_iter(text) {
            if *remaining == 0 {
                return Err("max_matches");
            }
            *remaining -= 1;
            if Instant::now() >= deadline {
                return Err("max_duration");
            }
            let name = &self.names[matched.pattern().as_usize()];
            if !boundaries(text, matched.start()..matched.end(), name) {
                continue;
            }
            let span = spans
                .entry(matched.start())
                .or_insert((matched.end(), matched.pattern().as_usize()));
            if matched.end() > span.0 {
                *span = (matched.end(), matched.pattern().as_usize());
            }
        }
        let mut result = Vec::new();
        let mut end = 0;
        for (start, (until, pattern)) in spans {
            if start < end {
                continue;
            }
            end = until;
            let name = &self.names[pattern];
            for (reference, kind) in &self.entries[name] {
                if result.len() >= 1000 {
                    return Err("max_matches");
                }
                result.push(EntityCandidate {
                    entity_ref: reference.clone(),
                    kind: kind.clone(),
                    matched_text: document.content[offset + start..offset + until].to_owned(),
                    source_ref: document.reference(offset + start..offset + until),
                });
            }
        }
        Ok(result)
    }
}
fn boundaries(text: &str, range: Range<usize>, name: &str) -> bool {
    fn word(ch: char) -> bool {
        ch.is_alphanumeric()
            && !('\u{2e80}'..='\u{9fff}').contains(&ch)
            && !('\u{20000}'..='\u{323af}').contains(&ch)
    }
    let left = name.chars().next().unwrap();
    let right = name.chars().next_back().unwrap();
    (!word(left)
        || text[..range.start]
            .chars()
            .next_back()
            .is_none_or(|ch| !word(ch)))
        && (!word(right) || text[range.end..].chars().next().is_none_or(|ch| !word(ch)))
}
fn missing(node: &mut Node) {
    let mut fields = Vec::new();
    if node.verification == Verification::Dismissed {
        node.missing_prerequisites = fields;
        return;
    }
    if node.verification == Verification::NeedsAuthorReview {
        fields.push("classification_review".into());
        if !node.entity_candidates.is_empty() {
            fields.push("entity_review".into());
        }
        let mut candidates: BTreeMap<(usize, usize), usize> = BTreeMap::new();
        for item in &node.entity_candidates {
            *candidates
                .entry((item.source_ref.byte_start, item.source_ref.byte_end))
                .or_default() += 1;
        }
        if candidates.values().any(|count| *count > 1) {
            fields.push("ambiguous_name".into());
        }
    }
    if node.location_ref.is_none() {
        fields.push("location".into());
    }
    if node.time_ref.is_none() {
        fields.push("story_time".into());
    }
    if node.kind == Kind::Dialogue && node.speaker_ref.is_none() {
        fields.push("speaker".into());
    }
    node.missing_prerequisites = fields;
}
fn build_node(
    document: &Document,
    spec: parser::Spec,
    candidates: Vec<EntityCandidate>,
    dictionary: &Dictionary,
) -> Node {
    let locations = candidates
        .iter()
        .filter(|c| c.kind == "location")
        .map(|c| c.entity_ref.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(200)
        .collect();
    let mut speaker_candidates = Vec::new();
    let mut unresolved = Vec::new();
    if let Some(range) = spec.speaker {
        let name = document.content[range.clone()].trim();
        if spec.method == Method::FountainDialogue && name.is_ascii() {
            // Fountain 人物提示用大写；它不能迫使设定集把 Ann 改名为 ANN。
            speaker_candidates = dictionary
                .entries
                .iter()
                .filter(|(entry, _)| entry.eq_ignore_ascii_case(name))
                .flat_map(|(_, entries)| entries)
                .filter(|(_, kind)| kind == "character")
                .map(|(reference, _)| reference.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .take(200)
                .collect();
        } else if let Some(entries) = dictionary.entries.get(name) {
            speaker_candidates = entries
                .iter()
                .filter(|(_, kind)| kind == "character")
                .map(|(reference, _)| reference.clone())
                .take(200)
                .collect();
        }
        if speaker_candidates.is_empty() && !name.is_empty() && name.chars().count() <= 200 {
            unresolved.push(UnresolvedName {
                kind: "character".into(),
                name: name.into(),
                source_ref: document.reference(range),
            });
        }
    }
    let mut node = Node {
        node_id: id("node"),
        kind: spec.kind,
        source_refs: vec![document.reference(spec.range)],
        entity_refs: Vec::new(),
        entity_candidates: candidates,
        location_ref: None,
        location_candidates: locations,
        time_ref: None,
        speaker_ref: None,
        speaker_candidates,
        time_of_day: spec.time_of_day,
        unresolved_names: unresolved,
        verification: Verification::NeedsAuthorReview,
        extraction_method: spec.method,
        missing_prerequisites: Vec::new(),
        annotation: None,
    };
    missing(&mut node);
    node
}
fn stop(plot: &mut Plot, source: &SourceRevision, at: usize, reason: &str) {
    plot.coverage.status = "partial".into();
    plot.coverage.budget_stop = Some(BudgetStop {
        document_id: source.document_id.clone(),
        revision_id: source.revision_id.clone(),
        byte_offset: at,
        reason: reason.into(),
    });
}
pub fn extract(
    documents: &[Document],
    blueprint: &Value,
    blueprint_sha: &str,
    options: Options,
    actor: &str,
) -> Result<Plot> {
    let started = Instant::now();
    let deadline = started + Duration::from_millis(options.max_duration_ms);
    let dictionary = Dictionary::new(blueprint)?;
    let sources: Vec<_> = documents.iter().map(|d| d.source.clone()).collect();
    let mut plot = Plot {
        schema_version: "1.0.0".into(),
        plot_revision_id: id("plotrev"),
        parent_plot_revision_id: None,
        blueprint_revision: blueprint["revision"].as_u64().unwrap(),
        blueprint_sha256: blueprint_sha.into(),
        source_revisions: sources.clone(),
        engine_version: "1.0.0".into(),
        options,
        nodes: Vec::new(),
        edges: Vec::new(),
        coverage: Coverage {
            status: "complete".into(),
            requested_refs: sources,
            scanned_ranges: Vec::new(),
            scanned_bytes: 0,
            unparsed_ranges: Vec::new(),
            budget_stop: None,
        },
        created_at: now(),
        actor_ref: actor.into(),
    };
    let mut remaining_matches = plot.options.max_matches;
    let mut output_bytes = 128 * 1024;
    'documents: for document in documents {
        let remaining = plot
            .options
            .max_bytes
            .saturating_sub(plot.coverage.scanned_bytes);
        let mut limit = remaining.min(document.content.len());
        while !document.content.is_char_boundary(limit) {
            limit -= 1;
        }
        if Instant::now() >= deadline {
            stop(&mut plot, &document.source, 0, "max_duration");
            break;
        }
        if limit == 0 && !document.content.is_empty() {
            stop(&mut plot, &document.source, 0, "max_bytes");
            break;
        }
        let prefix = &document.content[..limit];
        let parsed = parser::parse(prefix, &document.source.source_format, deadline);
        let mut scanned_until = 0;
        let mut previous_node: Option<String> = None;
        for block in &parsed.blocks {
            if Instant::now() >= deadline {
                stop(
                    &mut plot,
                    &document.source,
                    block.range.start,
                    "max_duration",
                );
                break;
            }
            scanned_until = block.range.end;
            if block.range.len() > QUOTE_LIMIT {
                let skip = UnparsedRange {
                    range: source_range(&document.source, block.range.clone()),
                    reason: "segment_too_large".into(),
                };
                output_bytes += serde_json::to_vec(&skip)?.len() + 8;
                if output_bytes > OUTPUT_LIMIT || plot.coverage.unparsed_ranges.len() >= 19_000 {
                    stop(&mut plot, &document.source, block.range.start, "max_output");
                    break;
                }
                plot.coverage.unparsed_ranges.push(skip);
                continue;
            }
            let (specs, skips) = parser::specs(prefix, &parsed, block);
            let no_signal = specs.is_empty();
            for spec in specs {
                if plot.nodes.len() >= plot.options.max_nodes {
                    stop(&mut plot, &document.source, spec.range.start, "max_nodes");
                    break;
                }
                let candidates = match dictionary.matches(
                    &parsed.mask[spec.range.clone()],
                    spec.range.start,
                    document,
                    &mut remaining_matches,
                    deadline,
                ) {
                    Ok(candidates) => candidates,
                    Err(reason) => {
                        stop(&mut plot, &document.source, spec.range.start, reason);
                        break;
                    }
                };
                let node = build_node(document, spec, candidates, &dictionary);
                let edge = previous_node.as_ref().map(|previous| Edge {
                    edge_id: id("edge"),
                    from_node_id: previous.clone(),
                    to_node_id: node.node_id.clone(),
                    relation: "narrative_next".into(),
                    verification: Verification::NeedsAuthorReview,
                    source_refs: node.source_refs.clone(),
                });
                let needed = serde_json::to_vec(&node)?.len()
                    + edge
                        .as_ref()
                        .map(|e| serde_json::to_vec(e).unwrap().len())
                        .unwrap_or(0)
                    + 16;
                if output_bytes + needed > OUTPUT_LIMIT {
                    stop(
                        &mut plot,
                        &document.source,
                        node.source_refs[0].byte_start,
                        "max_output",
                    );
                    break;
                }
                output_bytes += needed;
                previous_node = Some(node.node_id.clone());
                if let Some(edge) = edge {
                    plot.edges.push(edge);
                }
                plot.nodes.push(node);
            }
            if plot.coverage.budget_stop.is_some() {
                break;
            }
            for skip in skips.into_iter().chain(no_signal.then_some(parser::Skip {
                range: block.range.clone(),
                reason: "no_structural_signal",
            })) {
                let skipped = UnparsedRange {
                    range: source_range(&document.source, skip.range),
                    reason: skip.reason.into(),
                };
                let needed = serde_json::to_vec(&skipped)?.len() + 8;
                if output_bytes + needed > OUTPUT_LIMIT
                    || plot.coverage.unparsed_ranges.len() >= 19_000
                {
                    stop(&mut plot, &document.source, block.range.start, "max_output");
                    break;
                }
                output_bytes += needed;
                plot.coverage.unparsed_ranges.push(skipped);
            }
            scanned_until = block.range.end;
            if output_bytes > OUTPUT_LIMIT || plot.coverage.unparsed_ranges.len() >= 19_000 {
                stop(&mut plot, &document.source, scanned_until, "max_output");
                break;
            }
        }
        let scanned = if let Some(stopped) = &plot.coverage.budget_stop {
            scanned_until.max(stopped.byte_offset).min(limit)
        } else if let Some(at) = parsed.stopped_at {
            stop(&mut plot, &document.source, at, "max_duration");
            scanned_until.max(at)
        } else {
            limit
        };
        for skip in parsed.skipped {
            if skip.range.end <= scanned && plot.coverage.unparsed_ranges.len() < 20_000 {
                let skipped = UnparsedRange {
                    range: source_range(&document.source, skip.range),
                    reason: skip.reason.into(),
                };
                let needed = serde_json::to_vec(&skipped)?.len() + 8;
                if output_bytes + needed > OUTPUT_LIMIT {
                    stop(&mut plot, &document.source, scanned, "max_output");
                    break;
                }
                output_bytes += needed;
                plot.coverage.unparsed_ranges.push(skipped);
            }
        }
        plot.coverage
            .scanned_ranges
            .push(source_range(&document.source, 0..scanned));
        plot.coverage.scanned_bytes += scanned;
        if plot.coverage.budget_stop.is_some() {
            break 'documents;
        }
        if limit < document.content.len() {
            stop(&mut plot, &document.source, limit, "max_bytes");
            break;
        }
    }
    ensure(
        serde_json::to_vec(&plot)?.len() <= OUTPUT_LIMIT,
        "hetu.budget_exceeded",
        "剧情输出超过序列化预算，请减小提取范围。",
    )?;
    validate(&plot, blueprint, documents)?;
    Ok(plot)
}

fn entity_sets(blueprint: &Value) -> BTreeMap<&str, &str> {
    let mut result = BTreeMap::new();
    for (section, key, kind) in [
        ("characters", "character_id", "character"),
        ("factions", "faction_id", "faction"),
        ("locations", "location_id", "location"),
        ("timeline", "event_id", "event"),
    ] {
        for entity in blueprint[section].as_array().unwrap() {
            result.insert(entity[key].as_str().unwrap(), kind);
        }
    }
    result
}
pub fn check_reference(source: &SourceRef, documents: &[Document]) -> Result<()> {
    let document = documents
        .iter()
        .find(|d| {
            d.source.document_id == source.document_id && d.source.revision_id == source.revision_id
        })
        .ok_or_else(|| {
            Error::new(
                "hetu.invalid_source_ref",
                "剧情证据不属于此提取修订的原文。",
            )
        })?;
    ensure(
        source.byte_start < source.byte_end
            && source.byte_end - source.byte_start <= QUOTE_LIMIT
            && document.content.get(source.byte_start..source.byte_end)
                == Some(source.quote.as_str()),
        "hetu.invalid_source_ref",
        "剧情证据必须引用固定原文修订中的完整 UTF-8 字符范围。",
    )
}
pub fn validate(plot: &Plot, blueprint: &Value, documents: &[Document]) -> Result<()> {
    let value = serde_json::to_value(plot)?;
    decode(&value)?;
    ensure(
        plot.blueprint_revision == blueprint["revision"].as_u64().unwrap()
            && plot.source_revisions
                == documents
                    .iter()
                    .map(|d| d.source.clone())
                    .collect::<Vec<_>>()
            && plot.coverage.requested_refs == plot.source_revisions,
        "hetu.integrity_failure",
        "剧情输入快照不一致。",
    )?;
    let entities = entity_sets(blueprint);
    let mut node_ids = BTreeSet::new();
    for node in &plot.nodes {
        ensure(
            node_ids.insert(node.node_id.as_str()),
            "hetu.integrity_failure",
            "剧情节点标识重复。",
        )?;
        let mut seen = BTreeSet::new();
        for reference in &node.entity_refs {
            ensure(
                seen.insert(reference)
                    && matches!(
                        entities.get(reference.as_str()),
                        Some(&"character" | &"faction")
                    ),
                "hetu.reference_in_use",
                "剧情人物或势力引用无效或重复。",
            )?;
        }
        for (reference, kind) in [
            (&node.location_ref, "location"),
            (&node.time_ref, "event"),
            (&node.speaker_ref, "character"),
        ] {
            if let Some(reference) = reference {
                ensure(
                    entities.get(reference.as_str()) == Some(&kind),
                    "hetu.reference_in_use",
                    "剧情地点、时间或说话人不属于固定设定集。",
                )?;
            }
        }
        if let Some(speaker) = &node.speaker_ref {
            ensure(
                node.kind == Kind::Dialogue && node.entity_refs.contains(speaker),
                "invalid_input",
                "说话人必须是对白节点中已确认出场的人物。",
            )?;
        }
        if let Some(annotation) = &node.annotation {
            let mut assertions = BTreeSet::new();
            for fact in &annotation.facts {
                ensure(
                    node.entity_refs.contains(&fact.subject_ref)
                        && entities.get(fact.subject_ref.as_str()) == Some(&"character")
                        && assertions.insert((&fact.subject_ref, &fact.predicate)),
                    "invalid_input",
                    "事实标注必须属于节点关联人物，同一人物的谓词不能重复。",
                )?;
                if fact.predicate == "primary_faction" {
                    ensure(
                        entities.get(fact.value.as_str().unwrap()) == Some(&"faction"),
                        "hetu.reference_in_use",
                        "事实标注关联的势力不存在。",
                    )?;
                }
                if fact.predicate == "identity" {
                    ensure(
                        !fact.value.as_str().unwrap().trim().is_empty(),
                        "invalid_input",
                        "身份断言不能为空。",
                    )?;
                }
            }
            ensure(
                annotation.capabilities.iter().all(|s| !s.trim().is_empty()),
                "invalid_input",
                "能力标注不能只含空白。",
            )?;
        }
        for source in &node.source_refs {
            check_reference(source, documents)?;
        }
        for candidate in &node.entity_candidates {
            ensure(
                entities.get(candidate.entity_ref.as_str()) == Some(&candidate.kind.as_str())
                    && candidate.matched_text == candidate.source_ref.quote,
                "hetu.integrity_failure",
                "剧情候选的实体类型或原文不一致。",
            )?;
            check_reference(&candidate.source_ref, documents)?;
        }
        for reference in &node.location_candidates {
            ensure(
                entities.get(reference.as_str()) == Some(&"location"),
                "hetu.reference_in_use",
                "候选地点不存在。",
            )?;
        }
        for reference in &node.speaker_candidates {
            ensure(
                entities.get(reference.as_str()) == Some(&"character"),
                "hetu.reference_in_use",
                "候选说话人不存在。",
            )?;
        }
        for unresolved in &node.unresolved_names {
            check_reference(&unresolved.source_ref, documents)?;
        }
        let mut expected = node.clone();
        missing(&mut expected);
        ensure(
            expected.missing_prerequisites == node.missing_prerequisites,
            "hetu.integrity_failure",
            "剧情节点的缺失信息与确认状态不一致。",
        )?;
    }
    let mut edge_ids = BTreeSet::new();
    let mut causal: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for edge in &plot.edges {
        ensure(
            edge_ids.insert(edge.edge_id.as_str())
                && edge.from_node_id != edge.to_node_id
                && node_ids.contains(edge.from_node_id.as_str())
                && node_ids.contains(edge.to_node_id.as_str()),
            "invalid_input",
            "剧情连线的端点或标识无效。",
        )?;
        for source in &edge.source_refs {
            check_reference(source, documents)?;
        }
        if edge.relation == "causes" && edge.verification == Verification::Confirmed {
            causal
                .entry(&edge.from_node_id)
                .or_default()
                .push(&edge.to_node_id);
        }
    }
    let mut degrees: BTreeMap<&str, usize> = node_ids.iter().map(|id| (*id, 0)).collect();
    for targets in causal.values() {
        for target in targets {
            *degrees.get_mut(target).unwrap() += 1;
        }
    }
    let mut queue: Vec<_> = degrees
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut visited = 0;
    while let Some(node) = queue.pop() {
        visited += 1;
        if let Some(targets) = causal.get(node) {
            for target in targets {
                let count = degrees.get_mut(target).unwrap();
                *count -= 1;
                if *count == 0 {
                    queue.push(target);
                }
            }
        }
    }
    ensure(
        visited == node_ids.len(),
        "hetu.plot_cycle",
        "已确认的因果连线不能成环。",
    )?;
    let mut scanned = 0;
    let mut covered = BTreeSet::new();
    for range in &plot.coverage.scanned_ranges {
        let document = documents
            .iter()
            .find(|d| {
                d.source.document_id == range.document_id
                    && d.source.revision_id == range.revision_id
            })
            .ok_or_else(|| Error::new("hetu.integrity_failure", "覆盖范围引用了其他文档。"))?;
        ensure(
            covered.insert(&range.document_id)
                && range.byte_start == 0
                && range.byte_end <= document.content.len()
                && document.content.is_char_boundary(range.byte_end),
            "hetu.integrity_failure",
            "剧情覆盖范围无效。",
        )?;
        scanned += range.byte_end;
    }
    ensure(
        scanned == plot.coverage.scanned_bytes
            && (plot.coverage.status == "partial") == plot.coverage.budget_stop.is_some(),
        "hetu.integrity_failure",
        "剧情覆盖统计与预算终止状态不一致。",
    )?;
    for document in documents {
        ensure(
            digest(&document.content) == document.source.sha256
                && document.content.len() == document.source.size_bytes,
            "hetu.integrity_failure",
            "剧情源文件摘要或大小不一致。",
        )?;
    }
    if plot.coverage.status == "complete" {
        ensure(
            plot.coverage.scanned_ranges.len() == documents.len()
                && scanned == documents.iter().map(|d| d.content.len()).sum::<usize>(),
            "hetu.integrity_failure",
            "完整提取必须覆盖全部输入源码。",
        )?;
    }
    if let Some(stop) = &plot.coverage.budget_stop {
        let document = documents
            .iter()
            .find(|d| {
                d.source.document_id == stop.document_id && d.source.revision_id == stop.revision_id
            })
            .ok_or_else(|| Error::new("hetu.integrity_failure", "预算终止位置不属于输入修订。"))?;
        ensure(
            stop.byte_offset <= document.content.len()
                && document.content.is_char_boundary(stop.byte_offset),
            "hetu.integrity_failure",
            "预算终止位置必须位于原始 UTF-8 边界。",
        )?;
    }
    for node in &plot.nodes {
        if node.extraction_method != Method::AuthorAnnotation {
            for source in &node.source_refs {
                ensure(
                    plot.coverage.scanned_ranges.iter().any(|r| {
                        r.document_id == source.document_id
                            && r.revision_id == source.revision_id
                            && r.byte_start <= source.byte_start
                            && r.byte_end >= source.byte_end
                    }),
                    "hetu.integrity_failure",
                    "自动剧情节点超出已扫描范围。",
                )?;
            }
        }
    }
    for range in &plot.coverage.unparsed_ranges {
        let document = documents
            .iter()
            .find(|d| {
                d.source.document_id == range.range.document_id
                    && d.source.revision_id == range.range.revision_id
            })
            .ok_or_else(|| Error::new("hetu.integrity_failure", "未解析范围引用了其他文档。"))?;
        ensure(
            document
                .content
                .get(range.range.byte_start..range.range.byte_end)
                .is_some()
                && plot.coverage.scanned_ranges.iter().any(|r| {
                    r.document_id == range.range.document_id
                        && r.revision_id == range.range.revision_id
                        && r.byte_start <= range.range.byte_start
                        && r.byte_end >= range.range.byte_end
                }),
            "hetu.integrity_failure",
            "未解析范围必须位于已扫描源码的 UTF-8 边界。",
        )?;
    }
    Ok(())
}
pub fn correct(
    current: &Plot,
    corrections: &[Value],
    blueprint: &Value,
    documents: &[Document],
    actor: &str,
) -> Result<Plot> {
    let mut next = current.clone();
    let mut touched = BTreeSet::new();
    for correction in corrections {
        match correction["type"].as_str().unwrap() {
            "update_node" => {
                let reference = correction["node_id"].as_str().unwrap();
                ensure(
                    touched.insert(reference.to_owned()),
                    "invalid_input",
                    "同一批次只能校正一个节点一次。",
                )?;
                let node = next
                    .nodes
                    .iter_mut()
                    .find(|node| node.node_id == reference)
                    .ok_or_else(|| Error::new("not_found", "要校正的剧情节点不存在。"))?;
                update(node, correction)?;
            }
            "add_node" => {
                let source: SourceRef = serde_json::from_value(correction["source_ref"].clone())?;
                check_reference(&source, documents)?;
                let mut node = Node {
                    node_id: id("node"),
                    kind: Kind::Action,
                    source_refs: vec![source],
                    entity_refs: Vec::new(),
                    entity_candidates: Vec::new(),
                    location_ref: None,
                    location_candidates: Vec::new(),
                    time_ref: None,
                    speaker_ref: None,
                    speaker_candidates: Vec::new(),
                    time_of_day: TimeOfDay::Unknown,
                    unresolved_names: Vec::new(),
                    verification: Verification::NeedsAuthorReview,
                    extraction_method: Method::AuthorAnnotation,
                    missing_prerequisites: Vec::new(),
                    annotation: None,
                };
                update(&mut node, correction)?;
                next.nodes.push(node);
            }
            "add_edge" => next.edges.push(Edge {
                edge_id: id("edge"),
                from_node_id: correction["from_node_id"].as_str().unwrap().into(),
                to_node_id: correction["to_node_id"].as_str().unwrap().into(),
                relation: correction["relation"].as_str().unwrap().into(),
                verification: Verification::Confirmed,
                source_refs: serde_json::from_value(correction["source_refs"].clone())?,
            }),
            "remove_edge" => {
                let reference = correction["edge_id"].as_str().unwrap();
                ensure(
                    touched.insert(reference.to_owned()),
                    "invalid_input",
                    "同一连线不能重复移除。",
                )?;
                let index = next
                    .edges
                    .iter()
                    .position(|edge| edge.edge_id == reference)
                    .ok_or_else(|| Error::new("not_found", "要移除的剧情连线不存在。"))?;
                next.edges.remove(index);
            }
            _ => return Err(Error::new("invalid_input", "剧情校正类型无效。")),
        }
    }
    next.parent_plot_revision_id = Some(current.plot_revision_id.clone());
    next.plot_revision_id = id("plotrev");
    next.created_at = now();
    next.actor_ref = actor.into();
    validate(&next, blueprint, documents)?;
    ensure(
        serde_json::to_vec(&next)?.len() <= OUTPUT_LIMIT,
        "hetu.budget_exceeded",
        "剧情修订超过输出预算。",
    )?;
    Ok(next)
}
fn update(node: &mut Node, correction: &Value) -> Result<()> {
    node.kind = serde_json::from_value(correction["kind"].clone())?;
    node.entity_refs = serde_json::from_value(correction["entity_refs"].clone())?;
    node.location_ref = serde_json::from_value(correction["location_ref"].clone())?;
    node.time_ref = serde_json::from_value(correction["time_ref"].clone())?;
    node.speaker_ref = serde_json::from_value(correction["speaker_ref"].clone())?;
    node.time_of_day = serde_json::from_value(correction["time_of_day"].clone())?;
    node.verification = serde_json::from_value(correction["verification"].clone())?;
    if let Some(annotation) = correction.get("annotation") {
        node.annotation = serde_json::from_value(annotation.clone())?;
    }
    missing(node);
    Ok(())
}
pub fn summary(plot: &Plot, sha256: &str) -> Value {
    json!({"plot_revision_id":plot.plot_revision_id,"parent_plot_revision_id":plot.parent_plot_revision_id,"blueprint_revision":plot.blueprint_revision,"source_revisions":plot.source_revisions,"created_at":plot.created_at,"node_count":plot.nodes.len(),"confirmed_count":plot.nodes.iter().filter(|n| n.verification == Verification::Confirmed).count(),"coverage_status":plot.coverage.status,"sha256":sha256})
}
