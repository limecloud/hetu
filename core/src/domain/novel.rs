use super::{Result, ensure};
use serde_json::Value;
use std::sync::OnceLock;

pub fn definition(name: &str) -> Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    let schema = SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contracts/schemas/novel.schema.json"))
            .expect("embedded novel schema")
    });
    super::schema::definition(schema, name)
}

pub fn validate_metadata(metadata: &Value) -> Result<()> {
    ensure(
        !metadata["title"].as_str().unwrap_or("").trim().is_empty(),
        "invalid_input",
        "请填写小说名称。",
    )
}
