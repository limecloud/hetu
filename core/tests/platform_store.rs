use hetu_core::infrastructure::store::Store;
use std::collections::BTreeMap;

fn store(root: &std::path::Path) -> Store {
    let store = Store::open(root).unwrap();
    store.directory(".hetu/transactions").unwrap();
    store
}

#[test]
fn unicode_transactions_reopen_and_locks_keep_the_same_contract() {
    let root = tempfile::tempdir().unwrap();
    let first = store(root.path());
    let writer = first.lock().unwrap();
    assert_eq!(store(root.path()).lock().err().unwrap().code, "hetu.workspace_busy");
    first.install("记录/人物.json", b"before", true).unwrap();
    first.transaction(&BTreeMap::from([
        ("记录/人物.json".into(), "林舟🌧️".as_bytes().to_vec()),
        ("记录/场景.json".into(), b"second".to_vec()),
    ])).unwrap();
    drop(writer);
    let second = store(root.path());
    let _writer = second.lock().unwrap();
    second.recover().unwrap();
    assert_eq!(second.read("记录/人物.json").unwrap(), "林舟🌧️".as_bytes());
    assert_eq!(second.entries("记录").unwrap(), vec!["人物.json", "场景.json"]);
    second.sync_tree("记录").unwrap();
}

#[test]
fn hardlinks_and_directory_links_cannot_expand_the_store_scope() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let store = store(root.path());
    std::fs::write(outside.path().join("source.json"), b"outside").unwrap();
    std::fs::hard_link(outside.path().join("source.json"), root.path().join("linked.json")).unwrap();
    assert!(store.read("linked.json").is_err());
    assert!(store.install("linked.json", b"replace", false).is_err());
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(outside.path(), root.path().join("escape")).unwrap();
    assert!(store.read("escape/source.json").is_err());
    assert!(store.install("escape/new.json", b"denied", true).is_err());
    assert!(!outside.path().join("new.json").exists());
}

#[test]
fn replaced_workspace_does_not_reuse_the_original_write_handle() {
    let root = tempfile::tempdir().unwrap();
    let original = root.path().join("original");
    std::fs::create_dir(&original).unwrap();
    let store = store(&original);
    std::fs::rename(&original, root.path().join("moved")).unwrap();
    std::fs::create_dir(&original).unwrap();
    assert_eq!(store.lock().err().unwrap().code, "hetu.workspace_moved");
}

#[cfg(windows)]
#[test]
fn windows_aliases_and_alternate_data_streams_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    for name in ["NUL", "CON.json", "a:stream", "COM1.txt", "LPT¹", "record.", "record ", "C:relative", "../outside", "folder\\outside"] {
        assert!(store.install(name, b"denied", true).is_err(), "{name}");
    }
}
