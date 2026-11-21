use super::*;

#[test]
fn host_reads_remain_available_while_another_entry_holds_the_writer() {
    let folder = tempfile::tempdir().unwrap();
    let first = LocalSettings::open(folder.path()).unwrap();
    let before = std::fs::read(folder.path().join("settings.json")).unwrap();
    let writer = first.store.lock().unwrap();
    let second = LocalSettings::open(folder.path()).unwrap();
    for method in ["preferences", "get", "list"] {
        let result = second.host(json!({"method":method,"input":{}})).unwrap();
        assert!(result.is_object());
    }
    assert_eq!(std::fs::read(folder.path().join("settings.json")).unwrap(), before);
    let update = json!({"method":"update","input":{"expected_revision":1,"patch":{"reading_profiles":{"novel":{"font_size":24}}},"operation_key":"concurrent-entry-update"}});
    assert_eq!(second.host(update.clone()).unwrap_err().code, "hetu.workspace_busy");
    drop(writer);
    let changed = second.host(update).unwrap();
    assert_eq!(changed["revision"], 2);
    assert_eq!(changed["preferences"]["reading_profiles"]["novel"]["font_size"], 24);
    assert_eq!(first.host(json!({"method":"preferences","input":{}})).unwrap()["revision"], 2);
}
