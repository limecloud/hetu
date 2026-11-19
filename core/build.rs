//! 对随包合同及其投影代码生成身份；发现目录无需展开全部Schema。
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn collect(path: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(path).expect("contract directory") {
        let path = entry.expect("contract entry").path();
        if path.is_dir() {
            collect(&path, files);
        } else if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            files.push(path);
        }
    }
}
fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let mut files = vec![root.join("../contracts/actions.json")];
    collect(&root.join("../contracts/schemas"), &mut files);
    for source in [
        "build.rs",
        "src/application/catalog.rs",
        "src/application/mod.rs",
        "src/application/works.rs",
        "src/domain/schema.rs",
        "src/collaboration.rs",
        "src/collaboration/authoring.rs",
        "src/collaboration/library.rs",
        "src/machine.rs",
    ] {
        files.push(root.join(source));
    }
    files.sort();
    let mut hash = Sha256::new();
    for path in files {
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = fs::read(&path).expect("embedded contract input");
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("action-contract-sha256.txt"),
        format!("{:x}", hash.finalize()),
    )
    .unwrap();
}
