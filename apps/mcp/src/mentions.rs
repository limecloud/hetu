//! 宿主提及只投影既有获权来源；URI不是授权，也不保存第二份作品内容。
use super::*;
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};

pub const TOOL: &str = "hetu_search_mentions";
pub const URI_PREFIX: &str = "hetu://mention/1?";
const MAX_ITEMS: usize = 20;
const PAGE_BYTES: usize = 16 * 1024;
const ENTITY_FIELDS: [(&str, &str); 6] = [
    ("characters", "character_id"),
    ("factions", "faction_id"),
    ("locations", "location_id"),
    ("timeline", "event_id"),
    ("world", "entry_id"),
    ("rules", "rule_id"),
];
type Read<'a> = dyn FnMut(&str, Value) -> Result<Value, ErrorData> + 'a;
mod sources;
mod structured;
use sources::{Reference, Source, uri};
pub use sources::{read, work_for_uri};

pub fn capabilities(mut value: ServerCapabilities) -> ServerCapabilities {
    value
        .extensions
        .get_or_insert_with(Default::default)
        .insert(
            "openai/mentions".into(),
            json!({"searchTool":TOOL}).as_object().unwrap().clone(),
        );
    value
}

pub fn tool() -> Tool {
    let mut tool = Tool::default();
    tool.name = TOOL.into();
    tool.title = Some("查找作品来源 / Find work sources".into());
    tool.description = Some("按名称查找当前客户端已获权的固定来源。只读，不创建任务；结果覆盖与资源读取仍逐次核验原作品或任务权限。".into());
    tool.input_schema = Arc::new(
        json!({"type":"object","additionalProperties":false,"required":["query"],
        "properties":{"query":{"type":"string","maxLength":200}}})
        .as_object()
        .unwrap()
        .clone(),
    );
    tool.annotations = Some(ToolAnnotations::from_raw(
        None,
        Some(true),
        Some(false),
        Some(true),
        Some(false),
    ));
    tool.meta = Some(
        json!({"ui":{"visibility":["app"]}})
            .as_object()
            .unwrap()
            .clone()
            .into(),
    );
    tool
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    query: String,
}

pub fn data(result: Value) -> Result<Value, ErrorData> {
    if result["status"] != "succeeded" {
        return Err(ErrorData::invalid_request(
            "来源不可用，请核对原作品或任务 / Source is unavailable; check the original work or task",
            Some(json!({"code":result["error"]["code"]})),
        ));
    }
    Ok(result["data"].clone())
}

struct SearchState {
    query: String,
    items: Vec<Value>,
    seen: BTreeSet<String>,
    unavailable: BTreeSet<&'static str>,
    calls: usize,
    scanned: usize,
    deadline: Instant,
    complete: bool,
}
impl SearchState {
    fn new(arguments: JsonObject) -> Result<Self, ErrorData> {
        let input: Search = serde_json::from_value(Value::Object(arguments))
            .map_err(|_| ErrorData::invalid_params("请输入来源名称 / Enter a source name", None))?;
        if input.query.chars().count() > 200 || input.query.chars().any(char::is_control) {
            return Err(ErrorData::invalid_params(
                "来源名称过长或含控制字符 / Invalid source name",
                None,
            ));
        }
        Ok(Self {
            query: input.query.trim().to_lowercase(),
            items: vec![],
            seen: BTreeSet::new(),
            unavailable: BTreeSet::new(),
            calls: 0,
            scanned: 0,
            deadline: Instant::now() + Duration::from_secs(5),
            complete: true,
        })
    }
    fn room(&mut self) -> bool {
        if self.items.len() >= MAX_ITEMS
            || self.calls >= 48
            || self.scanned >= 4000
            || Instant::now() >= self.deadline
        {
            self.complete = false;
            false
        } else {
            true
        }
    }
    fn read(
        &mut self,
        read: &mut Read<'_>,
        action: &str,
        input: Value,
    ) -> Result<Value, ErrorData> {
        if !self.room() {
            return Err(ErrorData::invalid_request(
                "来源搜索达到本次预算，请缩小名称范围 / Refine the source name",
                None,
            ));
        }
        self.calls += 1;
        read(action, input)
    }
    fn matches(&mut self, label: &str, work_title: &str) -> bool {
        self.scanned += 1;
        label.to_lowercase().contains(&self.query)
            || work_title.to_lowercase().contains(&self.query)
    }
    fn push(&mut self, source: Source, name: &str, work_title: &str, kind: &str) {
        if !self.room() {
            return;
        }
        let uri = uri(&Reference { source, offset: 0 });
        if self.seen.insert(uri.clone()) {
            let label = name.chars().take(120).collect::<String>();
            let work_title = work_title.chars().take(120).collect::<String>();
            let item = json!({"type":"resource_link","uri":uri,"name":label,
                "title":if work_title.is_empty(){label.clone()}else{format!("{work_title} / {label}")},
                "description":kind,"mimeType":"application/json"});
            let bytes = self
                .items
                .iter()
                .chain(std::iter::once(&item))
                .map(|item| serde_json::to_vec(item).map_or(usize::MAX, |v| v.len()))
                .fold(0usize, usize::saturating_add);
            if bytes > MAX_RESULT_BYTES - 2048 {
                self.complete = false;
                return;
            }
            self.items.push(item);
        }
    }
    fn finish(self, supported_kinds: &[&str]) -> CallToolResponse {
        let complete = self.complete && self.unavailable.is_empty();
        if self.items.is_empty() && !complete {
            return CallToolResult::structured_error(json!({"items":[],"coverage":{"scope":"authorized_source_titles",
                "supported_kinds":supported_kinds,"complete":false,"scanned_entries":self.scanned,"unavailable_categories":self.unavailable},
                "error":{"code":"source_search_incomplete","message":"本次来源检索未完成，请缩小名称范围或核对作品连接。"}})).into();
        }
        CallToolResult::structured(
            json!({"items":self.items,"coverage":{"scope":"authorized_source_titles",
            "supported_kinds":supported_kinds,
            "complete":complete,"scanned_entries":self.scanned,
            "unavailable_categories":self.unavailable}}),
        )
        .into()
    }
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").to_owned()
}
fn pages(
    state: &mut SearchState,
    read: &mut Read<'_>,
    action: &str,
    mut input: Value,
    field: &str,
    mut visit: impl FnMut(&mut SearchState, &mut Read<'_>, &Value, &Value) -> Result<(), ErrorData>,
) -> Result<(), ErrorData> {
    let mut cursors = BTreeSet::new();
    loop {
        if !state.room() {
            return Ok(());
        }
        let page = state.read(read, action, input.clone())?;
        let rows = page[field].as_array().ok_or_else(|| {
            ErrorData::internal_error("来源目录不符合合同 / Invalid source directory", None)
        })?;
        for row in rows {
            if !state.room() {
                return Ok(());
            }
            visit(state, read, row, &page)?;
        }
        let Some(cursor) = page["next_cursor"].as_str() else {
            return Ok(());
        };
        if !cursors.insert(cursor.to_owned()) {
            return Err(ErrorData::internal_error(
                "来源分页没有推进 / Source cursor did not advance",
                None,
            ));
        }
        input["cursor"] = json!(cursor);
    }
}

fn task_sources(
    state: &mut SearchState,
    read: &mut Read<'_>,
    task: &Value,
    title: &str,
) -> Result<(), ErrorData> {
    pages(
        state,
        read,
        "hetu.task_context.list",
        json!({"task_ref":task,"limit":100}),
        "entries",
        |state, _, row, _| {
            let name = row["title"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("固定资料");
            if state.matches(name, title) {
                state.push(
                    Source::TaskContext {
                        task_ref: task.clone(),
                        context_ref: row["context_ref"].clone(),
                    },
                    name,
                    title,
                    "任务固定资料",
                );
            }
            Ok(())
        },
    )
}
pub fn search_task(
    arguments: JsonObject,
    task: &Value,
    read: &mut Read<'_>,
) -> Result<CallToolResponse, ErrorData> {
    let mut state = SearchState::new(arguments)?;
    task_sources(&mut state, read, task, "")?;
    Ok(state.finish(&["task_context"]))
}

fn work_sources(state: &mut SearchState, read: &mut Read<'_>, work: &Value, title: &str) {
    let query = if title.to_lowercase().contains(&state.query) {
        String::new()
    } else {
        state.query.clone()
    };
    let documents = if work["kind"] != "video" {
        pages(
            state,
            read,
            "hetu.documents.list",
            json!({"work_ref":work,"query":query,"include_revision_ref":true,"limit":MAX_ITEMS}),
            "documents",
            |state, _, row, _| {
                let name = text(row, "title");
                if row["archived"] == true || !state.matches(&name, title) {
                    return Ok(());
                }
                let reference = &row["current_revision_ref"];
                if reference["revision_id"] != row["current_revision_id"]
                    || !reference["sha256"].is_string()
                {
                    return Err(ErrorData::invalid_request(
                        "文稿目录缺少固定修订 / Document directory has no fixed revision",
                        None,
                    ));
                }
                state.push(
                    Source::Document {
                        work_ref: work.clone(),
                        document_id: text(row, "document_id"),
                        revision_id: text(reference, "revision_id"),
                        sha256: text(reference, "sha256"),
                    },
                    &name,
                    title,
                    "固定文稿",
                );
                Ok(())
            },
        )
    } else {
        Ok(())
    };
    if documents.is_err() {
        state.unavailable.insert("documents");
    }
    if !state.room() {
        return;
    }
    match state.read(read, "hetu.blueprints.get", json!({"work_ref":work})) {
        Ok(value) => {
            for (section, id_key) in ENTITY_FIELDS {
                for row in value["blueprint"][section].as_array().into_iter().flatten() {
                    if !state.room() {
                        return;
                    }
                    let name = row["name"]
                        .as_str()
                        .or(row["title"].as_str())
                        .unwrap_or("未命名设定");
                    if row["archived"] != true && state.matches(name, title) {
                        state.push(
                            Source::Entity {
                                work_ref: work.clone(),
                                revision: value["revision"].as_u64().unwrap_or(0),
                                sha256: text(&value, "sha256"),
                                section: section.into(),
                                entity_id: text(row, id_key),
                            },
                            name,
                            title,
                            "固定人物与设定",
                        );
                    }
                }
            }
        }
        Err(error)
            if error
                .data
                .as_ref()
                .is_some_and(|v| v["code"] == "hetu.canon_initialization_required") => {}
        Err(_) => {
            state.unavailable.insert("canon");
        }
    }
    if !state.room() {
        return;
    }
    let resources = pages(
        state,
        read,
        "hetu.resources.list",
        json!({"work_ref":work,"limit":100}),
        "resources",
        |state, _, row, _| {
            let name = text(row, "title");
            if state.matches(&name, title) {
                state.push(
                    Source::Resource {
                        work_ref: work.clone(),
                        resource_id: text(row, "resource_id"),
                        revision: row["revision"].as_u64().unwrap_or(0),
                        sha256: text(row, "sha256"),
                    },
                    &name,
                    title,
                    "固定资料",
                );
            }
            Ok(())
        },
    );
    if resources.is_err() {
        state.unavailable.insert("resources");
    }
    if work["kind"] == "novel" && state.room() {
        let outlines = pages(
            state,
            read,
            "hetu.outlines.get",
            json!({"limit":100,"detail":"summary"}),
            "items",
            |state, _, row, page| {
                let name = text(row, "title");
                if state.matches(&name, title) {
                    state.push(
                        Source::Outline {
                            work_ref: work.clone(),
                            outline_id: text(row, "id"),
                            revision: page["revision"].as_u64().unwrap_or(0),
                            sha256: text(page, "sha256"),
                        },
                        &name,
                        title,
                        "固定大纲",
                    );
                }
                Ok(())
            },
        );
        if outlines.is_err() {
            state.unavailable.insert("outlines");
        }
    }
    if state.room() {
        structured::work_sources(state, read, work, title);
    }
}

pub fn search_stable(
    arguments: JsonObject,
    hub: &hetu_core::collaboration::CollaborationHub,
    current_work: Option<&Value>,
    cancelled: &dyn Fn() -> bool,
) -> Result<CallToolResponse, ErrorData> {
    let mut state = SearchState::new(arguments)?;
    let mut library = |action: &str, input: Value| {
        data(hub.request_cancellable(
            json!({"action":action,"contract_revision":"1","input":input}),
            cancelled,
        ))
    };
    pages(
        &mut state,
        &mut library,
        "hetu.collaboration.library",
        json!({"limit":100}),
        "works",
        |state, _, row, _| {
            if cancelled() {
                return Err(ErrorData::internal_error(
                    "读取已取消 / Read cancelled",
                    None,
                ));
            }
            if row["authorized"] != true
                || current_work.is_some_and(|work| *work != row["work_ref"])
            {
                return Ok(());
            }
            let work = &row["work_ref"];
            // 目录投影不授予读取权；每个动作重新解析当前客户端已有的精确授权。
            let mut read =
                |action: &str, input: Value| read_stable(hub, Some(work), action, input, cancelled);
            let before = state.items.len();
            work_sources(state, &mut read, work, &text(row, "title"));
            if cancelled() {
                return Err(ErrorData::internal_error(
                    "读取已取消 / Read cancelled",
                    None,
                ));
            }
            if read("hetu.works.get", json!({"work_ref":work})).is_err() {
                state.items.truncate(before);
                state.unavailable.insert("work_access");
            }
            Ok(())
        },
    )?;
    Ok(state.finish(&[
        "document",
        "scene",
        "entity",
        "outline",
        "resource",
        "video_episode",
        "video_media",
        "plugin_object",
    ]))
}

pub fn read_stable(
    hub: &hetu_core::collaboration::CollaborationHub,
    work: Option<&Value>,
    action: &str,
    mut input: Value,
    cancelled: &dyn Fn() -> bool,
) -> Result<Value, ErrorData> {
    if cancelled() {
        return Err(ErrorData::internal_error(
            "读取已取消 / Read cancelled",
            None,
        ));
    }
    if let Some(work) = work {
        let reference = hub
            .management_ref_for_work(work)
            .map_err(|_| {
                ErrorData::invalid_request("作品接入不可用 / Work connection unavailable", None)
            })?
            .ok_or_else(|| {
                ErrorData::invalid_request(
                    "当前客户端没有这部作品的有效授权 / Work is not authorized for this client",
                    None,
                )
            })?;
        input["management_ref"] = reference;
    }
    data(hub.request_cancellable(
        json!({"action":action,"contract_revision":"1","input":input}),
        cancelled,
    ))
}
