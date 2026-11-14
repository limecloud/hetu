//! 作者显式配置的 OpenAI 兼容渠道；不读取 Agent 环境中的密钥。
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

const IMAGE_LIMIT: usize = 20 * 1024 * 1024;
fn valid_model(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().next().is_some_and(|c| c.is_ascii_lowercase())
        && value
            .bytes()
            .all(|c| (c.is_ascii_lowercase() || c.is_ascii_digit()) || b"_.-".contains(&c))
}
fn base_url(value: &str) -> Result<String> {
    let url = url::Url::parse(value).map_err(|_| Error::new("invalid_input", "渠道地址无效。"))?;
    ensure(
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && matches!(url.path(), "" | "/" | "/v1" | "/v1/"),
        "invalid_input",
        "请使用 HTTPS 渠道地址，可包含 /v1，不要填写接口后缀或凭据。",
    )?;
    Ok(format!("{}/v1", url.origin().ascii_serialization()))
}
pub(super) fn identity(settings: &Value, channel: &str) -> Result<Value> {
    crate::domain::checked_id(channel, "channel")?;
    let profile = &settings["custom_channels"][channel];
    ensure(
        profile.is_object() && profile["credential_ref"].is_string(),
        "hetu.model_connection_required",
        "请在设置中配置此渠道的密钥。",
    )?;
    ensure(
        base_url(text(profile, "base_url")?)? == profile["base_url"]
            && ["text", "image"].iter().all(|kind| {
                profile["models"][kind].as_array().is_some_and(|items| {
                    items.len() <= 32 && items.iter().all(|v| v.as_str().is_some_and(valid_model))
                })
            }),
        "hetu.integrity_failure",
        "渠道配置已损坏，请在设置中检查。",
    )?;
    Ok(
        json!({"channel":"custom","channel_id":channel,"origin":profile["base_url"],"profile_sha256":plan_digest(profile)?,"credential_ref":profile["credential_ref"]}),
    )
}
impl ModelService {
    pub(super) fn save_custom(&self, input: &Value) -> Result<Value> {
        let name = text(input, "name")?;
        ensure(
            !name.trim().is_empty() && name.len() <= 200,
            "invalid_input",
            "请填写渠道名称。",
        )?;
        let base = base_url(text(input, "base_url")?)?;
        let models = &input["models"];
        for kind in ["text", "image"] {
            let items = models[kind]
                .as_array()
                .ok_or_else(|| Error::new("invalid_input", "请分别填写文字和图片模型列表。"))?;
            ensure(
                items.len() <= 32 && items.iter().all(|v| v.as_str().is_some_and(valid_model)),
                "invalid_input",
                "模型代码无效或超过32项。",
            )?;
            let unique: std::collections::BTreeSet<_> =
                items.iter().filter_map(Value::as_str).collect();
            ensure(
                unique.len() == items.len(),
                "invalid_input",
                "同一类型的模型代码不能重复。",
            )?;
        }
        ensure(
            models["text"].as_array().unwrap().len() + models["image"].as_array().unwrap().len()
                > 0,
            "invalid_input",
            "请至少配置一个模型。",
        )?;
        let _lock = self.store.lock()?;
        self.store.recover()?;
        let mut settings = self.settings()?;
        let channel = input["channel_id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| crate::domain::id("channel"));
        crate::domain::checked_id(&channel, "channel")?;
        let previous = &settings["custom_channels"][&channel];
        let key = input["api_key"].as_str().filter(|s| !s.is_empty());
        ensure(
            key.is_some() || previous["base_url"] == base && previous["credential_ref"].is_string(),
            "invalid_input",
            "新渠道或地址变更后需重新填写密钥。",
        )?;
        let credential = if let Some(key) = key {
            ensure(
                key.len() <= 8192 && !key.chars().any(char::is_whitespace),
                "invalid_input",
                "密钥格式无效。",
            )?;
            let reference = crate::domain::id("credential");
            // 私密目录、0600文件及事务均由Store维护；设置和Agent回读仅含引用。
            self.store.install(
                &format!("credentials/{reference}.json"),
                &encoded(&json!({"api_key":key}))?,
                true,
            )?;
            reference
        } else {
            text(previous, "credential_ref")?.to_owned()
        };
        let profile =
            json!({"name":name.trim(),"base_url":base,"models":models,"credential_ref":credential});
        settings["custom_channels"][&channel] = profile.clone();
        self.save(&settings)?;
        Ok(json!({"channel_id":channel,"profile":profile}))
    }
    fn custom_profile(&self, expected: &Value) -> Result<Value> {
        let settings = self.settings()?;
        let channel = text(expected, "channel_id")?;
        ensure(
            identity(&settings, channel)? == *expected,
            "forbidden",
            "渠道地址、密钥或模型配置已变化，请使用原配置恢复。",
        )?;
        Ok(settings["custom_channels"][channel].clone())
    }
    pub(super) fn custom_api(
        &self,
        method: &str,
        path: &str,
        input: Option<&Value>,
        expected: &Value,
    ) -> Result<Value> {
        self.custom_api_with(
            method,
            path,
            input,
            expected,
            |profile, key, payload, kind| {
                let client = reqwest::blocking::Client::builder()
                    .retry(reqwest::retry::never())
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(10))
                    .timeout(Duration::from_secs(240))
                    .build()
                    .map_err(|_| {
                        Error::new("hetu.model_service_unavailable", "无法初始化渠道连接。")
                    })?;
                let endpoint = if kind == "image" {
                    "images/generations"
                } else {
                    "chat/completions"
                };
                let response = client
                    .post(format!("{}/{endpoint}", text(profile, "base_url")?))
                    .bearer_auth(key)
                    .json(payload)
                    .send()
                    .map_err(|_| {
                        Error::new(
                            "hetu.model_outcome_unknown",
                            "提供方结果未知；保留原计划，不要重复生成。",
                        )
                    })?;
                ensure(
                    response.status().is_success(),
                    "hetu.model_provider_rejected",
                    "渠道未返回成功结果，请检查模型、Key和余额；河图不会自动重发此计划。",
                )?;
                let maximum = (IMAGE_LIMIT * 4 / 3 + 65536) as u64;
                let mut bytes = Vec::new();
                response
                    .take(maximum + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| {
                        Error::new(
                            "hetu.model_outcome_unknown",
                            "渠道响应中断；保留原计划，不要重复生成。",
                        )
                    })?;
                ensure(
                    bytes.len() as u64 <= maximum,
                    "hetu.budget_exceeded",
                    "渠道响应超过图片交付上限。",
                )?;
                serde_json::from_slice(&bytes).map_err(|_| {
                    Error::new(
                        "hetu.model_outcome_unknown",
                        "渠道返回格式无效；不能据此重复生成。",
                    )
                })
            },
        )
    }
    fn custom_api_with(
        &self,
        method: &str,
        path: &str,
        input: Option<&Value>,
        expected: &Value,
        send: impl FnOnce(&Value, &str, &Value, &str) -> Result<Value>,
    ) -> Result<Value> {
        if let Some(kind) = path.strip_prefix("/models/") {
            ensure(
                method == "GET" && matches!(kind, "text" | "image"),
                "invalid_input",
                "目录请求无效。",
            )?;
            let _lock = self.store.read_lock()?;
            let profile = self.custom_profile(expected)?;
            let items: Vec<_> = profile["models"][kind].as_array().ok_or_else(|| Error::new("hetu.integrity_failure", "渠道模型配置无效。"))?.iter().map(|id| json!({"id":id,"kind":if kind=="image" {"image"} else {"structured_text"},"billing":{"mode":"provider","max_requests":1},"limits":{"max_prompt_bytes":16384,"max_input_bytes":32768,"max_instruction_bytes":8192}})).collect();
            return Ok(json!({"kind":kind,"channel":expected,"items":items}));
        }
        let key = path
            .strip_prefix("/operations/")
            .ok_or_else(|| Error::new("invalid_input", "渠道操作路径无效。"))?;
        ensure(
            matches!(method, "GET" | "POST"),
            "invalid_input",
            "渠道操作方法无效。",
        )?;
        crate::domain::checked_id(key, "model")?;
        let journal = format!("operations/{key}.json");
        let (profile, secret, kind, wire, input_sha) = {
            let _lock = self.store.lock()?;
            self.store.recover()?;
            let profile = self.custom_profile(expected)?;
            if self.store.exists(&journal)? {
                let saved = self.store.json(&journal)?;
                ensure(
                    saved["connection"] == *expected,
                    "forbidden",
                    "原操作属于其他渠道或凭据版本。",
                )?;
                if let Some(input) = input {
                    ensure(
                        saved["input_sha256"] == plan_digest(input)?,
                        "revision_conflict",
                        "原操作输入已变化。",
                    )?;
                }
                return Ok(saved["result"].clone());
            }
            ensure(
                method == "POST",
                "hetu.model_result_pending",
                "原操作未取得可恢复结果；不能自动重发。",
            )?;
            let input = input.ok_or_else(|| Error::new("invalid_input", "缺少固定生成输入。"))?;
            let kind = text(input, "kind")?.to_owned();
            ensure(
                self.selected_identity(&self.settings()?, &kind)? == *expected,
                "forbidden",
                "当前模型渠道已切换，请核对原计划。",
            )?;
            ensure(
                matches!(kind.as_str(), "text" | "image")
                    && input["provider_billing_accepted"] == true,
                "hetu.author_confirmation_required",
                "请作者明确批准供应商单次计费。",
            )?;
            let payload = &input["payload"];
            let model = text(payload, "model_id")?;
            ensure(
                profile["models"][&kind]
                    .as_array()
                    .is_some_and(|items| items.contains(&json!(model))),
                "invalid_input",
                "模型不属于此渠道。",
            )?;
            let wire = if kind == "image" {
                json!({"model":model,"prompt":payload["prompt"],"n":1,"size":"1024x1024","response_format":"b64_json"})
            } else {
                json!({"model":model,"messages":[{"role":"system","content":payload["instructions"].as_str().unwrap_or("Return JSON with one nonempty string field named text.")},{"role":"user","content":payload["input"]}],"response_format":{"type":"json_schema","json_schema":{"name":"hetu_text","strict":true,"schema":payload["output_schema"]}}})
            };
            let credential = text(&profile, "credential_ref")?;
            crate::domain::checked_id(credential, "credential")?;
            let secret = text(
                &self.store.json(&format!("credentials/{credential}.json"))?,
                "api_key",
            )?
            .to_owned();
            let input_sha = plan_digest(input)?;
            let result = json!({"operation_key":key,"kind":kind,"operation":{"id":format!("custom-{key}"),"model_id":model,"status":"reconciling","billing":{"mode":"provider","max_requests":1}}});
            self.store.transaction(&BTreeMap::from([(
                journal.clone(),
                encoded(&json!({"connection":expected,"input_sha256":input_sha,"result":result}))?,
            )]))?;
            (profile, secret, kind, wire, input_sha)
        };
        // 不持有作品或连接锁；发送标记已落盘，重启及并发调用仅回读本机原结果。
        let response = send(&profile, &secret, &wire, &kind)?;
        let mut media = None;
        let output = if kind == "image" {
            ensure(
                response["data"].as_array().is_some_and(|a| a.len() == 1),
                "hetu.integrity_failure",
                "渠道必须只返回一张图片。",
            )?;
            let encoded = text(&response["data"][0], "b64_json")?;
            ensure(
                encoded.len() <= IMAGE_LIMIT * 4 / 3 + 4,
                "hetu.budget_exceeded",
                "图片超过20 MiB。",
            )?;
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| Error::new("hetu.integrity_failure", "图片编码无效。"))?;
            ensure(
                bytes.len() <= IMAGE_LIMIT,
                "hetu.budget_exceeded",
                "图片超过20 MiB。",
            )?;
            let decoded = crate::infrastructure::media::decode_image_bytes(&bytes)?;
            let output = json!({"sha256":digest(&bytes),"size":bytes.len(),"mime_type":decoded.scan["media_type"],"width":decoded.decoded.width(),"height":decoded.decoded.height()});
            media = Some(bytes);
            output
        } else {
            let content = text(&response["choices"][0]["message"], "content")?;
            ensure(
                content.len() <= 65536,
                "hetu.budget_exceeded",
                "文字结果超过预算。",
            )?;
            let output: Value = serde_json::from_str(content).map_err(|_| {
                Error::new("hetu.integrity_failure", "文字结果不符合固定JSON合同。")
            })?;
            ensure(
                output.as_object().is_some_and(|v| v.len() == 1)
                    && output["text"]
                        .as_str()
                        .is_some_and(|s| !s.trim().is_empty() && !s.contains('\0')),
                "hetu.integrity_failure",
                "文字结果必须只含非空text字段。",
            )?;
            output
        };
        let _lock = self.store.lock()?;
        self.store.recover()?;
        let mut saved = self.store.json(&journal)?;
        ensure(
            saved["input_sha256"] == input_sha && saved["connection"] == *expected,
            "hetu.integrity_failure",
            "原操作记录已变化。",
        )?;
        if let Some(bytes) = media {
            self.store.import_media_bytes(
                &format!("operations/{key}.image"),
                &bytes,
                &json!({"sha256":output["sha256"],"size_bytes":bytes.len()}),
            )?;
        }
        saved["result"]["operation"]["status"] = json!("succeeded");
        saved["result"]["operation"]["output"] = output;
        self.store
            .transaction(&BTreeMap::from([(journal, encoded(&saved)?)]))?;
        Ok(saved["result"].clone())
    }
    pub(super) fn custom_image(&self, key: &str, expected: &Value) -> Result<Vec<u8>> {
        crate::domain::checked_id(key, "model")?;
        let _lock = self.store.read_lock()?;
        self.custom_profile(expected)?;
        let saved = self.store.json(&format!("operations/{key}.json"))?;
        ensure(
            saved["connection"] == *expected
                && saved["result"]["kind"] == "image"
                && saved["result"]["operation"]["status"] == "succeeded",
            "hetu.model_result_pending",
            "原图片尚未生成成功。",
        )?;
        let mut bytes = Vec::new();
        self.store
            .managed_media(&format!("operations/{key}.image"))?
            .take(IMAGE_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)?;
        ensure(
            bytes.len() <= IMAGE_LIMIT
                && digest(&bytes) == saved["result"]["operation"]["output"]["sha256"],
            "hetu.integrity_failure",
            "本机原图片与回执不符。",
        )?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    fn service() -> (tempfile::TempDir, ModelService, Value, String) {
        let root = tempfile::tempdir().unwrap();
        let service = ModelService::open(root.path()).unwrap();
        let profile = service.author_request("custom_save", &json!({"name":"本机测试","base_url":"https://provider.test","api_key":"private-fixture-key","models":{"text":["text-one"],"image":["image-one"]}})).unwrap();
        for kind in ["text", "image"] {
            service
                .author_request(
                    "channel_select",
                    &json!({"kind":kind,"channel_id":profile["channel_id"]}),
                )
                .unwrap();
        }
        let identity = service.identity_for("image").unwrap();
        (root, service, identity, crate::domain::id("model"))
    }
    fn input() -> Value {
        json!({"kind":"image","provider_billing_accepted":true,"payload":{"model_id":"image-one","prompt":"固定的获权提示"}})
    }
    fn png() -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::RgbImage::new(64, 64)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }
    #[test]
    fn custom_credentials_stay_private_and_connection_changes_invalidate_old_plans() {
        use std::os::unix::fs::PermissionsExt;
        let (root, service, identity, _) = service();
        let settings = service.author_request("inspect", &json!({})).unwrap();
        let catalog = service
            .custom_api_with(
                "GET",
                "/models/image",
                None,
                &identity,
                |_, _, _, _| panic!(),
            )
            .unwrap();
        for value in [&settings, &catalog, &identity] {
            assert!(!value.to_string().contains("private-fixture-key"));
        }
        let key_path = root.path().join(format!(
            "credentials/{}.json",
            identity["credential_ref"].as_str().unwrap()
        ));
        assert_eq!(
            std::fs::metadata(key_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(root.path().join("credentials"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let mut edit = json!({"channel_id":identity["channel_id"],"name":"编辑","base_url":"https://other.test","models":{"text":["text-one"],"image":["image-one"]}});
        assert!(service.author_request("custom_save", &edit).is_err());
        edit["api_key"] = json!("replacement-key");
        service.author_request("custom_save", &edit).unwrap();
        assert_eq!(
            service
                .custom_api_with(
                    "GET",
                    "/models/image",
                    None,
                    &identity,
                    |_, _, _, _| panic!()
                )
                .unwrap_err()
                .code,
            "forbidden"
        );
    }
    #[test]
    fn unknown_provider_request_is_sent_once_and_only_original_journal_can_be_read() {
        let (root, service, identity, key) = service();
        let path = format!("/operations/{key}");
        let calls = Cell::new(0);
        let send = |_: &Value, key: &str, wire: &Value, _: &str| {
            calls.set(calls.get() + 1);
            assert_eq!(key, "private-fixture-key");
            assert_eq!(wire["n"], 1);
            // 网络期间不占连接锁，原标记已可读取。
            let _lock = service.store.lock().unwrap();
            Err(Error::new("hetu.model_outcome_unknown", "断开"))
        };
        assert!(
            service
                .custom_api_with("POST", &path, Some(&input()), &identity, send)
                .is_err()
        );
        let recovered = service
            .custom_api_with("POST", &path, Some(&input()), &identity, |_, _, _, _| {
                panic!("不得重发")
            })
            .unwrap();
        assert_eq!(recovered["operation"]["status"], "reconciling");
        assert_eq!(calls.get(), 1);
        let mut changed = input();
        changed["payload"]["prompt"] = json!("变化");
        assert!(
            service
                .custom_api_with(
                    "POST",
                    &path,
                    Some(&changed),
                    &identity,
                    |_, _, _, _| panic!()
                )
                .is_err()
        );
        assert!(
            service
                .custom_api_with(
                    "GET",
                    &format!("/operations/{}", crate::domain::id("model")),
                    None,
                    &identity,
                    |_, _, _, _| panic!()
                )
                .is_err()
        );
        assert!(
            !std::fs::read_to_string(root.path().join(format!("operations/{key}.json")))
                .unwrap()
                .contains("固定的获权提示")
        );
    }
    #[test]
    fn provider_image_is_fully_decoded_and_corrupt_or_multiple_results_never_succeed() {
        for variant in ["valid", "corrupt", "multiple"] {
            let (_root, service, identity, key) = service();
            let path = format!("/operations/{key}");
            let bytes = png();
            let encoded = STANDARD.encode(if variant == "corrupt" {
                &bytes[..bytes.len() / 2]
            } else {
                &bytes
            });
            let response = if variant == "multiple" {
                json!({"data":[{"b64_json":encoded},{"b64_json":encoded}]})
            } else {
                json!({"data":[{"b64_json":encoded}]})
            };
            let result =
                service.custom_api_with("POST", &path, Some(&input()), &identity, |_, _, _, _| {
                    Ok(response)
                });
            if variant == "valid" {
                assert_eq!(
                    result.unwrap()["operation"]["output"]["sha256"],
                    digest(&bytes)
                );
                assert_eq!(service.custom_image(&key, &identity).unwrap(), bytes);
                assert_eq!(
                    service
                        .custom_api_with("GET", &path, None, &identity, |_, _, _, _| panic!())
                        .unwrap()["operation"]["status"],
                    "succeeded"
                );
            } else {
                assert!(result.is_err());
                assert!(service.custom_image(&key, &identity).is_err());
                assert_eq!(
                    service
                        .custom_api_with("GET", &path, None, &identity, |_, _, _, _| panic!())
                        .unwrap()["operation"]["status"],
                    "reconciling"
                );
            }
        }
    }
    #[test]
    fn custom_requests_require_provider_billing_approval_and_text_has_closed_output() {
        let (_root, service, identity, key) = service();
        let path = format!("/operations/{key}");
        let mut body = input();
        body["provider_billing_accepted"] = json!(false);
        assert_eq!(
            service
                .custom_api_with("POST", &path, Some(&body), &identity, |_, _, _, _| panic!())
                .unwrap_err()
                .code,
            "hetu.author_confirmation_required"
        );
        body = json!({"kind":"text","provider_billing_accepted":true,"payload":{"model_id":"text-one","input":"固定输入","output_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}}});
        let value = service
            .custom_api_with("POST", &path, Some(&body), &identity, |_, _, wire, kind| {
                assert_eq!(kind, "text");
                assert_eq!(wire["messages"][1]["content"], "固定输入");
                Ok(json!({"choices":[{"message":{"content":"{\"text\":\"参考结果\"}"}}]}))
            })
            .unwrap();
        assert_eq!(value["operation"]["output"], json!({"text":"参考结果"}));
    }
}
