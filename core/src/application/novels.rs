use super::*;
use crate::domain::novel;
use std::collections::BTreeSet;

const NOVEL_PATH: &str = "packages/novel/novel.json";
const HEAD_PATH: &str = ".hetu/novel-head.json";

pub(super) fn stage_initial_novel(
    store: &Store,
    workspace_id: &Value,
    metadata: Value,
    chapters: Vec<Value>,
    changes: &mut Changes,
) -> Result<Value> {
    let novel = json!({"schema_version":"1.0.0","workspace_id":workspace_id,"novel_id":id("novel"),"revision":1,"previous_sha256":null,"metadata":metadata,"volumes":[],"chapters":chapters,"created_at":now(),"updated_at":now()});
    stage_novel(store, &novel, changes)?;
    Ok(novel)
}

fn stage_novel(store: &Store, novel: &Value, changes: &mut Changes) -> Result<()> {
    schema(novel, &novel::definition("novel"))?;
    novel::validate_metadata(&novel["metadata"])?;
    store.directory(".hetu/novels")?;
    let snapshot = format!(".hetu/novels/{}.json", integer(novel, "revision")?);
    ensure(
        !store.exists(&snapshot)?,
        "hetu.integrity_failure",
        "小说历史修订已存在，不能覆盖。",
    )?;
    let content = bytes(novel)?;
    ensure(
        content.len() <= 16 * 1024 * 1024,
        "hetu.budget_exceeded",
        "小说目录超过单次保存上限。",
    )?;
    changes.insert(snapshot, content.clone());
    changes.insert(NOVEL_PATH.into(), content.clone());
    changes.insert(
        HEAD_PATH.into(),
        bytes(&json!({"revision":novel["revision"],"sha256":digest(content)}))?,
    );
    Ok(())
}

impl Kernel {
    pub(super) fn novel(&self) -> Result<Option<Value>> {
        let exists = self.store.exists(NOVEL_PATH)?;
        ensure(
            exists == self.store.exists(HEAD_PATH)?
                && (exists || self.config["novel_path"].is_null()),
            "hetu.integrity_failure",
            "小说资料或目录摘要缺失，请保留文件并检查。",
        )?;
        if !exists {
            return Ok(None);
        }
        let content = self.store.read(NOVEL_PATH)?;
        let head = self.store.json(HEAD_PATH)?;
        let novel: Value = serde_json::from_slice(&content)?;
        schema(&novel, &novel::definition("novel"))?;
        novel::validate_metadata(&novel["metadata"])?;
        ensure(
            head["sha256"] == digest(&content)
                && head["revision"] == novel["revision"]
                && novel["workspace_id"] == self.scope(),
            "hetu.integrity_failure",
            "小说资料的归属或摘要不一致，不能自动覆盖。",
        )?;
        let snapshot = format!(".hetu/novels/{}.json", integer(&novel, "revision")?);
        ensure(
            self.store.read(&snapshot)? == content,
            "hetu.integrity_failure",
            "小说资料与不可变历史修订不一致。",
        )?;
        self.validate_novel_structure(&novel, None)?;
        Ok(Some(novel))
    }

    pub(super) fn get_novel(&self) -> Result<Value> {
        if let Some(novel) = self.novel()? {
            Ok(
                json!({"initialized":true,"revision":novel["revision"],"sha256":digest(bytes(&novel)?),"novel":novel}),
            )
        } else {
            Ok(json!({"initialized":false,"novel":null,"revision":null,"sha256":null}))
        }
    }

    fn expected_novel(&self, expected: &Value) -> Result<Value> {
        let novel = self.novel()?.ok_or_else(|| {
            Error::new(
                "hetu.novel_initialization_required",
                "请先由作者确认初始化小说目录。",
            )
        })?;
        ensure(
            expected["revision"] == novel["revision"]
                && expected["sha256"] == digest(bytes(&novel)?),
            "revision_conflict",
            "小说资料或卷章目录已有新修订，请刷新后比较。",
        )?;
        Ok(novel)
    }

    // 卷与章节的显示顺序由数组表达；正文身份和来源范围不随重排改变。
    fn validate_novel_structure(&self, novel: &Value, staged_doc: Option<&Value>) -> Result<()> {
        let mut volumes = BTreeSet::new();
        for volume in novel["volumes"].as_array().unwrap() {
            ensure(
                volumes.insert(text(volume, "volume_id")?)
                    && !text(volume, "title")?.trim().is_empty(),
                "invalid_input",
                "分卷标识不能重复，卷名不能为空。",
            )?;
        }
        let mut chapters = BTreeSet::new();
        let mut documents = BTreeSet::new();
        let mut last_group = 0;
        let volume_order: BTreeMap<_, _> = novel["volumes"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(index, v)| (v["volume_id"].as_str().unwrap(), index + 1))
            .collect();
        let mut stored_documents = BTreeMap::new();
        for name in self.store.entries("packages/novel/documents")? {
            checked_id(&name, "doc")?;
            let document = self
                .store
                .json(&format!("packages/novel/documents/{name}/document.json"))?;
            ensure(
                document["document_id"] == name,
                "hetu.integrity_failure",
                "正文归属与目录名称不一致。",
            )?;
            stored_documents.insert(name, document);
        }
        for chapter in novel["chapters"].as_array().unwrap() {
            let document_id = text(chapter, "document_id")?;
            ensure(
                chapters.insert(text(chapter, "chapter_id")?) && documents.insert(document_id),
                "invalid_input",
                "章节身份与正文引用不能重复。",
            )?;
            let volume = &chapter["volume_id"];
            ensure(
                volume.is_null() || volumes.contains(text(chapter, "volume_id")?),
                "invalid_input",
                "章节引用的分卷不存在。",
            )?;
            // 未分卷章节在前，其余按分卷数组顺序连续排列。
            let group = volume.as_str().map(|v| volume_order[v]).unwrap_or(0);
            ensure(
                group >= last_group,
                "invalid_input",
                "章节必须按分卷顺序连续排列。",
            )?;
            last_group = group;
            let document = if staged_doc.is_some_and(|d| d["document_id"] == document_id) {
                staged_doc.unwrap().clone()
            } else {
                stored_documents
                    .get(document_id)
                    .cloned()
                    .ok_or_else(|| Error::new("not_found", "目录引用的小说正文不存在。"))?
            };
            ensure(
                document["kind"] == "novel_chapter" && document["draft_source_id"].is_null(),
                "invalid_input",
                "小说目录只能引用本作品的小说章节正文。",
            )?;
        }
        for (name, document) in stored_documents {
            ensure(
                document["kind"] != "novel_chapter" || documents.contains(name.as_str()),
                "invalid_input",
                "目录必须保留全部小说章节，不能通过重排隐藏正文。",
            )?;
        }
        Ok(())
    }

    pub(super) fn initialize_novel(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        ensure(
            self.novel()?.is_none(),
            "revision_conflict",
            "小说目录已初始化，请刷新。",
        )?;
        let mut documents = Vec::new();
        for name in self.store.entries("packages/novel/documents")? {
            let document = self.document(&name)?;
            if document["kind"] == "novel_chapter" {
                documents.push(document);
            }
        }
        documents.sort_by(|a, b| {
            a["created_at"]
                .as_str()
                .cmp(&b["created_at"].as_str())
                .then_with(|| a["document_id"].as_str().cmp(&b["document_id"].as_str()))
        });
        let chapters = documents.iter().map(|d| json!({"chapter_id":id("chapter"),"document_id":d["document_id"],"volume_id":null})).collect();
        let novel = stage_initial_novel(
            &self.store,
            &self.config["workspace_id"],
            input["metadata"].clone(),
            chapters,
            changes,
        )?;
        Ok(json!({"initialized":true,"revision":1,"sha256":digest(bytes(&novel)?),"novel":novel}))
    }

    fn save_novel(&self, mut novel: Value, changes: &mut Changes) -> Result<Value> {
        novel["previous_sha256"] = json!(digest(self.store.read(NOVEL_PATH)?));
        novel["revision"] = json!(
            integer(&novel, "revision")?
                .checked_add(1)
                .ok_or_else(|| Error::new("hetu.budget_exceeded", "小说修订超过支持上限。"))?
        );
        novel["updated_at"] = json!(now());
        stage_novel(&self.store, &novel, changes)?;
        Ok(
            json!({"initialized":true,"revision":novel["revision"],"sha256":digest(bytes(&novel)?),"novel":novel}),
        )
    }

    pub(super) fn update_novel(
        &self,
        input: &Value,
        changes: &mut Changes,
        structure: bool,
    ) -> Result<Value> {
        let mut novel = self.expected_novel(&input["expected"])?;
        if structure {
            // 改顺序和分卷不能换掉章节身份与正文绑定。
            let before: BTreeMap<_, _> = novel["chapters"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    (
                        c["chapter_id"].clone().to_string(),
                        c["document_id"].clone(),
                    )
                })
                .collect();
            let after: BTreeMap<_, _> = input["chapters"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    (
                        c["chapter_id"].clone().to_string(),
                        c["document_id"].clone(),
                    )
                })
                .collect();
            ensure(
                before == after,
                "invalid_input",
                "重排不能增删章节或更换正文绑定。",
            )?;
            novel["volumes"] = input["volumes"].clone();
            novel["chapters"] = input["chapters"].clone();
            self.validate_novel_structure(&novel, None)?;
        } else {
            novel::validate_metadata(&input["metadata"])?;
            novel["metadata"] = input["metadata"].clone();
        }
        self.save_novel(novel, changes)
    }

    pub(super) fn append_novel_chapter(
        &self,
        document: &Value,
        selected_volume: Option<&Value>,
        changes: &mut Changes,
    ) -> Result<()> {
        let mut novel = self.novel()?.ok_or_else(|| {
            Error::new(
                "hetu.novel_initialization_required",
                "请先确认初始化小说目录，再创建章节。",
            )
        })?;
        // 新章追加到最后一个分组；作者可在目录管理中移动到其他卷。
        let volume = selected_volume.cloned().unwrap_or_else(|| novel["chapters"]
            .as_array()
            .unwrap()
            .last()
            .map(|c| c["volume_id"].clone())
            .unwrap_or(Value::Null));
        novel["chapters"].as_array_mut().unwrap().push(json!({"chapter_id":id("chapter"),"document_id":document["document_id"],"volume_id":volume}));
        if selected_volume.is_some() {
            let volumes = novel["volumes"].as_array().unwrap().clone();
            ensure(volume.is_null() || volumes.iter().any(|v| v["volume_id"] == volume), "invalid_input", "目标分卷不存在。")?;
            novel["chapters"].as_array_mut().unwrap().sort_by_key(|c| {
                if c["volume_id"].is_null() { 0 } else { volumes.iter().position(|v| v["volume_id"] == c["volume_id"]).unwrap_or(volumes.len()) + 1 }
            });
        }
        self.validate_novel_structure(&novel, Some(document))?;
        self.save_novel(novel, changes)?;
        Ok(())
    }
}
