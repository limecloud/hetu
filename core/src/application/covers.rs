use super::*;
use crate::infrastructure::media as files;
use std::{collections::BTreeSet, fs::File};

const ROOT: &str = "packages/visual-prompt/covers";

pub(super) fn definition(name: &str) -> Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    let source = SCHEMA.get_or_init(|| {
        let mut source: Value = serde_json::from_str(include_str!(
            "../../../contracts/schemas/book-cover.schema.json"
        ))
        .expect("embedded cover schema");
        let creative: Value = serde_json::from_str(include_str!(
            "../../../contracts/schemas/creative-task.schema.json"
        ))
        .expect("embedded creative task schema");
        fn resolve(value: &mut Value, prefix: &str) {
            match value {
                Value::Object(object) => {
                    if let Some(reference) = object.get_mut("$ref")
                        && let Some(name) = reference.as_str().and_then(|r| r.strip_prefix(prefix))
                    {
                        *reference = json!(format!("#/$defs/creative_{name}"));
                    }
                    for child in object.values_mut() {
                        resolve(child, prefix);
                    }
                }
                Value::Array(array) => {
                    for child in array {
                        resolve(child, prefix);
                    }
                }
                _ => {}
            }
        }
        resolve(&mut source, "creative-task.schema.json#/$defs/");
        for (name, definition) in creative["$defs"].as_object().unwrap() {
            let mut definition = definition.clone();
            resolve(&mut definition, "#/$defs/");
            source["$defs"][format!("creative_{name}")] = definition;
        }
        source
    });
    domain::schema::definition(source, name)
}
fn request_path(request: &str) -> Result<String> {
    checked_id(request, "cover_request")?;
    Ok(format!("{ROOT}/requests/{request}.json"))
}
fn expected(value: &Value) -> Value {
    json!({"revision":value["revision"],"sha256":digest(bytes(value).expect("JSON record"))})
}
fn dimensions(image: &files::VerifiedImage) -> (u32, u32) {
    (image.decoded.width(), image.decoded.height())
}
fn cover_preview(image: &image::DynamicImage, presentation: &Value) -> Result<Value> {
    let rect = &presentation["crop_rect"];
    let x = (rect["x"].as_f64().unwrap() * f64::from(image.width())).floor() as u32;
    let y = (rect["y"].as_f64().unwrap() * f64::from(image.height())).floor() as u32;
    let width =
        ((rect["width"].as_f64().unwrap() * f64::from(image.width())).round() as u32).max(1);
    let height =
        ((rect["height"].as_f64().unwrap() * f64::from(image.height())).round() as u32).max(1);
    ensure(
        x < image.width() && y < image.height(),
        "invalid_input",
        "裁切范围没有可用像素。",
    )?;
    files::image_preview(&image.crop_imm(
        x,
        y,
        width.min(image.width() - x),
        height.min(image.height() - y),
    ))
}

impl Kernel {
    pub(super) fn inspect_cover_file(&self, input: &Value) -> Result<Value> {
        let mut file = files::selected_file(Path::new(text(input, "file_path")?))?;
        let image = files::decode_image(&mut file)?;
        Ok(
            json!({"sha256":image.scan["sha256"],"size_bytes":image.scan["size_bytes"],"media_type":image.scan["media_type"],"width":image.decoded.width(),"height":image.decoded.height(),"preview":files::image_preview(&image.decoded)?}),
        )
    }
    fn has_covers(&self) -> Result<bool> {
        Ok(self
            .store
            .entries("packages/visual-prompt")?
            .iter()
            .any(|name| name == "covers"))
    }
    fn cover_request(&self, request_id: &str) -> Result<(Value, String)> {
        let raw = self.store.read(&request_path(request_id)?)?;
        let request: Value = serde_json::from_slice(&raw)?;
        schema(&request, &definition("request"))?;
        ensure(
            request["workspace_id"] == self.scope()
                && request["request_id"] == request_id
                && request["output_relative_dir"] == format!("{ROOT}/inbox/{request_id}"),
            "hetu.integrity_failure",
            "封面请求的作品、身份或输出目录不一致。",
        )?;
        Ok((request, digest(raw)))
    }
    pub(super) fn preview_cover_prompt(&self, input: &Value) -> Result<Value> {
        let book = &input["book"];
        let design = &input["design"];
        ensure(
            !text(book, "title")?.trim().is_empty()
                && !text(design, "art_direction")?.trim().is_empty()
                && integer(design, "width")? * integer(design, "height")? <= 64_000_000,
            "invalid_input",
            "请填写书名和视觉方向，并检查目标尺寸。",
        )?;
        let request_id = id("cover_request");
        let prompt = if input["language_tag"] == "en" {
            format!(
                "Design {} cover reference(s) at {}×{} pixels.\nBook title (keep exact): {}\nAuthor name (keep exact): {}\nSynopsis: {}\nVisual direction: {}\nText mode: {}\nCover text language: {}\nUse the host's available image capability. Save actual images and an accurate result.json in the assigned inbox. Do not modify author documents or select the cover. Report unavailable capabilities and actual image dimensions; never stretch an image.",
                design["candidate_count"],
                design["width"],
                design["height"],
                text(book, "title")?,
                text(book, "author_name")?,
                text(book, "synopsis")?,
                text(design, "art_direction")?,
                text(design, "text_mode")?,
                text(design, "cover_language")?
            )
        } else {
            format!(
                "设计 {} 张小说封面参考，目标 {}×{} 像素。\n书名（保持原文）：{}\n笔名（保持原文）：{}\n简介：{}\n视觉方向：{}\n文字方式：{}\n封面文字语言：{}\n使用当前宿主可用的图像能力，将实际图片与准确的 result.json 保存到指定 inbox。不要修改作者正文或选用正式封面。缺少能力或尺寸不符时如实说明，不能拉伸图片。",
                design["candidate_count"],
                design["width"],
                design["height"],
                text(book, "title")?,
                text(book, "author_name")?,
                text(book, "synopsis")?,
                text(design, "art_direction")?,
                text(design, "text_mode")?,
                text(design, "cover_language")?
            )
        };
        let request = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"request_id":request_id,"book":book,"design":design,"prompt":prompt,"output_relative_dir":format!("{ROOT}/inbox/{request_id}"),"created_at":now()});
        schema(&request, &definition("request"))?;
        Ok(json!({"request":request,"prompt":prompt,"effect":"preview_only"}))
    }
    pub(super) fn create_cover_request(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let request = &input["request"];
        let request_id = text(request, "request_id")?;
        ensure(
            !text(&request["book"], "title")?.trim().is_empty()
                && !text(&request["design"], "art_direction")?.trim().is_empty()
                && !text(request, "prompt")?.trim().is_empty(),
            "invalid_input",
            "书名、视觉方向和提示词不能为空白。",
        )?;
        ensure(
            request["workspace_id"] == self.scope()
                && request["output_relative_dir"] == format!("{ROOT}/inbox/{request_id}")
                && integer(&request["design"], "width")? * integer(&request["design"], "height")?
                    <= 64_000_000,
            "forbidden",
            "请求不属于当前作品或输出目录不符。",
        )?;
        self.store.directory(&format!("{ROOT}/requests"))?;
        let path = request_path(request_id)?;
        ensure(
            !self.store.exists(&path)?,
            "revision_conflict",
            "封面请求已经存在，请恢复原操作。",
        )?;
        let raw = bytes(request)?;
        let sha = digest(&raw);
        changes.insert(path.clone(), raw);
        self.store
            .directory(text(request, "output_relative_dir")?)?;
        Ok(
            json!({"request":request,"request_sha256":sha,"request_path":path,"state":"waiting_for_result"}),
        )
    }
    pub(super) fn list_cover_requests(&self, input: &Value) -> Result<Value> {
        if !self.has_covers()?
            || !self
                .store
                .entries(ROOT)?
                .iter()
                .any(|name| name == "requests")
        {
            return Ok(json!({"requests":[],"next_cursor":null}));
        }
        let names = self.store.entries(&format!("{ROOT}/requests"))?;
        ensure(
            names.len() <= 1000,
            "hetu.budget_exceeded",
            "封面请求超过单次枚举上限。",
        )?;
        let mut requests = Vec::new();
        let after = input["cursor"].as_str().unwrap_or("");
        for name in names {
            let request_id = name.strip_suffix(".json").ok_or_else(|| {
                Error::new("hetu.integrity_failure", "封面请求目录包含未知文件。")
            })?;
            if request_id <= after {
                continue;
            }
            let (request, sha) = self.cover_request(request_id)?;
            requests.push(json!({"request":request,"request_sha256":sha}));
        }
        let limit = input["limit"].as_u64().unwrap_or(20) as usize;
        let cursor = if requests.len() > limit {
            requests[limit - 1]["request"]["request_id"].clone()
        } else {
            Value::Null
        };
        requests.truncate(limit);
        Ok(json!({"requests":requests,"next_cursor":cursor}))
    }
    pub(super) fn list_cover_candidates(&self, input: &Value) -> Result<Value> {
        let request_id = text(input, "request_id")?;
        let (request, sha) = self.cover_request(request_id)?;
        let directory = text(&request, "output_relative_dir")?;
        let result_path = format!("{directory}/result.json");
        if !self.store.exists(&result_path)? {
            let discovered = self
                .store
                .entries(directory)?
                .iter()
                .any(|name| name.starts_with("candidate-"));
            return Ok(
                json!({"request":request,"request_sha256":sha,"state":if discovered {"files_discovered"} else {"waiting_for_result"},"candidates":[]}),
            );
        }
        let raw = self.store.read(&result_path)?;
        let result_sha = digest(&raw);
        let result: Value = serde_json::from_slice(&raw)?;
        schema(&result, &definition("result"))?;
        ensure(
            result["workspace_id"] == self.scope()
                && result["request_id"] == request_id
                && result["request_sha256"] == sha,
            "hetu.integrity_failure",
            "封面回执的作品、请求或摘要不一致。",
        )?;
        let items = result["candidates"].as_array().unwrap();
        let count = integer(&request["design"], "candidate_count")? as usize;
        ensure(
            items.len() <= count,
            "invalid_input",
            "候选数量超过作者请求。",
        )?;
        let mut names = BTreeSet::new();
        let mut candidates = Vec::new();
        for candidate in items {
            let name = text(candidate, "filename")?;
            ensure(
                names.insert(name),
                "invalid_input",
                "封面回执包含重复文件。",
            )?;
            let mut file = self.store.managed_media(&format!("{directory}/{name}"))?;
            let image = files::decode_image(&mut file)?;
            let (width, height) = dimensions(&image);
            ensure(
                candidate["sha256"] == image.scan["sha256"]
                    && candidate["size_bytes"] == image.scan["size_bytes"]
                    && candidate["media_type"] == image.scan["media_type"]
                    && candidate["width"] == width
                    && candidate["height"] == height
                    && name
                        .rsplit_once('.')
                        .is_some_and(|(_, ext)| Some(ext) == image.scan["extension"].as_str()),
                "hetu.integrity_failure",
                "封面图片的摘要、格式或实际尺寸与回执不一致。",
            )?;
            let reference = json!({"request_id":request_id,"request_sha256":sha,"result_sha256":result_sha,"filename":name,"sha256":image.scan["sha256"]});
            candidates.push(json!({"candidate":candidate,"reference":reference,"preview":files::image_preview(&image.decoded)?,"target_size_matches":request["design"]["width"] == width && request["design"]["height"] == height}));
        }
        let novel = self.get_novel()?;
        Ok(
            json!({"request":request,"request_sha256":sha,"result_sha256":result_sha,"state":if items.len() < count {"partial_result"} else {"candidates_ready"},"candidates":candidates,
            "book_changed":request["book"]["title"] != novel["novel"]["metadata"]["title"] || request["book"]["author_name"] != novel["novel"]["metadata"]["author_name"]}),
        )
    }
    fn cover_record(&self, revision: Option<u64>) -> Result<Option<Value>> {
        if !self.has_covers()? || !self.store.exists(&format!("{ROOT}/cover.json"))? {
            return Ok(None);
        }
        let raw = self.store.read(&format!("{ROOT}/cover.json"))?;
        let head: Value = serde_json::from_slice(&raw)?;
        schema(&head, &definition("record"))?;
        let latest = integer(&head, "revision")?;
        let target = revision.unwrap_or(latest);
        ensure(
            target > 0 && target <= latest && latest - target < 1000,
            "not_found",
            "封面修订不存在或超过历史核验上限。",
        )?;
        let mut sha = digest(&raw);
        for number in (target..=latest).rev() {
            let raw = self.store.read(&format!(".hetu/covers/{number}.json"))?;
            let record: Value = serde_json::from_slice(&raw)?;
            schema(&record, &definition("record"))?;
            ensure(
                digest(raw) == sha
                    && record["revision"] == number
                    && record["workspace_id"] == self.scope()
                    && ((number == 1 && record["previous_sha256"].is_null())
                        || (number > 1 && record["previous_sha256"].is_string())),
                "hetu.integrity_failure",
                "封面历史归属或摘要不一致。",
            )?;
            if number == target {
                return Ok(Some(record));
            }
            sha = text(&record, "previous_sha256")?.into();
        }
        unreachable!("checked cover revision")
    }
    pub(super) fn get_cover(&self, input: &Value) -> Result<Value> {
        let project_id = self
            .cover_creation_source()?
            .map(|source| source["project_id"].clone());
        let Some(record) = self.cover_record(input["revision"].as_u64())? else {
            return Ok(
                json!({"cover":null,"expected_cover":null,"preview":null,"preparation_project_id":project_id}),
            );
        };
        let asset = self.get_asset(&json!({"asset_id":record["asset_ref"]["asset_id"],"revision":record["asset_ref"]["revision"]}))?;
        ensure(
            asset["sha256"] == record["asset_ref"]["sha256"],
            "hetu.integrity_failure",
            "封面素材修订摘要不一致。",
        )?;
        let mut file = self
            .store
            .managed_media(text(&asset["asset"]["blob"], "path")?)?;
        let image = files::decode_image(&mut file)?;
        ensure(
            record["width"] == image.decoded.width() && record["height"] == image.decoded.height(),
            "hetu.integrity_failure",
            "封面原件尺寸与选用记录不一致。",
        )?;
        if record["source_ref"]["kind"] == "creation_preparation" {
            self.validate_preparation_source(&record["source_ref"])?;
            ensure(
                record["source_ref"]["candidate"]["sha256"] == image.scan["sha256"]
                    && record["source_ref"]["candidate"]["size_bytes"] == image.scan["size_bytes"],
                "hetu.integrity_failure",
                "筹备封面的图片与选用来源不一致。",
            )?;
        }
        Ok(
            json!({"cover":record,"expected_cover":expected(&record),"preview":cover_preview(&image.decoded,&record["presentation"])?,"asset":asset,"preparation_project_id":project_id}),
        )
    }
    fn cover_source(&self, source: &Value) -> Result<(File, Value, Value, Option<Value>)> {
        match text(source, "kind")? {
            "file" => {
                let path = Path::new(text(source, "file_path")?);
                let file = files::selected_file(path)?;
                let filename = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| Error::new("invalid_input", "封面文件名必须是有效的 UTF-8。"))?;
                Ok((
                    file,
                    source["expected_file"].clone(),
                    json!({"kind":"author_supplied","original_filename":filename}),
                    None,
                ))
            }
            "candidate" => {
                let reference = &source["reference"];
                let request_id = text(reference, "request_id")?;
                let list = self.list_cover_candidates(&json!({"request_id":request_id}))?;
                let selected = list["candidates"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["reference"] == *reference)
                    .ok_or_else(|| {
                        Error::new("revision_conflict", "候选或回执已变化，请重新检查。")
                    })?;
                let file = self.store.managed_media(&format!(
                    "{ROOT}/inbox/{request_id}/{}",
                    text(reference, "filename")?
                ))?;
                Ok((
                    file,
                    selected["candidate"].clone(),
                    json!({"kind":"external_agent","reference":reference,"request":list["request"],"candidate":selected["candidate"]}),
                    None,
                ))
            }
            "asset" => {
                let reference = &source["asset_ref"];
                let asset = self.get_asset(
                    &json!({"asset_id":reference["asset_id"],"revision":reference["revision"]}),
                )?;
                ensure(
                    asset["sha256"] == reference["sha256"],
                    "revision_conflict",
                    "素材引用已变化。",
                )?;
                Ok((
                    self.store
                        .managed_media(text(&asset["asset"]["blob"], "path")?)?,
                    asset["asset"]["blob"].clone(),
                    json!({"kind":"existing_asset","asset_ref":reference}),
                    Some(reference.clone()),
                ))
            }
            "preparation" => self.preparation_cover_source(&source["reference"]),
            _ => unreachable!("validated source kind"),
        }
    }
    pub(super) fn select_cover(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let current = self.cover_record(None)?;
        ensure(
            input["expected_cover"] == current.as_ref().map_or(Value::Null, expected),
            "revision_conflict",
            "封面已被其他窗口选用，请刷新后比较。",
        )?;
        let rect = &input["presentation"]["crop_rect"];
        ensure(
            rect["x"].as_f64().unwrap() + rect["width"].as_f64().unwrap() <= 1.0000001
                && rect["y"].as_f64().unwrap() + rect["height"].as_f64().unwrap() <= 1.0000001,
            "invalid_input",
            "裁切范围不能超出原图。",
        )?;
        let (mut source, requested, provenance, existing_asset) =
            self.cover_source(&input["source"])?;
        let image = files::decode_image(&mut source)?;
        let (width, height) = dimensions(&image);
        ensure(
            requested["sha256"] == image.scan["sha256"]
                && requested["size_bytes"] == image.scan["size_bytes"],
            "revision_conflict",
            "选用图片已偏离预览。",
        )?;
        let asset_ref = if let Some(reference) = existing_asset {
            reference
        } else {
            let asset_id = id("asset");
            let extension = text(&image.scan, "extension")?;
            let path = format!("packages/visual-prompt/assets/{asset_id}/source.{extension}");
            self.store.import_media(&path, &mut source, &image.scan)?;
            let filename = if input["source"]["kind"] == "file" {
                &provenance["original_filename"]
            } else {
                &provenance["candidate"]["filename"]
            };
            let record = json!({"schema_version":"1.0.0","asset_id":asset_id,"revision":1,"previous_sha256":null,"kind":"visual","original_filename":filename,
                "blob":{"path":path,"sha256":image.scan["sha256"],"size_bytes":image.scan["size_bytes"],"media_type":image.scan["media_type"],"validation":"signature_only"},
                "title":self.get_novel()?["novel"]["metadata"]["title"],"source":{"source_type":if input["source"]["kind"] == "file" {"author_supplied"} else {"external_agent"},"creator_statement":"封面来源见选用记录；权利未经验证。"},"rights_status":"unknown","redistribution_allowed":false,"rights_statement":"","created_at":now(),"updated_at":now(),"actor_ref":self.actor()});
            let sha = self.stage_media_record("asset", &record, changes)?;
            json!({"asset_id":asset_id,"revision":1,"sha256":sha})
        };
        let revision = current
            .as_ref()
            .map_or(1, |v| v["revision"].as_u64().unwrap() + 1);
        let record = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"revision":revision,"previous_sha256":current.as_ref().map(|v| digest(bytes(v).expect("JSON record"))),
            "asset_ref":asset_ref,"source_ref":provenance,"presentation":input["presentation"],"width":width,"height":height,"actor_ref":self.actor(),"created_at":now()});
        schema(&record, &definition("record"))?;
        self.store.directory(ROOT)?;
        self.store.directory(".hetu/covers")?;
        let history = format!(".hetu/covers/{revision}.json");
        ensure(
            !self.store.exists(&history)?,
            "hetu.integrity_failure",
            "封面历史已存在，不能覆盖。",
        )?;
        let raw = bytes(&record)?;
        changes.insert(history, raw.clone());
        changes.insert(format!("{ROOT}/cover.json"), raw);
        Ok(
            json!({"cover":record,"expected_cover":expected(&record),"preview":cover_preview(&image.decoded,&record["presentation"])?}),
        )
    }
}
