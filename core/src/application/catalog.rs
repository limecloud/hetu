//! 动作元数据先发现，完整Schema只在选中动作时解析；所有入口共用同一合同。
use super::*;

pub(super) fn raw_catalog() -> &'static Value {
    static RAW: OnceLock<Value> = OnceLock::new();
    RAW.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contracts/actions.json"))
            .expect("embedded action catalog")
    })
}

fn entries() -> &'static BTreeMap<String, OnceLock<Value>> {
    static ENTRIES: OnceLock<BTreeMap<String, OnceLock<Value>>> = OnceLock::new();
    ENTRIES.get_or_init(|| {
        raw_catalog()["actions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|action| (action["name"].as_str().unwrap().to_owned(), OnceLock::new()))
            .collect()
    })
}
pub(super) fn materialization() -> Value {
    json!({"process_scope":true,"total":entries().len(),"materialized":entries().values().filter(|entry|entry.get().is_some()).count()})
}
pub(super) fn descriptor(name: &str) -> Option<&'static Value> {
    Some(entries().get(name)?.get_or_init(|| {
        let action = raw_catalog()["actions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == name)
            .unwrap();
        let mut catalog = json!({"actions":[action]});
        for action in catalog["actions"].as_array_mut().unwrap() {
            if let Some(reference) = action["input_schema_ref"].as_str() {
                if let Some(definition) = reference.strip_prefix("schemas/video-review.schema.json#/$defs/") {
                    action["input_schema"] = video_review::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                if let Some(definition) = reference.strip_prefix("schemas/work.schema.json#/$defs/")
                {
                    action["input_schema"] = works::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                if let Some(definition) =
                    reference.strip_prefix("schemas/model-service.schema.json#/$defs/")
                {
                    action["input_schema"] = model_tasks::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                if let Some(definition) =
                    reference.strip_prefix("schemas/resources.schema.json#/$defs/")
                {
                    action["input_schema"] = resources::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                if let Some(definition) =
                    reference.strip_prefix("schemas/delivery.schema.json#/$defs/")
                {
                    action["input_schema"] = delivery::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                if let Some(definition) =
                    reference.strip_prefix("schemas/book-cover.schema.json#/$defs/")
                {
                    action["input_schema"] = covers::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                if let Some(definition) =
                    reference.strip_prefix("schemas/novel.schema.json#/$defs/")
                {
                    action["input_schema"] = domain::novel::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                if let Some(definition) =
                    reference.strip_prefix("schemas/media.schema.json#/$defs/")
                {
                    action["input_schema"] = domain::media::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                if let Some(definition) =
                    reference.strip_prefix("schemas/document-lifecycle.schema.json#/$defs/")
                {
                    action["input_schema"] = document_lifecycle::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                if let Some(definition) =
                    reference.strip_prefix("schemas/creative-task.schema.json#/$defs/")
                {
                    action["input_schema"] = creative_tasks::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                let source = match reference {
                    "schemas/git-snapshot-input.schema.json" => {
                        include_str!("../../../contracts/schemas/git-snapshot-input.schema.json")
                    }
                    "schemas/review-begin-input.schema.json" => {
                        include_str!("../../../contracts/schemas/review-begin-input.schema.json")
                    }
                    "schemas/review-validate-input.schema.json" => {
                        include_str!("../../../contracts/schemas/review-validate-input.schema.json")
                    }
                    "schemas/review-decide-input.schema.json" => {
                        include_str!("../../../contracts/schemas/review-decide-input.schema.json")
                    }
                    "schemas/draft-submit-input.schema.json" => {
                        include_str!("../../../contracts/schemas/draft-submit-input.schema.json")
                    }
                    "schemas/blueprint-save-input.schema.json" => {
                        include_str!("../../../contracts/schemas/blueprint-save-input.schema.json")
                    }
                    "schemas/blueprint-preview-input.schema.json" => include_str!(
                        "../../../contracts/schemas/blueprint-preview-input.schema.json"
                    ),
                    "schemas/plot-extract-input.schema.json" => {
                        include_str!("../../../contracts/schemas/plot-extract-input.schema.json")
                    }
                    "schemas/plot-correct-input.schema.json" => {
                        include_str!("../../../contracts/schemas/plot-correct-input.schema.json")
                    }
                    "schemas/validation-run-input.schema.json" => {
                        include_str!("../../../contracts/schemas/validation-run-input.schema.json")
                    }
                    "schemas/finding-disposition-input.schema.json" => include_str!(
                        "../../../contracts/schemas/finding-disposition-input.schema.json"
                    ),
                    "schemas/drama-build-input.schema.json" => {
                        include_str!("../../../contracts/schemas/drama-build-input.schema.json")
                    }
                    "schemas/drama-edit-input.schema.json" => {
                        include_str!("../../../contracts/schemas/drama-edit-input.schema.json")
                    }
                    "schemas/drama-compare-input.schema.json" => {
                        include_str!("../../../contracts/schemas/drama-compare-input.schema.json")
                    }
                    "schemas/drama-script-input.schema.json" => {
                        include_str!("../../../contracts/schemas/drama-script-input.schema.json")
                    }
                    _ => panic!("unregistered embedded input schema"),
                };
                let mut input = serde_json::from_str(source).expect("embedded input schema");
                if reference.starts_with("schemas/blueprint-") {
                    input = blueprint::bundle(input);
                } else if reference.starts_with("schemas/plot-")
                    || reference == "schemas/review-validate-input.schema.json"
                {
                    input = plot::bundle(input);
                }
                action["input_schema"] = input;
                action.as_object_mut().unwrap().remove("input_schema_ref");
            }
        }
        for action in catalog["actions"].as_array_mut().unwrap() {
            action["input_schema"] = works::bundle_reference(action["input_schema"].take());
        }
        catalog["actions"].as_array_mut().unwrap().remove(0)
    }))
}

pub(super) fn catalog() -> &'static Value {
    static COMPLETE: OnceLock<Value> = OnceLock::new();
    COMPLETE.get_or_init(|| json!({"actions":raw_catalog()["actions"].as_array().unwrap().iter()
        .map(|action| descriptor(action["name"].as_str().unwrap()).unwrap().clone()).collect::<Vec<_>>()}))
}

pub(super) fn select(
    include_schema: bool,
    exact: Option<&str>,
    accepts: impl Fn(&Value) -> bool,
) -> Value {
    json!(
        raw_catalog()["actions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|action| exact.is_none_or(|name| action["name"] == name) && accepts(action))
            .map(|action| {
                if include_schema {
                    descriptor(action["name"].as_str().unwrap())
                        .unwrap()
                        .clone()
                } else {
                    let mut metadata = action.clone();
                    metadata.as_object_mut().unwrap().remove("input_schema");
                    metadata.as_object_mut().unwrap().remove("input_schema_ref");
                    metadata.as_object_mut().unwrap().remove("result_provenance");
                    metadata
                }
            })
            .collect::<Vec<_>>()
    )
}
