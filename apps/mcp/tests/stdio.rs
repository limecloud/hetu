use hetu_core::Kernel;
use rmcp::model::ServerJsonRpcMessage;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, process::Stdio, sync::OnceLock, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

struct Client {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
    deferred: BTreeMap<u64, Value>,
}

fn binary() -> std::ffi::OsString {
    std::env::var_os("HETU_MCP_TEST_BINARY")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_hetu-mcp").into())
}
fn meta() -> Value {
    json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"hetu-stdio-contract-test","version":"1"}})
}
impl Client {
    fn start(path: &Path) -> Self {
        Self::start_with_home(path, None)
    }
    fn start_with_home(path: &Path, home: Option<&Path>) -> Self {
        let mut command = Command::new(binary());
        if let Some(home) = home {
            command.env("HOME", home);
        }
        let mut child = command
            .arg("--workspace")
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
            next_id: 1,
            deferred: BTreeMap::new(),
        }
    }
    async fn send(&mut self, method: &str, mut params: Value, metadata: bool) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        if metadata {
            params["_meta"] = meta();
        }
        let value = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        self.raw(&value.to_string()).await;
        id
    }
    async fn raw(&mut self, value: &str) {
        self.input.write_all(value.as_bytes()).await.unwrap();
        self.input.write_all(b"\n").await.unwrap();
        self.input.flush().await.unwrap();
    }
    async fn receive(&mut self) -> Value {
        let mut line = String::new();
        let bytes = tokio::time::timeout(Duration::from_secs(10), self.output.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        assert!(bytes > 0, "server closed stdout unexpectedly");
        let response: Value =
            serde_json::from_str(&line).expect("stdout must contain only JSON-RPC");
        serde_json::from_value::<ServerJsonRpcMessage>(response.clone())
            .expect("official SDK must deserialize server response");
        validate_protocol(&response);
        response
    }
    async fn response(&mut self, id: u64) -> Value {
        if let Some(value) = self.deferred.remove(&id) {
            return value;
        }
        loop {
            let value = self.receive().await;
            let response_id = value["id"].as_u64().expect("response ID");
            if response_id == id {
                return value;
            }
            self.deferred.insert(response_id, value);
        }
    }
    async fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params, true).await;
        let response = self.response(id).await;
        if response.get("result").is_some() {
            let name = match method {
                "server/discover" => "DiscoverResult",
                "tools/list" => "ListToolsResult",
                "tools/call" => "CallToolResult",
                "resources/list" => "ListResourcesResult",
                "resources/templates/list" => "ListResourceTemplatesResult",
                "resources/read" => "ReadResourceResult",
                _ => return response,
            };
            validate_schema(name, &response["result"]);
        }
        response
    }
    async fn tool(&mut self, name: &str, args: Value) -> Value {
        let response = self
            .rpc("tools/call", json!({"name":name,"arguments":args}))
            .await;
        assert!(response.get("error").is_none(), "{response}");
        let result = &response["result"];
        let text: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            text, result["structuredContent"],
            "text and structured content must agree"
        );
        let schema: Value = serde_json::from_str(include_str!(
            "../../../contracts/schemas/result.schema.json"
        ))
        .unwrap();
        jsonschema::validate(&schema, &text).unwrap();
        assert_eq!(result["isError"], text.get("error").is_some());
        text
    }
    async fn resource(&mut self, uri: &str) -> Value {
        let response = self.rpc("resources/read", json!({"uri":uri})).await;
        assert!(response.get("error").is_none(), "{response}");
        assert_eq!(response["result"]["contents"][0]["uri"], uri);
        serde_json::from_str(response["result"]["contents"][0]["text"].as_str().unwrap()).unwrap()
    }
    async fn close(mut self) {
        self.input.shutdown().await.unwrap();
        drop(self.input);
        let status = tokio::time::timeout(Duration::from_secs(10), self.child.wait())
            .await
            .expect("EOF must end server")
            .unwrap();
        let mut stderr = String::new();
        self.child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .await
            .unwrap();
        assert!(status.success(), "{status}: {stderr}");
        assert!(
            stderr.is_empty(),
            "normal protocol traffic must not log content: {stderr}"
        );
    }
}
fn validate_protocol(response: &Value) {
    let name = if response.get("error").is_some() {
        "JSONRPCErrorResponse"
    } else {
        "JSONRPCResponse"
    };
    validate_schema(name, response);
}
fn validate_schema(name: &str, response: &Value) {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    static VALIDATORS: OnceLock<BTreeMap<&'static str, jsonschema::Validator>> = OnceLock::new();
    let schema = SCHEMA.get_or_init(|| {
        let text = include_str!("../../../tests/mcp/schema-2026-07-28.json");
        let sources: Value =
            serde_json::from_str(include_str!("../../../docs/research/sources.json")).unwrap();
        let source = sources["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == "mcp-schema-2026-07-28")
            .unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(text.as_bytes())),
            source["sha256"]
        );
        serde_json::from_str(text).unwrap()
    });
    let validators = VALIDATORS.get_or_init(|| {
        [
            "JSONRPCErrorResponse",
            "JSONRPCResponse",
            "DiscoverResult",
            "ListToolsResult",
            "CallToolResult",
            "ListResourcesResult",
            "ListResourceTemplatesResult",
            "ReadResourceResult",
        ]
        .into_iter()
        .map(|name| {
            let mut root = schema.clone();
            root["$ref"] = json!(format!("#/$defs/{name}"));
            (name, jsonschema::validator_for(&root).unwrap())
        })
        .collect()
    });
    if let Some(error) = validators[name].iter_errors(response).next() {
        panic!("official MCP schema: {error}; {response}");
    }
}
fn setup() -> (tempfile::TempDir, Kernel) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("河图 离线测试 🌿");
    let kernel = Kernel::open(json!({"workspace_path":path,"mode":"author","create":{"title":"雾港来信","locale":"zh-CN","operation_key":"init"}})).unwrap();
    (root, kernel)
}
fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":if action == "reviews.decide" {"2"} else {"1"},"input":input}))
}
fn document(k: &Kernel, key: &str) -> Value {
    let result = call(
        k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"第一章 灯塔","source_format":"markdown","content":"# 雨夜\n\n林舟推开门。🌿\n\n“灯还亮着。”\n","operation_key":key}),
    );
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn draft_args(key: &str) -> Value {
    json!({"package":"novel","source_format":"markdown","title":"待审雾港","content":"林舟走向灯塔。🌿\n","blueprint_revision":1,"operation_key":key})
}
fn uri(k: &Kernel, path: &str) -> String {
    format!("hetu://workspace/{}/{path}", k.scope())
}

#[tokio::test]
async fn discovery_and_metadata_are_checked_on_every_request() {
    let (root, k) = setup();
    let mut client = Client::start(&root.path().join("河图 离线测试 🌿"));
    let discovery = client.rpc("server/discover", json!({})).await;
    assert_eq!(
        discovery["result"]["supportedVersions"],
        json!(["2026-07-28"])
    );
    assert_eq!(discovery["result"]["resultType"], "complete");
    assert_eq!(
        discovery["result"]["capabilities"],
        json!({"tools":{},"resources":{}})
    );
    let id = client.send("tools/list", json!({}), false).await;
    assert_eq!(client.response(id).await["error"]["code"], -32602);
    let tools = client.rpc("tools/list", json!({})).await;
    let tools = tools["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 8);
    assert!(
        tools
            .iter()
            .all(|t| !t["name"].as_str().unwrap().contains("approve"))
    );
    for tool in tools {
        jsonschema::validator_for(&tool["inputSchema"]).unwrap();
        jsonschema::validator_for(&tool["outputSchema"]).unwrap();
        assert_eq!(tool["annotations"]["openWorldHint"], false);
    }
    let bad=client.send("tools/list",json!({"_meta":{"io.modelcontextprotocol/protocolVersion":"2025-11-25","io.modelcontextprotocol/clientCapabilities":{}}}),false).await;
    assert_eq!(client.response(bad).await["error"]["code"], -32022);
    let missing = client.send("tools/list", json!({}), false).await;
    assert_eq!(client.response(missing).await["error"]["code"], -32602);
    assert_eq!(
        client.rpc("unknown/method", json!({})).await["error"]["code"],
        -32601
    );
    let caps = client.resource(&uri(&k, "capabilities")).await;
    assert_eq!(caps["data"]["entry_mode"], "agent");
    assert!(
        caps["data"]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a["author_only"] == false)
    );
    client.close().await;
}

#[tokio::test]
async fn fixed_source_pipeline_and_public_review_feedback_work_through_stdio() {
    let (root, k) = setup();
    let source = document(&k, "chapter");
    let mut client = Client::start(&root.path().join("河图 离线测试 🌿"));
    let bible = client.tool("hetu_read_blueprint", json!({})).await;
    assert_eq!(bible["data"]["revision"], 1);
    let sources = json!([{"document_id":source["document"]["document_id"],"revision_id":source["revision"]["revision_id"],"sha256":source["revision"]["sha256"]}]);
    let plot=client.tool("hetu_extract_plot",json!({"document_revisions":sources,"blueprint_revision":1,"options":{},"save_result":true,"operation_key":"extract"})).await;
    assert_eq!(plot["status"], "succeeded", "{plot}");
    assert!(
        plot["data"]["plot"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["verification"] == "needs_author_review")
    );
    let limited=client.tool("hetu_extract_plot",json!({"document_revisions":sources,"blueprint_revision":1,"options":{"max_nodes":1},"save_result":false})).await;
    assert_eq!(
        limited["status"], "partial",
        "limited coverage must remain partial: {limited}"
    );
    let plot_id = &plot["data"]["plot"]["plot_revision_id"];
    let skeleton=client.tool("hetu_build_drama_skeleton",json!({"plot_revision_id":plot_id,"blueprint_revision":1,"episode_options":{},"operation_key":"skeleton"})).await;
    assert!(skeleton.get("error").is_none(), "{skeleton}");
    let report=client.tool("hetu_validate_blueprint",json!({"plot_revision_id":plot_id,"rule_set_version":"1","options":{},"save_report":true,"operation_key":"report"})).await;
    assert!(report.get("error").is_none(), "{report}");
    let submitted = client.tool("hetu_write_draft", draft_args("draft")).await;
    assert_eq!(submitted["data"]["diagnostic_state"], "not_requested");
    let draft = &submitted["data"]["draft"];
    let checked=client.tool("hetu_validate_draft",json!({"draft_id":draft["draft_id"],"expected_draft_revision":draft["revision"],"plot_options":{},"validation_options":{},"operation_key":"check-draft"})).await;
    assert!(checked.get("error").is_none(), "{checked}");
    let began = call(
        &k,
        "reviews.begin",
        json!({"draft_id":draft["draft_id"],"expected_draft_revision":draft["revision"],"operation_key":"begin"}),
    );
    assert_eq!(began["status"], "succeeded", "{began}");
    let view = call(&k, "reviews.get", json!({"draft_id":draft["draft_id"]}));
    let decided = call(
        &k,
        "reviews.decide",
        json!({"draft_id":draft["draft_id"],"expected_draft_revision":view["data"]["draft"]["revision"],"input_snapshot":view["data"]["input_snapshot"],"report_refs":[],"decision":"changes_requested","comments":"请保留林舟的身份。","private_comments":"下一章结局仅作者可见。","operation_key":"return"}),
    );
    assert_eq!(decided["status"], "succeeded", "{decided}");
    let review = client
        .resource(&uri(
            &k,
            &format!("reviews/{}", draft["draft_id"].as_str().unwrap()),
        ))
        .await;
    assert_eq!(
        review["data"]["decisions"][0]["comments"],
        "请保留林舟的身份。"
    );
    assert!(
        review["data"]["decisions"][0]
            .get("private_comments")
            .is_none()
    );
    assert!(!review.to_string().contains("下一章结局"));
    let source_uri = uri(
        &k,
        &format!(
            "documents/{}/revisions/{}",
            source["document"]["document_id"].as_str().unwrap(),
            source["revision"]["revision_id"].as_str().unwrap()
        ),
    );
    assert_eq!(
        client.resource(&source_uri).await["data"]["content"],
        "# 雨夜\n\n林舟推开门。🌿\n\n“灯还亮着。”\n"
    );
    client.close().await;
}

#[tokio::test]
async fn restart_replays_original_write_and_recovers_unicode_operation_key() {
    let (root, k) = setup();
    let path = root.path().join("河图 离线测试 🌿");
    let key = "雾港 key + & ? 🌿";
    let mut first = Client::start(&path);
    let result = first.tool("hetu_write_draft", draft_args(key)).await;
    assert_eq!(result["status"], "succeeded", "{result}");
    first.close().await;
    let mut second = Client::start(&path);
    assert_eq!(
        second.tool("hetu_write_draft", draft_args(key)).await,
        result
    );
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("action", "hetu.drafts.submit")
        .append_pair("key", key)
        .finish();
    let recovered = second
        .resource(&uri(&k, &format!("operations/by-key?{query}")))
        .await;
    assert_eq!(recovered["data"]["original_result"], result);
    let by_id = second
        .resource(&uri(
            &k,
            &format!("operations/{}", result["operation"]["id"].as_str().unwrap()),
        ))
        .await;
    assert_eq!(by_id["data"]["original_result"], result);
    let mut changed = draft_args(key);
    changed["content"] = json!("同键不同参数");
    assert_eq!(
        second.tool("hetu_write_draft", changed).await["error"]["code"],
        "idempotency_conflict"
    );
    let queue = second.resource(&uri(&k, "reviews")).await;
    assert_eq!(queue["data"]["reviews"].as_array().unwrap().len(), 1);
    second.close().await;
}

#[tokio::test]
async fn paths_queries_and_author_identity_cannot_escape_agent_scope() {
    let (root, k) = setup();
    let mut client = Client::start(&root.path().join("河图 离线测试 🌿"));
    for name in [
        "hetu_unlock_blueprint",
        "hetu_approve_draft",
        "hetu.documents.save",
        "execute",
    ] {
        assert_eq!(
            client
                .rpc("tools/call", json!({"name":name,"arguments":{}}))
                .await["error"]["code"],
            -32601
        );
    }
    let mut args = draft_args("impersonation");
    args["mode"] = json!("author");
    assert_eq!(
        client.tool("hetu_write_draft", args).await["error"]["code"],
        "invalid_input"
    );
    assert_eq!(
        client
            .tool("hetu_read_blueprint", json!({"revision":-1}))
            .await["error"]["code"],
        "invalid_input"
    );
    for path in [
        "../.heturc.json",
        "documents/%2e%2e/secret",
        "documents/a%2fb",
        "documents?limit=1&limit=2",
        "blueprint?path=/etc/passwd",
        "reviews?author=true",
        "documents?limit=9999",
        "capabilities#secret",
    ] {
        assert_eq!(
            client
                .rpc("resources/read", json!({"uri":uri(&k,path)}))
                .await["error"]["code"],
            -32602,
            "{path}"
        );
    }
    for path in [
        "file:///etc/passwd",
        "hetu://workspace/workspace_00000000-0000-4000-8000-000000000000/blueprint",
    ] {
        assert_eq!(
            client.rpc("resources/read", json!({"uri":path})).await["error"]["code"],
            -32602
        );
    }
    assert_eq!(
        client.resource(&uri(&k, "reviews")).await["data"]["reviews"],
        json!([])
    );
    client.close().await;
}

#[tokio::test]
async fn document_pagination_is_snapshot_bound_and_resources_are_discoverable() {
    let (root, k) = setup();
    document(&k, "one");
    document(&k, "two");
    document(&k, "three");
    let mut client = Client::start(&root.path().join("河图 离线测试 🌿"));
    let directory = client.rpc("resources/list", json!({})).await;
    assert_eq!(
        directory["result"]["resources"].as_array().unwrap().len(),
        11
    );
    let templates = client.rpc("resources/templates/list", json!({})).await;
    assert!(
        templates["result"]["resourceTemplates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["uriTemplate"]
                .as_str()
                .unwrap()
                .contains("operations/by-key"))
    );
    let first = client.resource(&uri(&k, "documents?limit=1")).await;
    assert_eq!(first["data"]["documents"].as_array().unwrap().len(), 1);
    assert_eq!(first["data"]["mcp_resources"].as_array().unwrap().len(), 1);
    let next = first["data"]["mcp_next_page_uri"].as_str().unwrap();
    let second = client.resource(next).await;
    assert_ne!(
        first["data"]["documents"][0]["document_id"],
        second["data"]["documents"][0]["document_id"]
    );
    let fixed = first["data"]["mcp_resources"][0]["uri"].as_str().unwrap();
    assert!(client.resource(fixed).await["data"]["content"].is_string());
    document(&k, "four");
    assert_eq!(
        client.rpc("resources/read", json!({"uri":next})).await["error"]["code"],
        -32602
    );
    client.close().await;
}

#[tokio::test]
async fn malformed_and_oversized_lines_are_rejected_without_breaking_the_stream() {
    let (root, _) = setup();
    let mut client = Client::start(&root.path().join("河图 离线测试 🌿"));
    client.raw("{invalid-json").await;
    client
        .raw(&" ".repeat(hetu_mcp::MAX_MESSAGE_BYTES + 1))
        .await;
    assert!(client.rpc("tools/list", json!({})).await["result"]["tools"].is_array());
    client.close().await;
    Client::start(&root.path().join("河图 离线测试 🌿"))
        .close()
        .await;
}

#[tokio::test]
async fn explicit_workspace_is_required_and_identity_flags_are_rejected() {
    for args in [
        vec![],
        vec!["--workspace", "relative"],
        vec!["--workspace", "/missing/hetu"],
        vec!["--workspace", "/tmp", "--mode", "author"],
    ] {
        let output = Command::new(binary()).args(args).output().await.unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}

#[tokio::test]
async fn cancellation_and_eof_recover_with_the_original_key_without_duplicate_drafts() {
    let (root, k) = setup();
    let path = root.path().join("河图 离线测试 🌿");
    let mut args = draft_args("cancel-and-recover");
    args["content"] = json!("林舟走向灯塔。🌿\n".repeat(30000));
    let mut first = Client::start(&path);
    let id = first
        .send(
            "tools/call",
            json!({"name":"hetu_write_draft","arguments":args}),
            true,
        )
        .await;
    first.raw(&json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id,"reason":"author cancelled waiting"}}).to_string()).await;
    assert!(first.rpc("tools/list", json!({})).await["result"]["tools"].is_array());
    first.close().await;
    let mut second = Client::start(&path);
    let result = second.tool("hetu_write_draft", args.clone()).await;
    assert_eq!(result["status"], "succeeded", "{result}");
    assert_eq!(second.tool("hetu_write_draft", args).await, result);
    let queue = second.resource(&uri(&k, "reviews")).await;
    assert_eq!(queue["data"]["reviews"].as_array().unwrap().len(), 1);
    let operation = second
        .resource(&uri(
            &k,
            &format!("operations/{}", result["operation"]["id"].as_str().unwrap()),
        ))
        .await;
    assert_eq!(operation["data"]["original_result"], result);
    second.close().await;
}

#[tokio::test]
async fn official_sdk_client_discovers_calls_and_reads_the_native_process() {
    use rmcp::{
        ClientHandler, ClientLifecycleMode, ClientServiceExt,
        model::{CallToolRequestParams, ProtocolVersion, ReadResourceRequestParams},
    };
    struct SdkClient;
    impl ClientHandler for SdkClient {}
    let (root, k) = setup();
    let mut child = Command::new(binary())
        .arg("--workspace")
        .arg(root.path().join("河图 离线测试 🌿"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let transport = (child.stdout.take().unwrap(), child.stdin.take().unwrap());
    let client = tokio::time::timeout(
        Duration::from_secs(10),
        SdkClient.serve_with_lifecycle(
            transport,
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(client.list_tools(None).await.unwrap().tools.len(), 8);
    let result = client
        .call_tool(CallToolRequestParams::new("hetu_read_blueprint"))
        .await
        .unwrap();
    assert_eq!(
        result.structured_content.as_ref().unwrap()["data"]["revision"],
        1
    );
    assert_eq!(result.is_error, Some(false));
    let resource = client
        .read_resource(ReadResourceRequestParams::new(uri(&k, "workspace")))
        .await
        .unwrap();
    assert_eq!(resource.contents.len(), 1);
    client.cancel().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}

#[tokio::test]
async fn git_snapshot_requires_author_approval_and_recovers_across_server_restart() {
    let (root, _) = setup();
    let path = root.path().join("河图 离线测试 🌿");
    let author = Kernel::open(json!({"workspace_path":path,"mode":"author","authorization_path":root.path().join("Library/Application Support/Hetu/Authorizations")})).unwrap();
    assert_eq!(
        call(
            &author,
            "git.init",
            json!({"branch":"main","operation_key":"git-init"})
        )["status"],
        "succeeded"
    );
    let mut client = Client::start_with_home(&path, Some(root.path()));
    let status = client.resource(&uri(&author, "git/status")).await;
    let input = json!({"phase":"prepare","expected_head":status["data"]["head"],"message":"MCP 保存雾港 🌿","author":{"name":"河图作者","email":"author@hetu.test"},"operation_key":"mcp-git-prepare"});
    let prepared = client.tool("hetu_commit_snapshot", input.clone()).await;
    assert_eq!(prepared["status"], "pending");
    let snapshot = &prepared["data"]["snapshot"];
    let id = snapshot["snapshot_id"].as_str().unwrap();
    let fixed = client
        .resource(&uri(&author, &format!("git/snapshots/{id}")))
        .await;
    assert_eq!(fixed["data"]["snapshot"], *snapshot);
    let list = client
        .resource(&uri(&author, "git/snapshots?limit=1"))
        .await;
    assert_eq!(list["data"]["snapshots"][0]["snapshot_id"], id);
    assert_eq!(
        list["data"]["mcp_resources"][0]["uri"],
        uri(&author, &format!("git/snapshots/{id}"))
    );
    let execute = json!({"phase":"execute","snapshot_id":id,"operation_key":"mcp-git-execute"});
    assert_eq!(
        client.tool("hetu_commit_snapshot", execute.clone()).await["error"]["code"],
        "hetu.author_confirmation_required"
    );
    assert_eq!(
        client
            .rpc(
                "tools/call",
                json!({"name":"hetu.git.approve_snapshot","arguments":{}})
            )
            .await["error"]["code"],
        -32601
    );
    let approved = call(
        &author,
        "git.approve_snapshot",
        json!({"snapshot_id":id,"snapshot_sha256":prepared["data"]["snapshot_sha256"],"operation_key":"author-approve"}),
    );
    assert_eq!(approved["status"], "succeeded", "{approved}");
    let result = client.tool("hetu_commit_snapshot", execute.clone()).await;
    assert_eq!(result["status"], "succeeded", "{result}");
    client.close().await;
    let mut restarted = Client::start_with_home(&path, Some(root.path()));
    assert_eq!(
        restarted.tool("hetu_commit_snapshot", execute).await,
        result
    );
    assert_eq!(
        restarted.tool("hetu_commit_snapshot", input).await,
        prepared
    );
    let history = restarted.resource(&uri(&author, "git/log?limit=1")).await;
    assert_eq!(
        history["data"]["commits"][0]["commit_id"],
        result["data"]["commit_id"]
    );
    assert_eq!(
        restarted.resource(&uri(&author, "git/status")).await["data"]["changes"],
        json!([])
    );
    restarted.close().await;
}
