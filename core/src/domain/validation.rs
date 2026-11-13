use super::{Error, Result, blueprint::Chronology, ensure, id, now, plot};
use aho_corasick::AhoCorasickBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub const RULE_SET: &str = "1";
pub const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Options {
    pub max_bytes: usize,
    pub max_evaluations: usize,
    pub max_findings: usize,
    pub max_matches: usize,
    pub max_duration_ms: u64,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            max_bytes: 2 * 1024 * 1024,
            max_evaluations: 10_000,
            max_findings: 1000,
            max_matches: 20_000,
            max_duration_ms: 3000,
        }
    }
}
pub fn schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../contracts/schemas/validation-report.schema.json"
        ))
        .expect("embedded report schema")
    })
}
pub fn validate(value: &Value) -> Result<()> {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    let validator =
        VALIDATOR.get_or_init(|| jsonschema::validator_for(schema()).expect("report validator"));
    if let Some(error) = validator.iter_errors(value).next() {
        return Err(Error::new(
            "hetu.integrity_failure",
            format!("诊断报告不符合合同：{}", error.instance_path),
        ));
    }
    Ok(())
}
struct Engine {
    options: Options,
    deadline: Instant,
    findings: Vec<Value>,
    evaluations: Vec<Value>,
    stop: Option<String>,
    matches: usize,
    output_bytes: usize,
}
impl Engine {
    fn ready(&mut self) -> bool {
        if self.stop.is_none() {
            self.stop = if Instant::now() >= self.deadline {
                Some("max_duration".into())
            } else if self.evaluations.len() >= self.options.max_evaluations {
                Some("max_evaluations".into())
            } else if self.findings.len() >= self.options.max_findings {
                Some("max_findings".into())
            } else {
                None
            };
        }
        self.stop.is_none()
    }
    fn record(
        &mut self,
        rule: &Value,
        unit: &str,
        outcome: Outcome,
        sources: &[plot::SourceRef],
    ) -> Result<()> {
        if !self.ready() {
            return Ok(());
        }
        let evaluation = json!({"rule_id":rule["rule_id"],"unit_ref":unit,"status":outcome.status,"missing_prerequisites":outcome.missing});
        let finding = outcome.message.map(|message| json!({
            "finding_id":id("finding"),"rule_id":rule["rule_id"],"rule_revision":rule["revision"],
            "severity":match outcome.certainty { "advisory" => json!("info"), "heuristic" => json!("warning"), _ => rule["severity"].clone() },
            "certainty":outcome.certainty,"message_key":message,"source_refs":sources,
            "blueprint_refs":outcome.refs,"evidence":outcome.evidence,"missing_prerequisites":outcome.missing,
            "disposition":"open","exception_policy":rule["exception_policy"]
        }));
        let size = serde_json::to_vec(&evaluation)?.len()
            + finding.as_ref().map_or(0, |f| {
                serde_json::to_vec(f).map_or(OUTPUT_LIMIT, |v| v.len())
            });
        if self.output_bytes.saturating_add(size) > OUTPUT_LIMIT - 1024 * 1024 {
            self.stop = Some("max_output".into());
            return Ok(());
        }
        self.output_bytes += size;
        self.evaluations.push(evaluation);
        if let Some(finding) = finding {
            self.findings.push(finding);
        }
        Ok(())
    }
}
struct Outcome {
    status: &'static str,
    certainty: &'static str,
    message: Option<&'static str>,
    missing: Vec<String>,
    evidence: Value,
    refs: Vec<String>,
}
impl Outcome {
    fn pass() -> Self {
        Self {
            status: "passed",
            certainty: "certain",
            message: None,
            missing: vec![],
            evidence: json!({}),
            refs: vec![],
        }
    }
    fn na() -> Self {
        Self {
            status: "not_applicable",
            ..Self::pass()
        }
    }
    fn unknown(reason: &str) -> Self {
        Self {
            status: "unknown",
            certainty: "unknown",
            message: Some("validation.prerequisites"),
            missing: vec![reason.into()],
            ..Self::pass()
        }
    }
    fn finding(message: &'static str, evidence: Value, refs: Vec<String>) -> Self {
        Self {
            status: "finding",
            message: Some(message),
            evidence,
            refs,
            ..Self::pass()
        }
    }
}
fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().expect("validated field")
}
fn rows<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().expect("validated array")
}
fn package(document: &plot::Document) -> &str {
    &document.package
}
fn document_scope(rule: &Value, document: &plot::Document) -> bool {
    let scope = &rule["scope"];
    rows(scope, "packages")
        .iter()
        .any(|p| p == package(document))
        && (rows(scope, "document_ids").is_empty()
            || rows(scope, "document_ids").iter().any(|d| {
                d == &document.source.document_id
                    || document
                        .scope_document_id
                        .as_deref()
                        .is_some_and(|target| d == target)
            }))
}
fn node_entities(node: &plot::Node) -> impl Iterator<Item = &str> {
    node.entity_refs
        .iter()
        .map(String::as_str)
        .chain(node.location_ref.as_deref())
        .chain(node.time_ref.as_deref())
}
fn node_scope(rule: &Value, node: &plot::Node) -> Option<bool> {
    let refs = rows(&rule["scope"], "entity_refs");
    if refs.is_empty() {
        return Some(true);
    }
    if node.verification != plot::Verification::Confirmed {
        return None;
    }
    Some(refs.iter().any(|r| node_entities(node).any(|id| r == id)))
}
fn actual(node: &plot::Node) -> Option<Outcome> {
    if node.verification != plot::Verification::Confirmed {
        return Some(Outcome::unknown("author_confirmation"));
    }
    match node.annotation.as_ref().map(|a| a.context.as_str()) {
        None | Some("unknown") => Some(Outcome::unknown("statement_context")),
        Some("actual") => None,
        _ => Some(Outcome::na()),
    }
}
fn node_rule(
    rule: &Value,
    node: &plot::Node,
    bp: &Value,
    chronology: &mut Chronology,
) -> Result<Outcome> {
    if node.verification == plot::Verification::Dismissed {
        return Ok(Outcome::na());
    }
    match node_scope(rule, node) {
        Some(false) => return Ok(Outcome::na()),
        None => return Ok(Outcome::unknown("scope_entities")),
        _ => (),
    }
    let parameters = &rule["parameters"];
    match s(rule, "type") {
        "required_reference" => {
            if node.verification != plot::Verification::Confirmed {
                return Ok(Outcome::unknown("author_confirmation"));
            }
            let missing: Vec<_> = rows(parameters, "entity_types")
                .iter()
                .filter_map(|kind| {
                    let kind = kind.as_str().unwrap();
                    let present = if kind == "location" {
                        node.location_ref.is_some()
                    } else {
                        node.entity_refs
                            .iter()
                            .any(|r| r.starts_with(&format!("{kind}_")))
                    };
                    (!present).then(|| kind.to_owned())
                })
                .collect();
            if missing.is_empty() {
                Ok(Outcome::pass())
            } else {
                let mut out = Outcome::unknown("required_references");
                out.evidence = json!({"missing_entity_types":missing});
                Ok(out)
            }
        }
        "fact_equals" => {
            if let Some(out) = actual(node) {
                return Ok(out);
            }
            let Some(time) = &node.time_ref else {
                return Ok(Outcome::unknown("story_time"));
            };
            let annotation = node.annotation.as_ref().unwrap();
            let assertions: Vec<_> = annotation
                .facts
                .iter()
                .filter(|a| {
                    rows(parameters, "predicates")
                        .iter()
                        .any(|p| p == &a.predicate)
                })
                .collect();
            if assertions.is_empty() {
                return Ok(Outcome::unknown("fact_assertions"));
            }
            let mut unknown = false;
            let mut conflicts = Vec::new();
            let mut refs = Vec::new();
            for assertion in assertions {
                let character = rows(bp, "characters")
                    .iter()
                    .find(|c| c["character_id"] == assertion.subject_ref)
                    .unwrap();
                let mut found = false;
                for fact in rows(character, "facts")
                    .iter()
                    .filter(|f| f["predicate"] == assertion.predicate)
                {
                    let inside = chronology.before(s(fact, "valid_from"), time, true)?
                        && fact
                            .get("valid_to")
                            .and_then(Value::as_str)
                            .map_or(Ok(true), |end| chronology.before(time, end, false))?;
                    if inside {
                        found = true;
                        if fact["value"] != assertion.value {
                            conflicts.push(json!({"subject_ref":assertion.subject_ref,"predicate":assertion.predicate,"asserted_value":assertion.value,"expected_value":fact["value"],"fact_id":fact["fact_id"],"at_event":time}));
                            refs.push(s(fact, "fact_id").into());
                        }
                    }
                }
                unknown |= !found;
            }
            if !conflicts.is_empty() {
                let mut out = Outcome::finding(
                    "validation.fact_conflict",
                    json!({"conflicts":conflicts}),
                    refs,
                );
                if unknown {
                    out.missing.push("applicable_facts".into());
                }
                Ok(out)
            } else if unknown {
                Ok(Outcome::unknown("applicable_facts"))
            } else {
                Ok(Outcome::pass())
            }
        }
        "world_constraint" => {
            if let Some(out) = actual(node) {
                return Ok(out);
            }
            let Some(location) = &node.location_ref else {
                return Ok(Outcome::unknown("location"));
            };
            if parameters["location_ref"] != *location {
                return Ok(Outcome::na());
            }
            let capability = s(parameters, "forbidden_capability");
            if node
                .annotation
                .as_ref()
                .unwrap()
                .capabilities
                .iter()
                .any(|c| c == capability)
            {
                Ok(Outcome::finding(
                    "validation.world_conflict",
                    json!({"location_ref":location,"forbidden_capability":capability}),
                    vec![location.clone()],
                ))
            } else {
                Ok(Outcome::pass())
            }
        }
        "advisory" => Ok(Outcome {
            certainty: "advisory",
            ..Outcome::finding(
                "validation.advisory",
                json!({"text":parameters["text"]}),
                vec![],
            )
        }),
        _ => unreachable!("separate rule family"),
    }
}

pub fn run(
    plot: &plot::Plot,
    bp: &Value,
    documents: &[plot::Document],
    plot_sha: &str,
    options: Options,
    actor: &str,
) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_millis(options.max_duration_ms);
    let mut engine = Engine {
        options,
        deadline,
        findings: vec![],
        evaluations: vec![],
        stop: None,
        matches: 0,
        output_bytes: 0,
    };
    let mut scanned = Vec::new();
    let mut unparsed = Vec::new();
    let mut masks = Vec::new();
    let mut scanned_bytes = 0;
    let mut source_stop = None;
    for document in documents {
        let limit = engine
            .options
            .max_bytes
            .saturating_sub(scanned_bytes)
            .min(document.content.len());
        let mut end = limit;
        while !document.content.is_char_boundary(end) {
            end -= 1;
        }
        if end == 0 && !document.content.is_empty() {
            source_stop = Some("max_bytes");
            break;
        }
        let parsed = plot::parser::parse(
            &document.content[..end],
            &document.source.source_format,
            deadline,
        );
        let coverage_limit = parsed.skipped.get(10_000).map(|s| s.range.start);
        let covered = parsed
            .stopped_at
            .unwrap_or(end)
            .min(coverage_limit.unwrap_or(end));
        scanned.push(json!({"document_id":document.source.document_id,"revision_id":document.source.revision_id,"byte_start":0,"byte_end":covered}));
        for skip in parsed.skipped {
            if skip.range.end <= covered {
                unparsed.push(json!({"document_id":document.source.document_id,"revision_id":document.source.revision_id,"byte_start":skip.range.start,"byte_end":skip.range.end,"reason":skip.reason}));
            }
        }
        scanned_bytes += covered;
        masks.push((document, parsed.mask[..covered].to_owned()));
        if covered < document.content.len() {
            source_stop = Some(if coverage_limit.is_some() {
                "max_output"
            } else if parsed.stopped_at.is_some() {
                "max_duration"
            } else {
                "max_bytes"
            });
            break;
        }
    }
    engine.output_bytes = serde_json::to_vec(
        &json!({"unparsed":unparsed,"plot_coverage":plot.coverage,"scanned":scanned}),
    )?
    .len();
    let mut chronology = Chronology::from_blueprint(bp)?;
    let rules = rows(bp, "rules");
    let mut executed = BTreeSet::new();
    for rule in rules {
        if !engine.ready() {
            break;
        }
        let before = engine.evaluations.len();
        if !documents.iter().any(|d| document_scope(rule, d)) {
            engine.record(rule, "selection", Outcome::na(), &[])?;
            executed.insert(s(rule, "rule_id").to_owned());
            continue;
        }
        match s(rule, "type") {
            "forbidden_term" => term_rule(&mut engine, rule, plot, &masks)?,
            "event_precedes" => event_rule(&mut engine, rule, plot, documents)?,
            _ => {
                let mut had_unit = false;
                for node in &plot.nodes {
                    if !engine.ready() {
                        break;
                    }
                    let applicable = documents.iter().any(|d| {
                        node.source_refs
                            .iter()
                            .any(|r| r.document_id == d.source.document_id)
                            && document_scope(rule, d)
                    });
                    if !applicable {
                        continue;
                    }
                    had_unit = true;
                    match node_rule(rule, node, bp, &mut chronology) {
                        Ok(outcome) => {
                            engine.record(rule, &node.node_id, outcome, &node.source_refs)?
                        }
                        Err(error) if error.code == "hetu.budget_exceeded" => {
                            engine.stop = Some("chronology_budget".into());
                            break;
                        }
                        Err(error) => return Err(error),
                    }
                }
                if !had_unit {
                    engine.record(rule, "selection", Outcome::unknown("plot_nodes"), &[])?;
                }
            }
        }
        if engine.evaluations.len() > before {
            executed.insert(s(rule, "rule_id").to_owned());
        }
    }
    let before = engine.evaluations.len();
    adaptation(&mut engine, plot, &masks)?;
    if engine.evaluations.len() > before {
        executed.insert("builtin.adaptation".into());
    }
    if engine.stop.is_none() {
        engine.stop = source_stop.map(String::from);
    }
    if engine.stop.is_none() && plot.coverage.status == "partial" {
        engine.stop = Some("plot_partial".into());
    }
    let status = if engine.stop.is_some() {
        "partial"
    } else {
        "complete"
    };
    let counts = ["passed", "finding", "unknown", "not_applicable"]
        .into_iter()
        .map(|status| {
            (
                status.to_owned(),
                json!(
                    engine
                        .evaluations
                        .iter()
                        .filter(|e| e["status"] == status)
                        .count()
                ),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let report = json!({"schema_version":"1.0.0","report_id":id("report"),"input_snapshot":{"plot_revision_id":plot.plot_revision_id,"plot_sha256":plot_sha,"blueprint_revision":plot.blueprint_revision,"blueprint_sha256":plot.blueprint_sha256,"source_revisions":plot.source_revisions},"rule_set_version":RULE_SET,"engine_build":env!("CARGO_PKG_VERSION"),"options":engine.options,"status":status,
        "coverage":{"requested_refs":plot.source_revisions,"scanned_ranges":scanned,"scanned_bytes":scanned_bytes,"unparsed_ranges":unparsed,"plot_coverage":plot.coverage,"enabled_rules":rules.iter().map(|r| &r["rule_id"]).chain(std::iter::once(&json!("builtin.adaptation"))).collect::<Vec<_>>(),"executed_rules":executed,"evaluations":engine.evaluations,"counts":counts,"budget_stop":engine.stop},
        "findings":engine.findings,"created_at":now(),"actor_ref":actor});
    validate(&report)?;
    ensure(
        serde_json::to_vec(&report)?.len() <= OUTPUT_LIMIT,
        "hetu.budget_exceeded",
        "诊断报告超过输出上限。",
    )?;
    Ok(report)
}

fn term_rule(
    engine: &mut Engine,
    rule: &Value,
    plot: &plot::Plot,
    masks: &[(&plot::Document, String)],
) -> Result<()> {
    let parameters = &rule["parameters"];
    let terms: Vec<_> = rows(parameters, "terms")
        .iter()
        .map(|t| t.as_str().unwrap())
        .collect();
    let exceptions: Vec<_> = rows(parameters, "exceptions")
        .iter()
        .map(|t| t.as_str().unwrap())
        .collect();
    let matcher = AhoCorasickBuilder::new()
        .ascii_case_insensitive(parameters["case_sensitive"] == false)
        .build(&terms)
        .map_err(|_| Error::new("hetu.budget_exceeded", "词条匹配器超过预算。"))?;
    let exception_matcher = if exceptions.is_empty() {
        None
    } else {
        Some(
            AhoCorasickBuilder::new()
                .ascii_case_insensitive(parameters["case_sensitive"] == false)
                .build(&exceptions)
                .map_err(|_| Error::new("hetu.budget_exceeded", "例外匹配器超过预算。"))?,
        )
    };
    for (document, mask) in masks {
        if !engine.ready() {
            break;
        }
        if !document_scope(rule, document) {
            continue;
        }
        let mut exception_ranges = Vec::new();
        if let Some(matcher) = &exception_matcher {
            for hit in matcher.find_overlapping_iter(mask) {
                engine.matches += 1;
                if engine.matches > engine.options.max_matches {
                    engine.stop = Some("max_matches".into());
                    break;
                }
                if !engine.ready() {
                    break;
                }
                exception_ranges.push(hit.start()..hit.end());
            }
        }
        let scoped = !rows(&rule["scope"], "entity_refs").is_empty();
        let nodes: Vec<_> = plot
            .nodes
            .iter()
            .filter(|n| {
                n.verification != plot::Verification::Dismissed && node_scope(rule, n) == Some(true)
            })
            .collect();
        let mut hit_count = 0;
        for hit in matcher.find_overlapping_iter(mask) {
            if !engine.ready() {
                break;
            }
            engine.matches += 1;
            if engine.matches > engine.options.max_matches {
                engine.stop = Some("max_matches".into());
                break;
            }
            if exception_ranges
                .iter()
                .any(|r| r.start <= hit.start() && r.end >= hit.end())
            {
                continue;
            }
            if scoped
                && !nodes.iter().any(|n| {
                    n.source_refs.iter().any(|r| {
                        r.document_id == document.source.document_id
                            && r.byte_start <= hit.start()
                            && r.byte_end >= hit.end()
                    })
                })
            {
                continue;
            }
            hit_count += 1;
            let source = document.reference(hit.start()..hit.end());
            engine.record(rule,&document.source.document_id,Outcome::finding("validation.forbidden_term",json!({"term":terms[hit.pattern().as_usize()],"case_mode":if parameters["case_sensitive"] == true {"literal"} else {"ascii_case_insensitive"}}),vec![]),&[source])?;
        }
        if hit_count == 0 && engine.ready() {
            engine.record(
                rule,
                &document.source.document_id,
                if scoped {
                    Outcome::unknown("scope_text_coverage")
                } else if mask.len() < document.content.len() {
                    Outcome::unknown("source_scan")
                } else {
                    Outcome::pass()
                },
                &[],
            )?;
        } else if scoped && engine.ready() {
            engine.record(
                rule,
                &document.source.document_id,
                Outcome::unknown("scope_text_coverage"),
                &[],
            )?;
        }
    }
    Ok(())
}
fn event_rule(
    engine: &mut Engine,
    rule: &Value,
    plot: &plot::Plot,
    documents: &[plot::Document],
) -> Result<()> {
    let mut evaluated = false;
    for edge in plot
        .edges
        .iter()
        .filter(|e| e.relation == "story_before" && e.verification == plot::Verification::Confirmed)
    {
        if !engine.ready() {
            break;
        }
        let from = plot
            .nodes
            .iter()
            .find(|n| n.node_id == edge.from_node_id)
            .unwrap();
        let to = plot
            .nodes
            .iter()
            .find(|n| n.node_id == edge.to_node_id)
            .unwrap();
        if ![from, to].iter().all(|n| {
            documents.iter().any(|d| {
                n.source_refs
                    .iter()
                    .any(|r| r.document_id == d.source.document_id)
                    && document_scope(rule, d)
            })
        }) {
            continue;
        }
        evaluated = true;
        let outcome = if from.verification == plot::Verification::Dismissed
            || to.verification == plot::Verification::Dismissed
            || node_scope(rule, from) == Some(false)
            || node_scope(rule, to) == Some(false)
        {
            Outcome::na()
        } else if node_scope(rule, from).is_none() || node_scope(rule, to).is_none() {
            Outcome::unknown("scope_entities")
        } else if let Some(outcome) = actual(from).or_else(|| actual(to)) {
            outcome
        } else if let (Some(left), Some(right)) = (&from.time_ref, &to.time_ref) {
            let p = &rule["parameters"];
            if p["before_event_id"] == *right && p["after_event_id"] == *left {
                Outcome::finding(
                    "validation.event_conflict",
                    json!({"asserted_before":left,"asserted_after":right}),
                    vec![left.clone(), right.clone()],
                )
            } else if p["before_event_id"] == *left && p["after_event_id"] == *right {
                Outcome::pass()
            } else {
                Outcome::na()
            }
        } else {
            Outcome::unknown("story_time")
        };
        engine.record(rule, &edge.edge_id, outcome, &edge.source_refs)?;
    }
    if !evaluated {
        engine.record(
            rule,
            "selection",
            Outcome::unknown("story_order_edges"),
            &[],
        )?;
    }
    Ok(())
}
fn adaptation(
    engine: &mut Engine,
    plot: &plot::Plot,
    masks: &[(&plot::Document, String)],
) -> Result<()> {
    let rule = json!({"rule_id":"builtin.adaptation","revision":1,"severity":"warning","exception_policy":"author_review"});
    for (document, mask) in masks {
        if !engine.ready() {
            break;
        }
        let terms = [
            "心想",
            "心中",
            "暗想",
            "觉得",
            "意识到",
            "thought",
            "wondered",
            "realized",
        ];
        let count: usize = terms.iter().map(|t| mask.matches(t).count()).sum();
        let chars = mask.chars().filter(|c| !c.is_whitespace()).count();
        let nodes: Vec<_> = plot
            .nodes
            .iter()
            .filter(|n| {
                n.verification != plot::Verification::Dismissed
                    && n.source_refs
                        .iter()
                        .any(|r| r.document_id == document.source.document_id)
            })
            .collect();
        let sources: Vec<_> = terms
            .iter()
            .filter_map(|term| {
                mask.find(term)
                    .map(|start| document.reference(start..start + term.len()))
            })
            .collect();
        let outcome = if count >= 3 && count.saturating_mul(1000) >= chars.saturating_mul(10) {
            Outcome {
                certainty: "heuristic",
                ..Outcome::finding(
                    "validation.mental_density",
                    json!({"marker_count":count,"non_whitespace_characters":chars,"minimum_markers":3,"threshold_per_1000_characters":10,"matched_terms":terms.iter().filter(|t| mask.contains(**t)).collect::<Vec<_>>()}),
                    vec![],
                )
            }
        } else {
            Outcome::na()
        };
        engine.record(&rule, &document.source.document_id, outcome, &sources)?;
        if !nodes.iter().any(|n| n.kind == plot::Kind::Scene) && !mask.trim().is_empty() {
            let mut outcome = Outcome::finding(
                "validation.scene_missing",
                json!({"scene_candidates":0}),
                vec![],
            );
            outcome.certainty = "heuristic";
            engine.record(&rule, &document.source.document_id, outcome, &[])?;
        }
    }
    Ok(())
}
