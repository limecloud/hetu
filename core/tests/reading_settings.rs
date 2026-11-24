use hetu_core::local_settings::LocalSettings;
use serde_json::{Value, json};

fn state(service: &LocalSettings) -> Value {
    service.host(json!({"method":"get","input":{}})).unwrap()
}

#[test]
fn partial_profile_updates_preserve_other_fields_and_reject_ambiguous_or_invalid_changes() {
    let directory = tempfile::tempdir().unwrap();
    let service = LocalSettings::open(directory.path()).unwrap();
    let initial = state(&service);
    let snapshot = service.host(json!({"method":"preferences","input":{}})).unwrap();
    assert_eq!(snapshot, json!({"revision":initial["revision"],"preferences":initial["preferences"]}));
    let request = json!({"method":"update","input":{"expected_revision":1,
        "patch":{"reading_profiles":{"novel":{"font_size":24,"line_height":1.8}},"document_theme":"warm"},
        "operation_key":"readable-novel"}});
    let changed = service.host(request.clone()).unwrap();
    let profile = &changed["preferences"]["reading_profiles"]["novel"];
    assert_eq!(profile["font_size"], 24);
    assert_eq!(profile["line_width"], initial["preferences"]["reading_profiles"]["novel"]["line_width"]);
    assert_eq!(changed["preferences"]["reading_profiles"]["screenplay"], initial["preferences"]["reading_profiles"]["screenplay"]);
    assert_eq!(service.host(request).unwrap(), changed);
    assert_eq!(changed["preferences"]["font_size"], 24);
    let stored: Value = serde_json::from_slice(&std::fs::read(directory.path().join("settings.json")).unwrap()).unwrap();
    assert!(stored["preferences"].get("font_size").is_none(), "旧字段只能是投影");
    let before_invalid = state(&service);
    for patch in [
        json!({"reading_profiles":{"novel":{"font_size":24}},"font_size":24}),
        json!({"reading_profiles":{"screenplay":{"font_family":"custom","font_name":""}}}),
        json!({"reading_profiles":{"novel":{"line_height":0.5}}}),
        json!({"reading_profiles":{"unknown":{"font_size":20}}}),
        json!({"reading_profiles":{"novel":{"font_name":"bad\";color:red"}}}),
    ] {
        assert!(service.host(json!({"method":"update","input":{"expected_revision":2,"patch":patch,"operation_key":"invalid"}})).is_err());
        assert_eq!(state(&service), before_invalid);
    }
}

#[test]
fn migration_backs_up_original_bytes_once_and_keeps_actual_typography() {
    let directory = tempfile::tempdir().unwrap();
    let legacy = json!({"schema_version":1,"revision":7,"preferences":{
        "language":"zh-CN","appearance":"dark","library_list":true,"autosave":false,
        "font_family":"pingfang","font_size":22,"line_spacing":8,"first_line_indent":false,
        "git_author_name":"作者","git_author_email":"","agent_client":"codex"
    },"associations":{"default":{"client":"codex","suite":"general"}},"installations":{}});
    let bytes = serde_json::to_string_pretty(&legacy).unwrap().replace('\n', "\r\n").into_bytes();
    std::fs::write(directory.path().join("settings.json"), &bytes).unwrap();
    let service = LocalSettings::open(directory.path()).unwrap();
    let migrated = state(&service);
    assert_eq!(migrated["schema_version"], 5);
    assert_eq!(migrated["revision"], 9);
    assert_eq!(migrated["preferences"]["reading_profiles"]["novel"]["line_height"], json!(1.35 + 8.0 / 22.0));
    assert_eq!(migrated["preferences"]["reading_profiles"]["novel"]["line_width"], json!(40.0));
    assert_eq!(migrated["preferences"]["reading_profiles"]["screenplay"]["font_size"], 22);
    assert_eq!(migrated["preferences"]["reading_profiles"]["screenplay"]["first_line_indent"], false);
    assert_eq!(migrated["preferences"]["line_spacing"], 8);
    assert_eq!(migrated["associations"], legacy["associations"]);
    assert_eq!(std::fs::read(directory.path().join("migrations/v1/settings.json")).unwrap(), bytes);
    drop(service);
    let reopened = LocalSettings::open(directory.path()).unwrap();
    assert_eq!(state(&reopened), migrated);
    assert_eq!(std::fs::read(directory.path().join("migrations/v1/settings.json")).unwrap(), bytes);
}
#[test]
fn second_version_migration_adds_auto_and_preserves_original_bytes_and_existing_choices() {
    let directory = tempfile::tempdir().unwrap(); let service = LocalSettings::open(directory.path()).unwrap();
    let original = std::fs::read(directory.path().join("settings.json")).unwrap();
    let mut previous: Value = serde_json::from_slice(&original).unwrap();
    previous["schema_version"] = json!(2); previous["revision"] = json!(7);
    previous.as_object_mut().unwrap().remove("execution_policy_revision"); previous["preferences"].as_object_mut().unwrap().remove("execution_mode");
    previous["preferences"].as_object_mut().unwrap().remove("agent_session");
    previous["preferences"]["appearance"] = json!("dark");
    let bytes = serde_json::to_vec_pretty(&previous).unwrap(); drop(service); std::fs::write(directory.path().join("settings.json"),&bytes).unwrap();
    let upgraded = LocalSettings::open(directory.path()).unwrap(); let value = state(&upgraded);
    assert_eq!(value["schema_version"],5);
    assert_eq!(value["preferences"]["execution_mode"],"auto"); assert_eq!(value["revision"],9); assert_eq!(value["execution_policy_revision"],1);
    let mut preferences = value["preferences"].clone();
    for field in ["execution_mode","agent_session","font_family","font_size","line_spacing","first_line_indent"] {preferences.as_object_mut().unwrap().remove(field);}
    assert_eq!(preferences,previous["preferences"]);
    assert_eq!(std::fs::read(directory.path().join("migrations/v2/settings.json")).unwrap(),bytes);
}

#[test]
fn damaged_or_unknown_settings_are_preserved_instead_of_being_reset() {
    for source in [
        json!({"schema_version":99,"revision":1,"preferences":{},"associations":{},"installations":{}}),
        json!({"schema_version":1,"revision":1,"preferences":{"font_size":18},"associations":{},"installations":{}}),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let bytes = serde_json::to_vec(&source).unwrap();
        std::fs::write(directory.path().join("settings.json"), &bytes).unwrap();
        assert!(LocalSettings::open(directory.path()).is_err());
        assert_eq!(std::fs::read(directory.path().join("settings.json")).unwrap(), bytes);
        assert!(!directory.path().join("migrations/v1/settings.json").exists());
    }
}
