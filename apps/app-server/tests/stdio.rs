use hetu_core::Kernel;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Client {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next: u64,
}
impl Client {
    fn open(path: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_hetu-app-server"))
            .args(["--stdio", "--workspace"])
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
            next: 0,
        }
    }
    fn send(&mut self, message: Value) {
        writeln!(self.input, "{message}").unwrap();
        self.input.flush().unwrap();
    }
    fn read(&mut self) -> Value {
        let mut line = String::new();
        assert!(self.output.read_line(&mut line).unwrap() > 0);
        serde_json::from_str(&line).unwrap()
    }
    fn rpc(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        self.send(json!({"jsonrpc":"2.0","id":self.next,"method":method,"params":params}));
        let value = self.read();
        assert_eq!(value["id"], self.next);
        value
    }
    fn ready(&mut self) {
        assert_eq!(
            self.rpc(
                "initialize",
                json!({"protocol_version":"1","client_name":"stdio-test"})
            )["result"]["protocol_version"],
            "1"
        );
        self.send(json!({"jsonrpc":"2.0","method":"initialized"}));
    }
    fn action(&mut self, action: &str, input: Value) -> Value {
        self.rpc(
            "workspace/request",
            json!({"action":action,"contract_revision":"1","input":input}),
        )["result"]
            .clone()
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn local_agent_requests_share_host_state_without_inheriting_author_decisions() {
    let directory = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_hetu-app-server"))
        .args(["--stdio", "--local"])
        .env("HETU_LOCAL_SETTINGS_DIR", directory.path())
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().unwrap();
    let mut client = Client {
        input: child.stdin.take().unwrap(), output: BufReader::new(child.stdout.take().unwrap()), child, next: 0,
    };
    client.ready();
    assert_eq!(client.rpc("local_settings/request", json!({"client_adapter":"codex","request":{},"approved":true}))["error"]["code"], -32602);
    let prepared = client.rpc("local_settings/request", json!({"client_adapter":"codex","request":{
        "action":"hetu.local_settings.prepare","contract_revision":"1","input":{
            "kind":"preferences","patch":{"font_size":19},"summary":"私有传输保留Agent身份","operation_key":"prepare"
        }}}));
    assert_eq!(prepared["result"]["status"], "succeeded", "{prepared}");
    let plan = &prepared["result"]["data"];
    assert_eq!(plan["fixed"]["client_adapter"], "codex");
    let blocked = client.rpc("local_settings/request", json!({"client_adapter":"codex","request":{
        "action":"hetu.local_settings.execute","contract_revision":"1","input":{
            "operation_id":plan["operation_id"],"sha256":plan["sha256"],"operation_key":"execute"
        }}}));
    assert_eq!(blocked["result"]["error"]["code"], "hetu.author_confirmation_required");
    let host = client.rpc("local_settings/host", json!({"method":"get","input":{}}));
    assert_eq!(host["result"]["preferences"]["font_size"], 18);
    let forbidden = client.rpc("local_settings/request", json!({"client_adapter":"codex","request":{
        "action":"hetu.documents.save","contract_revision":"1","input":{}}}));
    assert_eq!(forbidden["result"]["error"]["code"], "hetu.capability_unavailable");
}

#[test]
fn private_startup_paths_cannot_be_relative_duplicated_or_added_to_local_connection() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("作品");
    fixture(&workspace);
    for flags in [
        vec!["--git-authorizations-dir", "relative"],
        vec![
            "--git-authorizations-dir",
            "/unused",
            "--git-authorizations-dir",
            "/unused",
        ],
        vec!["--mode", "author"],
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_hetu-app-server"))
            .args(["--stdio", "--workspace"])
            .arg(&workspace)
            .args(flags)
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
    }
    let result = Command::new(env!("CARGO_BIN_EXE_hetu-app-server"))
        .args(["--stdio", "--local", "--git-authorizations-dir", "/unused"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
}

fn fixture(path: &std::path::Path) -> (Kernel, Value) {
    let kernel = Kernel::open(json!({"workspace_path":path,"mode":"author","create":{"title":"Electron 跨进程测试","locale":"zh-CN","operation_key":"fixture"}})).unwrap();
    let doc = kernel.request(json!({"action":"hetu.documents.create","contract_revision":"1","input":{"kind":"novel_chapter","title":"第一章 雨夜","source_format":"markdown","content":"原文🌿\r\n","operation_key":"chapter"}}));
    assert_eq!(doc["status"], "succeeded", "{doc}");
    (kernel, doc["data"].clone())
}

#[test]
fn private_media_handles_are_bounded_scoped_and_closed_with_session() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("素材作品");
    let (kernel, _) = fixture(&path);
    let work = kernel.request(json!({"action":"hetu.works.list","contract_revision":"1","input":{}}))["data"]["works"][0]["work_ref"].clone();
    let source = root.path().join("样本.wav");
    let bytes = b"RIFF\x00\x00\x10\x00WAVEprivate-media-transport";
    std::fs::write(&source, bytes).unwrap();
    let scan = kernel.request(json!({"action":"hetu.assets.inspect","contract_revision":"1","input":{"file_path":source}}))["data"].clone();
    let asset = kernel.request(json!({"action":"hetu.assets.import","contract_revision":"1","input":{
        "work_ref":work,"file_path":source,"expected_file":{"sha256":scan["sha256"],"size_bytes":scan["size_bytes"]},
        "title":"固定素材","source":{"source_type":"author_supplied","creator_statement":"测试"},"rights_status":"unknown",
        "redistribution_allowed":false,"rights_statement":"","operation_key":"media-import"}}));
    assert_eq!(asset["status"], "succeeded", "{asset}");
    let fixed = json!({"work_ref":work,"asset_id":asset["data"]["asset"]["asset_id"],"revision":1,"sha256":asset["data"]["sha256"]});
    let mut client = Client::open(&path);
    assert!(client.rpc("media/open", fixed.clone())["error"].is_object());
    client.ready();
    let mut tokens = vec![];
    for _ in 0..8 {
        let reply = client.rpc("media/open", fixed.clone());
        assert_eq!(reply["result"]["asset_ref"], fixed);
        tokens.push(reply["result"]["token"].clone());
    }
    assert_eq!(
        client.rpc("media/open", fixed.clone())["error"]["code"],
        -32001
    );
    let r = client.rpc(
        "media/read",
        json!({"token":tokens[0],"offset":0,"length":8}),
    );
    assert_eq!(r["result"]["base64"], "UklGRgAAEAA=");
    assert_eq!(
        client.rpc(
            "media/read",
            json!({"token":tokens[0],"offset":0,"length":524289})
        )["error"]["code"],
        -32003
    );
    assert!(
        client.rpc(
            "media/read",
            json!({"token":tokens[0],"offset":0,"length":8})
        )["error"]
            .is_object()
    );
    assert!(client.rpc("media/open", fixed.clone())["result"]["token"].is_string());
    for token in tokens {
        assert_eq!(
            client.rpc("media/close", json!({"token":token}))["result"],
            Value::Null
        );
    }
    assert_eq!(
        client.rpc("media/close", json!({"token":"missing"}))["result"],
        Value::Null
    );
    assert_eq!(
        client.rpc("media/open", json!({"file_path":source}))["error"]["code"],
        -32003
    );
    client.rpc("shutdown", json!({}));
    assert!(client.rpc("media/open", fixed)["error"].is_object());
}

#[test]
fn private_stdio_preserves_revisions_conflicts_replay_and_independent_core_readback() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("中文 空格作品");
    let (kernel, doc) = fixture(&path);
    let mut client = Client::open(&path);
    assert_eq!(client.action("hetu.documents.list", json!({})), Value::Null);
    client.ready();
    let catalog = client.action("hetu.capabilities.get", json!({}));
    assert_eq!(catalog["status"], "succeeded");
    let input = json!({"document_id":doc["document"]["document_id"],"base_revision_id":doc["revision"]["revision_id"],"source_format":"markdown","content":"新稿🌧️\r\n","operation_key":"gui-save"});
    let saved = client.action("hetu.documents.save", input.clone());
    assert_eq!(saved["status"], "succeeded", "{saved}");
    assert_eq!(client.action("hetu.documents.save", input.clone()), saved);
    let read = kernel.request(json!({"action":"hetu.documents.get","contract_revision":"1","input":{"document_id":doc["document"]["document_id"]}}));
    assert_eq!(read["data"]["content"], "新稿🌧️\r\n");
    let mut stale = input.clone();
    stale["operation_key"] = json!("stale");
    assert_eq!(
        client.action("hetu.documents.save", stale)["error"]["code"],
        "revision_conflict"
    );
    client.rpc("shutdown", json!({}));
    client.send(json!({"jsonrpc":"2.0","method":"exit"}));
    assert!(client.child.wait().unwrap().success());
    let mut reopened = Client::open(&path);
    reopened.ready();
    assert_eq!(reopened.action("hetu.documents.save", input), saved);
    assert_eq!(reopened.action("hetu.documents.get",json!({"document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"]}))["data"]["content"],"原文🌿\r\n");
}

#[test]
fn handshake_budget_and_notification_cannot_bypass_business_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let (_kernel, _doc) = fixture(root.path());
    let mut client = Client::open(root.path());
    assert_eq!(
        client.rpc(
            "initialize",
            json!({"protocol_version":"2.1","client_name":"test"})
        )["error"]["code"],
        -32602
    );
    assert_eq!(
        client.rpc(
            "initialize",
            json!({"protocol_version":"1","client_name":"test","mode":"author"})
        )["error"]["code"],
        -32602
    );
    client.ready();
    assert_eq!(
        client.rpc("workspace/open", json!({}))["error"]["code"],
        -32601
    );
    client.send(json!({"jsonrpc":"2.0","method":"workspace/request","params":{"action":"hetu.documents.create","contract_revision":"1","input":{"kind":"novel_chapter","title":"不得创建","source_format":"markdown","content":"","operation_key":"notification"}}}));
    assert_eq!(
        client.action("hetu.documents.list", json!({}))["data"]["documents"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    client
        .input
        .write_all(&vec![b'x'; hetu_app_server::MAX_MESSAGE_BYTES + 1])
        .unwrap();
    client.input.write_all(b"\n").unwrap();
    client.input.flush().unwrap();
    assert_eq!(client.read()["error"]["code"], -32600);
    client.input.write_all(b"not-json\n").unwrap();
    client.input.flush().unwrap();
    assert_eq!(client.read()["error"]["code"], -32700);
    assert_eq!(
        client.action("hetu.documents.list", json!({}))["status"],
        "succeeded"
    );
}

#[test]
fn local_host_revokes_plugins_but_has_no_workspace_or_author_actions() {
    use hetu_app_server::Server;
    let private = tempfile::tempdir().unwrap();
    let mut server = Server::local().with_plugin_access_directory(private.path().into());
    let mut rpc = |method: &str, params: Value| {
        server
            .handle(json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .unwrap()
    };
    assert_eq!(
        rpc(
            "initialize",
            json!({"protocol_version":"1","client_name":"local-test"})
        )["result"]["scope"]["kind"],
        "local"
    );
    server.handle(json!({"jsonrpc":"2.0","method":"initialized"}));
    for method in ["workspace/request", "extensions/host", "extensions/request"] {
        let result = server
            .handle(json!({"jsonrpc":"2.0","id":2,"method":method,"params":{}}))
            .unwrap();
        assert_eq!(result["error"]["code"], -32002);
    }
    let result = server.handle(json!({"jsonrpc":"2.0","id":3,"method":"extensions/disable","params":{"plugin_id":"org.hetu.test","package_sha256":"a".repeat(64)}})).unwrap();
    assert_eq!(result["result"]["revoked_count"], 0);
}
