use super::{Error, Result, checked_id, ensure, id, now, plot};
use plot::{Kind, Node, Plot, SourceRef, SourceRevision, TimeOfDay, Verification};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

pub const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Options {
    pub episode_start_node_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scene {
    pub scene_id: String,
    pub scene_number: usize,
    pub title: String,
    pub location_ref: Option<String>,
    pub interior_exterior: String,
    pub time_of_day: TimeOfDay,
    pub character_refs: Vec<String>,
    pub adaptation_note: String,
    pub plot_node_refs: Vec<String>,
    pub source_refs: Vec<SourceRef>,
    pub missing_fields: Vec<String>,
    pub dialogue: String,
    pub shot_description: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Episode {
    pub episode_id: String,
    pub episode_number: usize,
    pub title: String,
    pub scenes: Vec<Scene>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Skeleton {
    pub schema_version: String,
    pub skeleton_id: String,
    pub revision: u64,
    pub previous_sha256: Option<String>,
    pub plot_revision_id: String,
    pub plot_sha256: String,
    pub blueprint_revision: u64,
    pub blueprint_sha256: String,
    pub source_revisions: Vec<SourceRevision>,
    pub engine_version: String,
    pub build_options: Options,
    pub status: String,
    pub episodes: Vec<Episode>,
    pub created_at: String,
    pub actor_ref: String,
}
pub fn schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../contracts/schemas/drama-skeleton.schema.json"
        ))
        .expect("embedded skeleton schema")
    })
}
pub fn decode(value: &Value) -> Result<Skeleton> {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    let validator =
        VALIDATOR.get_or_init(|| jsonschema::validator_for(schema()).expect("skeleton validator"));
    if let Some(error) = validator.iter_errors(value).next() {
        return Err(Error::new(
            "hetu.integrity_failure",
            format!("短剧骨架不符合合同：{}", error.instance_path),
        ));
    }
    Ok(serde_json::from_value(value.clone())?)
}
pub fn ordered_nodes(plot: &Plot) -> Vec<&Node> {
    let order: BTreeMap<_, _> = plot
        .source_revisions
        .iter()
        .enumerate()
        .map(|(i, s)| (s.document_id.as_str(), i))
        .collect();
    let mut nodes: Vec<_> = plot
        .nodes
        .iter()
        .filter(|n| n.verification != Verification::Dismissed)
        .collect();
    nodes.sort_by_key(|n| {
        let s = &n.source_refs[0];
        (
            order[s.document_id.as_str()],
            s.byte_start,
            s.byte_end,
            n.node_id.as_str(),
        )
    });
    nodes
}
fn empty_scene(refs: Vec<String>) -> Scene {
    Scene {
        scene_id: id("scene"),
        scene_number: 1,
        title: String::new(),
        location_ref: None,
        interior_exterior: "unknown".into(),
        time_of_day: TimeOfDay::Unknown,
        character_refs: Vec::new(),
        adaptation_note: String::new(),
        plot_node_refs: refs,
        source_refs: Vec::new(),
        missing_fields: Vec::new(),
        dialogue: String::new(),
        shot_description: String::new(),
    }
}
fn episode(scenes: Vec<Scene>) -> Episode {
    Episode {
        episode_id: id("episode"),
        episode_number: 1,
        title: String::new(),
        scenes,
    }
}
fn node_map(plot: &Plot) -> BTreeMap<&str, &Node> {
    plot.nodes.iter().map(|n| (n.node_id.as_str(), n)).collect()
}
pub fn derived_scene(refs: Vec<String>, plot: &Plot, bp: &Value) -> Result<Scene> {
    let nodes = node_map(plot);
    derived_scene_from(refs, &nodes, bp)
}
pub(crate) fn derived_scene_from(
    refs: Vec<String>,
    nodes: &BTreeMap<&str, &Node>,
    bp: &Value,
) -> Result<Scene> {
    let mut scene = empty_scene(refs);
    let mut locations = BTreeSet::new();
    let mut times = BTreeSet::new();
    let mut characters = BTreeSet::new();
    for reference in &scene.plot_node_refs {
        let n = nodes
            .get(reference.as_str())
            .ok_or_else(|| Error::new("invalid_input", "场次引用的剧情节点不存在。"))?;
        if n.verification != Verification::Confirmed {
            continue;
        }
        if let Some(location) = &n.location_ref {
            locations.insert(location.clone());
        }
        if n.time_of_day != TimeOfDay::Unknown {
            times.insert(serde_json::to_string(&n.time_of_day)?);
        }
        characters.extend(
            n.entity_refs
                .iter()
                .filter(|r| r.starts_with("character_"))
                .cloned(),
        );
        characters.extend(n.speaker_ref.iter().cloned());
    }
    if locations.len() == 1 {
        scene.location_ref = locations.into_iter().next();
        if let Some(location) = bp["locations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["location_id"].as_str() == scene.location_ref.as_deref())
        {
            scene.interior_exterior = location["interior_exterior"].as_str().unwrap().into();
        }
    }
    if times.len() == 1 {
        scene.time_of_day = serde_json::from_str(times.first().unwrap())?;
    }
    scene.character_refs = characters.into_iter().collect();
    refresh_scene(&mut scene, nodes)?;
    Ok(scene)
}
fn refresh_scene(scene: &mut Scene, nodes: &BTreeMap<&str, &Node>) -> Result<()> {
    scene.source_refs.clear();
    let mut sources = BTreeSet::new();
    let mut review = false;
    for reference in &scene.plot_node_refs {
        let node = nodes
            .get(reference.as_str())
            .ok_or_else(|| Error::new("invalid_input", "场次的剧情来源不存在。"))?;
        ensure(
            node.verification != Verification::Dismissed,
            "invalid_input",
            "已排除的剧情节点不能进入骨架。",
        )?;
        review |= node.verification != Verification::Confirmed;
        for source in &node.source_refs {
            if sources.insert(serde_json::to_string(source)?) {
                scene.source_refs.push(source.clone());
            }
        }
    }
    let fields = [
        (scene.location_ref.is_none(), "location"),
        (scene.interior_exterior == "unknown", "interior_exterior"),
        (scene.time_of_day == TimeOfDay::Unknown, "time_of_day"),
        (scene.character_refs.is_empty(), "characters"),
        (scene.plot_node_refs.is_empty(), "source_mapping"),
        (review, "author_review"),
    ];
    scene.missing_fields = fields
        .into_iter()
        .filter(|(missing, _)| *missing)
        .map(|(_, field)| field.into())
        .collect();
    Ok(())
}
fn refresh(skeleton: &mut Skeleton, plot: &Plot) -> Result<()> {
    let nodes = node_map(plot);
    for (e, episode) in skeleton.episodes.iter_mut().enumerate() {
        episode.episode_number = e + 1;
        for (s, scene) in episode.scenes.iter_mut().enumerate() {
            scene.scene_number = s + 1;
            refresh_scene(scene, &nodes)?;
        }
    }
    Ok(())
}
pub fn build(
    plot: &Plot,
    plot_sha: &str,
    bp: &Value,
    options: Options,
    actor: &str,
) -> Result<Skeleton> {
    let nodes = ordered_nodes(plot);
    let positions: BTreeMap<_, _> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.node_id.as_str(), i))
        .collect();
    let mut last = None;
    for anchor in &options.episode_start_node_ids {
        let at = positions
            .get(anchor.as_str())
            .ok_or_else(|| Error::new("invalid_input", "分集锚点必须属于未排除的固定剧情节点。"))?;
        ensure(
            last.is_none_or(|previous| previous < *at),
            "invalid_input",
            "分集锚点必须按原著顺序排列且不重复。",
        )?;
        last = Some(*at);
    }
    let anchors: BTreeSet<_> = options
        .episode_start_node_ids
        .iter()
        .map(String::as_str)
        .collect();
    let mut groups: Vec<Vec<Vec<String>>> = Vec::new();
    let mut previous: Option<&Node> = None;
    let mut known_location: Option<&str> = None;
    let mut known_time: Option<&str> = None;
    let mut known_day = TimeOfDay::Unknown;
    for node in nodes {
        let new_episode = groups.is_empty() || anchors.contains(node.node_id.as_str());
        let location = (node.verification == Verification::Confirmed)
            .then_some(node.location_ref.as_deref())
            .flatten();
        let time = (node.verification == Verification::Confirmed)
            .then_some(node.time_ref.as_deref())
            .flatten();
        let day = if node.verification == Verification::Confirmed {
            node.time_of_day
        } else {
            TimeOfDay::Unknown
        };
        let boundary = new_episode
            || node.kind == Kind::Scene
            || previous
                .is_some_and(|p| p.source_refs[0].document_id != node.source_refs[0].document_id)
            || location.is_some_and(|l| known_location.is_some_and(|old| old != l))
            || time.is_some_and(|t| known_time.is_some_and(|old| old != t))
            || (day != TimeOfDay::Unknown && known_day != TimeOfDay::Unknown && day != known_day);
        if new_episode {
            groups.push(Vec::new());
        }
        let scenes = groups.last_mut().unwrap();
        if boundary {
            scenes.push(Vec::new());
            known_location = None;
            known_time = None;
            known_day = TimeOfDay::Unknown;
        }
        scenes.last_mut().unwrap().push(node.node_id.clone());
        known_location = location.or(known_location);
        known_time = time.or(known_time);
        if day != TimeOfDay::Unknown {
            known_day = day;
        }
        previous = Some(node);
    }
    let by_id = node_map(plot);
    let episodes = groups
        .into_iter()
        .map(|scenes| {
            scenes
                .into_iter()
                .map(|refs| derived_scene_from(refs, &by_id, bp))
                .collect::<Result<Vec<_>>>()
                .map(episode)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut skeleton = Skeleton {
        schema_version: "1.0.0".into(),
        skeleton_id: id("skeleton"),
        revision: 1,
        previous_sha256: None,
        plot_revision_id: plot.plot_revision_id.clone(),
        plot_sha256: plot_sha.into(),
        blueprint_revision: plot.blueprint_revision,
        blueprint_sha256: plot.blueprint_sha256.clone(),
        source_revisions: plot.source_revisions.clone(),
        engine_version: "1.0.0".into(),
        build_options: options,
        status: plot.coverage.status.clone(),
        episodes,
        created_at: now(),
        actor_ref: actor.into(),
    };
    refresh(&mut skeleton, plot)?;
    validate(&skeleton, plot, bp)?;
    Ok(skeleton)
}
pub fn validate(skeleton: &Skeleton, plot: &Plot, bp: &Value) -> Result<()> {
    decode(&serde_json::to_value(skeleton)?)?;
    ensure(
        skeleton.plot_revision_id == plot.plot_revision_id
            && skeleton.blueprint_revision == plot.blueprint_revision
            && skeleton.blueprint_sha256 == plot.blueprint_sha256
            && skeleton.source_revisions == plot.source_revisions
            && skeleton.status == plot.coverage.status
            && (skeleton.revision == 1) == skeleton.previous_sha256.is_none(),
        "hetu.integrity_failure",
        "骨架的固定输入或修订链不一致。",
    )?;
    let mut ids = BTreeSet::new();
    let mut node_ids = BTreeSet::new();
    let nodes = node_map(plot);
    for (e, episode) in skeleton.episodes.iter().enumerate() {
        ensure(
            ids.insert(episode.episode_id.as_str()) && episode.episode_number == e + 1,
            "hetu.integrity_failure",
            "分集身份或序号不一致。",
        )?;
        for (s, scene) in episode.scenes.iter().enumerate() {
            ensure(
                ids.insert(scene.scene_id.as_str()) && scene.scene_number == s + 1,
                "hetu.integrity_failure",
                "场次身份或序号不一致。",
            )?;
            for reference in &scene.plot_node_refs {
                ensure(
                    node_ids.insert(reference.as_str()),
                    "invalid_input",
                    "同一剧情节点只能映射到一个场次，请移动或拆分来源。",
                )?;
            }
            if let Some(location) = &scene.location_ref {
                ensure(
                    bp["locations"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|l| l["location_id"] == *location),
                    "invalid_input",
                    "场次地点不在固定设定集中。",
                )?;
            }
            for reference in &scene.character_refs {
                ensure(
                    bp["characters"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|c| c["character_id"] == *reference),
                    "invalid_input",
                    "出场人物不在固定设定集中。",
                )?;
            }
            let mut expected = scene.clone();
            refresh_scene(&mut expected, &nodes)?;
            ensure(
                expected.source_refs == scene.source_refs
                    && expected.missing_fields == scene.missing_fields,
                "hetu.integrity_failure",
                "场次来源或缺项与固定节点不一致。",
            )?;
        }
    }
    ensure(
        serde_json::to_vec(skeleton)?.len() <= OUTPUT_LIMIT,
        "hetu.budget_exceeded",
        "短剧骨架超过 16 MiB 预算，请减少结构规模。",
    )
}
fn field<'a>(change: &'a Value, key: &str) -> &'a str {
    change[key].as_str().unwrap()
}
fn scene_at(s: &Skeleton, scene_id: &str) -> Result<(usize, usize)> {
    for (e, episode) in s.episodes.iter().enumerate() {
        if let Some(i) = episode.scenes.iter().position(|s| s.scene_id == scene_id) {
            return Ok((e, i));
        }
    }
    Err(Error::new("not_found", "场次不存在，请重新读取骨架。"))
}
fn episode_at(s: &Skeleton, episode_id: &str) -> Result<usize> {
    s.episodes
        .iter()
        .position(|e| e.episode_id == episode_id)
        .ok_or_else(|| Error::new("not_found", "分集不存在。"))
}
pub fn edit(
    current: &Skeleton,
    sha: &str,
    changes: &[Value],
    plot: &Plot,
    bp: &Value,
    actor: &str,
) -> Result<Skeleton> {
    let mut next = current.clone();
    next.revision += 1;
    next.previous_sha256 = Some(sha.into());
    next.created_at = now();
    next.actor_ref = actor.into();
    for change in changes {
        let kind = field(change, "type");
        if kind == "add_episode" {
            let at = change["index"].as_u64().unwrap() as usize;
            ensure(
                at <= next.episodes.len(),
                "invalid_input",
                "新分集位置超出范围。",
            )?;
            next.episodes
                .insert(at, episode(vec![empty_scene(Vec::new())]));
        } else if kind.ends_with("_episode") {
            let e = episode_at(&next, field(change, "episode_id"))?;
            match kind {
                "update_episode" => next.episodes[e].title = field(change, "title").into(),
                "move_episode" => {
                    let target = change["index"].as_u64().unwrap() as usize;
                    ensure(
                        target < next.episodes.len(),
                        "invalid_input",
                        "目标集序号超出范围。",
                    )?;
                    let episode = next.episodes.remove(e);
                    next.episodes.insert(target, episode);
                }
                "split_episode" => {
                    let at = next.episodes[e]
                        .scenes
                        .iter()
                        .position(|s| s.scene_id == field(change, "at_scene_id"))
                        .ok_or_else(|| Error::new("invalid_input", "拆集锚点不在本集。"))?;
                    ensure(at > 0, "invalid_input", "拆集后每集至少保留一场。")?;
                    let right = next.episodes[e].scenes.split_off(at);
                    next.episodes.insert(e + 1, episode(right));
                }
                "merge_episode" => {
                    ensure(
                        e + 1 < next.episodes.len()
                            && next.episodes[e + 1].episode_id == field(change, "with_episode_id"),
                        "invalid_input",
                        "只能向后合并相邻分集。",
                    )?;
                    let right = next.episodes.remove(e + 1);
                    next.episodes[e].scenes.extend(right.scenes);
                }
                _ => return Err(Error::new("invalid_input", "未知分集操作。")),
            }
        } else if kind == "add_scene" {
            let e = episode_at(&next, field(change, "episode_id"))?;
            let at = change["index"].as_u64().unwrap() as usize;
            ensure(
                at <= next.episodes[e].scenes.len(),
                "invalid_input",
                "新场次位置超出范围。",
            )?;
            next.episodes[e].scenes.insert(
                at,
                derived_scene(
                    serde_json::from_value(change["plot_node_refs"].clone())?,
                    plot,
                    bp,
                )?,
            );
        } else {
            let (e, s) = scene_at(&next, field(change, "scene_id"))?;
            match kind {
                "update_scene" => {
                    let scene = &mut next.episodes[e].scenes[s];
                    scene.title = field(change, "title").into();
                    scene.location_ref = change["location_ref"].as_str().map(String::from);
                    scene.interior_exterior = field(change, "interior_exterior").into();
                    scene.time_of_day = serde_json::from_value(change["time_of_day"].clone())?;
                    scene.character_refs =
                        serde_json::from_value(change["character_refs"].clone())?;
                    scene.adaptation_note = field(change, "adaptation_note").into();
                }
                "set_scene_nodes" => {
                    next.episodes[e].scenes[s].plot_node_refs =
                        serde_json::from_value(change["plot_node_refs"].clone())?
                }
                "move_scene" => {
                    let target = episode_at(&next, field(change, "episode_id"))?;
                    let at = change["index"].as_u64().unwrap() as usize;
                    let scene = next.episodes[e].scenes.remove(s);
                    ensure(
                        at <= next.episodes[target].scenes.len(),
                        "invalid_input",
                        "目标场次位置超出范围。",
                    )?;
                    next.episodes[target].scenes.insert(at, scene);
                }
                "remove_scene" => {
                    next.episodes[e].scenes.remove(s);
                }
                "split_scene" => {
                    let scene = &mut next.episodes[e].scenes[s];
                    let at = scene
                        .plot_node_refs
                        .iter()
                        .position(|r| r == field(change, "at_node_id"))
                        .ok_or_else(|| Error::new("invalid_input", "拆分锚点不属于此场次。"))?;
                    ensure(at > 0, "invalid_input", "拆分后每场至少保留一个剧情节点。")?;
                    let mut right = scene.clone();
                    right.scene_id = id("scene");
                    right.title.clear();
                    right.adaptation_note.clear();
                    right.plot_node_refs = scene.plot_node_refs.split_off(at);
                    next.episodes[e].scenes.insert(s + 1, right);
                }
                "merge_scene" => {
                    ensure(
                        s + 1 < next.episodes[e].scenes.len()
                            && next.episodes[e].scenes[s + 1].scene_id
                                == field(change, "with_scene_id"),
                        "invalid_input",
                        "只能向后合并同集的相邻场次。",
                    )?;
                    let right = next.episodes[e].scenes.remove(s + 1);
                    let left = &mut next.episodes[e].scenes[s];
                    left.plot_node_refs.extend(right.plot_node_refs);
                    if left.location_ref != right.location_ref {
                        left.location_ref = None;
                    }
                    if left.interior_exterior != right.interior_exterior {
                        left.interior_exterior = "unknown".into();
                    }
                    if left.time_of_day != right.time_of_day {
                        left.time_of_day = TimeOfDay::Unknown;
                    }
                    left.character_refs = left
                        .character_refs
                        .iter()
                        .chain(&right.character_refs)
                        .cloned()
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .collect();
                    if !right.adaptation_note.is_empty() {
                        if !left.adaptation_note.is_empty() {
                            left.adaptation_note.push('\n');
                        }
                        left.adaptation_note.push_str(&right.adaptation_note);
                    }
                }
                _ => return Err(Error::new("invalid_input", "未知场次操作。")),
            }
        }
    }
    // 不留下空集；最后一场删除后作品可以保持没有骨架内容的明确状态。
    next.episodes.retain(|e| !e.scenes.is_empty());
    refresh(&mut next, plot)?;
    validate(&next, plot, bp)?;
    Ok(next)
}
pub fn summary(skeleton: &Skeleton, sha: &str) -> Value {
    json!({"schema_version":"1.0.0","skeleton_id":skeleton.skeleton_id,"revision":skeleton.revision,"previous_sha256":skeleton.previous_sha256,"plot_revision_id":skeleton.plot_revision_id,"blueprint_revision":skeleton.blueprint_revision,"status":skeleton.status,"created_at":skeleton.created_at,"episode_count":skeleton.episodes.len(),"scene_count":skeleton.episodes.iter().map(|e| e.scenes.len()).sum::<usize>(),"sha256":sha})
}
pub fn reference(skeleton: &Skeleton, sha: &str) -> Value {
    json!({"skeleton_id":skeleton.skeleton_id,"revision":skeleton.revision,"sha256":sha})
}
pub fn check_identity(skeleton_id: &str) -> Result<()> {
    checked_id(skeleton_id, "skeleton").map(|_| ())
}
