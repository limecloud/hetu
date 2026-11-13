use super::{Error, Result, drama, ensure, id, now, plot};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

pub fn validate(value: &Value) -> Result<()> {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    let validator = VALIDATOR.get_or_init(|| {
        jsonschema::validator_for(
            &serde_json::from_str::<Value>(include_str!(
                "../../../contracts/schemas/drama-comparison.schema.json"
            ))
            .expect("comparison schema"),
        )
        .expect("comparison validator")
    });
    if let Some(error) = validator.iter_errors(value).next() {
        return Err(Error::new(
            "hetu.integrity_failure",
            format!("差异报告不符合合同：{}", error.instance_path),
        ));
    }
    Ok(())
}
pub fn compare(
    skeleton: &drama::Skeleton,
    sha: &str,
    plot: &plot::Plot,
    bp: &Value,
    sources: &[plot::SourceRevision],
    actor: &str,
) -> Result<Value> {
    ensure(
        sources.len() == skeleton.source_revisions.len()
            && sources
                .iter()
                .zip(&skeleton.source_revisions)
                .all(|(new, old)| new.document_id == old.document_id),
        "invalid_input",
        "对比原著必须按骨架输入顺序选择同一组文档的固定修订。",
    )?;
    let nodes = drama::ordered_nodes(plot);
    let by_id: BTreeMap<_, _> = plot.nodes.iter().map(|n| (n.node_id.as_str(), n)).collect();
    let ranks: BTreeMap<_, _> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.node_id.as_str(), i))
        .collect();
    let mut items = Vec::new();
    let mut mapped = BTreeSet::new();
    let mut sequence = Vec::new();
    for episode in &skeleton.episodes {
        for scene in &episode.scenes {
            mapped.extend(scene.plot_node_refs.iter().map(String::as_str));
            sequence.extend(scene.plot_node_refs.iter().map(|r| (r.as_str(), scene)));
        }
    }
    let original: Vec<_> = nodes
        .iter()
        .filter(|n| mapped.contains(n.node_id.as_str()))
        .map(|n| n.node_id.as_str())
        .collect();
    let expected_positions: BTreeMap<_, _> =
        original.iter().enumerate().map(|(i, r)| (*r, i)).collect();
    for (actual_position, (reference, scene)) in sequence.iter().enumerate() {
        let expected_position = expected_positions[reference];
        if actual_position != expected_position {
            items.push(json!({"kind":"reordered","scene_id":scene.scene_id,"plot_node_refs":[reference],"source_refs":nodes[ranks[reference]].source_refs,"details":{"expected_position":expected_position,"actual_position":actual_position}}));
        }
    }
    for node in nodes {
        if !mapped.contains(node.node_id.as_str()) {
            items.push(json!({"kind":"omitted","scene_id":null,"plot_node_refs":[node.node_id],"source_refs":node.source_refs,"details":{}}));
        }
    }
    for episode in &skeleton.episodes {
        for scene in &episode.scenes {
            if scene.plot_node_refs.is_empty() {
                items.push(json!({"kind":"added","scene_id":scene.scene_id,"plot_node_refs":[],"source_refs":[],"details":{"reason":"empty_scene"}}));
            } else {
                let derived = drama::derived_scene_from(scene.plot_node_refs.clone(), &by_id, bp)?;
                let mut fields = Vec::new();
                if scene.location_ref != derived.location_ref {
                    fields.push("location_ref");
                }
                if scene.interior_exterior != derived.interior_exterior {
                    fields.push("interior_exterior");
                }
                if scene.time_of_day != derived.time_of_day {
                    fields.push("time_of_day");
                }
                let chars: BTreeSet<_> = scene.character_refs.iter().collect();
                if chars != derived.character_refs.iter().collect() {
                    fields.push("character_refs");
                }
                if !fields.is_empty() {
                    items.push(json!({"kind":"modified","scene_id":scene.scene_id,"plot_node_refs":scene.plot_node_refs,"source_refs":scene.source_refs,"details":{"fields":fields}}));
                }
            }
        }
    }
    for range in &plot.coverage.unparsed_ranges {
        if !matches!(range.reason.as_str(), "code" | "html" | "fountain_metadata") {
            items.push(json!({"kind":"unmapped","scene_id":null,"plot_node_refs":[],"source_refs":[],"details":{"reason":"unparsed_text","source_range":range.range}}));
        }
    }
    for (old, new) in skeleton.source_revisions.iter().zip(sources) {
        if old != new {
            items.push(json!({"kind":"stale_source","scene_id":null,"plot_node_refs":[],"source_refs":[],"details":{"document_id":old.document_id,"original_revision_id":old.revision_id,"selected_revision_id":new.revision_id}}));
        }
    }
    let result = json!({"schema_version":"1.0.0","comparison_id":id("comparison"),"skeleton_ref":drama::reference(skeleton,sha),"source_revisions":sources,"status":skeleton.status,"items":items,"created_at":now(),"actor_ref":actor});
    ensure(
        serde_json::to_vec(&result)?.len() <= drama::OUTPUT_LIMIT,
        "hetu.budget_exceeded",
        "差异报告超过 16 MiB 预算。",
    )?;
    validate(&result)?;
    Ok(result)
}
