use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// 为独立入口保留完整的引用闭包，避免每个动作重复携带整份合同的无关定义。
pub(crate) fn definition(source: &Value, name: &str) -> Value {
    let mut result = source["$defs"][name].clone();
    assert!(result.is_object(), "registered schema definition");
    let mut pending = BTreeSet::new();
    referenced_definitions(&result, &mut pending);
    let mut definitions = Map::new();
    while let Some(name) = pending.pop_first() {
        if definitions.contains_key(&name) {
            continue;
        }
        let value = source["$defs"][&name].clone();
        assert!(
            value.is_object() || value.is_boolean(),
            "registered schema reference"
        );
        referenced_definitions(&value, &mut pending);
        definitions.insert(name, value);
    }
    result["$schema"] = source["$schema"].clone();
    if !definitions.is_empty() {
        result["$defs"] = Value::Object(definitions);
    }
    result
}

fn referenced_definitions(value: &Value, result: &mut BTreeSet<String>) {
    match value {
        Value::Object(object) => {
            if let Some(reference) = object.get("$ref").and_then(Value::as_str)
                && let Some(pointer) = reference.strip_prefix("#/$defs/")
            {
                let name = pointer
                    .split('/')
                    .next()
                    .unwrap()
                    .replace("~1", "/")
                    .replace("~0", "~");
                result.insert(name);
            }
            for value in object.values() {
                referenced_definitions(value, result);
            }
        }
        Value::Array(array) => {
            for value in array {
                referenced_definitions(value, result);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn independent_definition_keeps_transitive_and_recursive_constraints() {
        let source = json!({"$schema":"https://json-schema.org/draft/2020-12/schema", "$defs":{
            "request":{"$ref":"#/$defs/node"},
            "node":{"type":"object","required":["value"],"additionalProperties":false,"properties":{
                "value":{"$ref":"#/$defs/label~1text"},
                "next":{"$ref":"#/$defs/node"}
            }},
            "label/text":{"type":"string","minLength":1},
            "unused":{"type":"integer"}
        }});
        let extracted = definition(&source, "request");
        assert_eq!(extracted["$defs"].as_object().unwrap().len(), 2);
        assert!(extracted["$defs"].get("unused").is_none());
        let validator = jsonschema::validator_for(&extracted).unwrap();
        assert!(validator.is_valid(&json!({"value":"作者", "next":{"value":"参考稿"}})));
        assert!(!validator.is_valid(&json!({"value":"作者", "next":{"value":""}})));
        assert!(!validator.is_valid(&json!({"value":"作者", "unknown":true})));
    }
}
