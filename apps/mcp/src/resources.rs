use rmcp::{ErrorData, model::*};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn invalid() -> ErrorData {
    ErrorData::invalid_params(
        "资源 URI、查询参数或游标无效 / Invalid resource URI, query or cursor",
        None,
    )
}

pub(super) fn no_cursor(request: Option<PaginatedRequestParams>) -> Result<(), ErrorData> {
    if request.is_some_and(|p| p.cursor.is_some()) {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn directory(scope: &str) -> Vec<Resource> {
    [
        ("workspace", "工作区 / Workspace"),
        (
            "capabilities",
            "当前权限与能力 / Permissions and capabilities",
        ),
        ("blueprint", "当前设定集 / Current story bible"),
        ("documents", "正文目录 / Documents"),
        ("reviews", "待审草稿目录 / Draft review queue"),
        ("plots", "剧情修订目录 / Plot revisions"),
        ("reports", "诊断报告目录 / Validation reports"),
        ("skeletons", "短剧骨架目录 / Drama skeletons"),
        ("git/status", "本地版本状态 / Local version status"),
        ("git/log", "提交历史 / Commit history"),
        ("git/snapshots", "待审快照目录 / Snapshot previews"),
    ]
    .into_iter()
    .map(|(path, name)| {
        Resource::new(format!("hetu://workspace/{scope}/{path}"), path)
            .with_title(name)
            .with_mime_type("application/json")
    })
    .collect()
}

pub(super) fn templates(scope: &str) -> Vec<ResourceTemplate> {
    [
        (
            "git/log{?limit,cursor}",
            "分页提交历史 / Paged commit history",
        ),
        (
            "git/diff{?path}",
            "工作树文件差异 / Working file differences",
        ),
        (
            "git/snapshots{?limit,cursor}",
            "分页待审快照 / Paged snapshot previews",
        ),
        ("git/snapshots/{snapshot_id}", "固定快照 / Fixed snapshot"),
        (
            "git/snapshots/{snapshot_id}/diff{?path}",
            "固定快照差异 / Fixed snapshot differences",
        ),
        (
            "blueprint/revisions/{revision}",
            "固定设定集 / Fixed story bible",
        ),
        (
            "documents{?kind,limit,cursor}",
            "分页正文目录 / Paged documents",
        ),
        ("documents/{document_id}", "当前正文 / Current document"),
        (
            "documents/{document_id}/revisions/{revision_id}",
            "固定正文修订 / Fixed source revision",
        ),
        (
            "documents/{document_id}/script-mapping",
            "剧本初稿来源 / Initial script mapping",
        ),
        (
            "drafts/{draft_id}",
            "固定草稿与当前状态 / Fixed draft and current state",
        ),
        (
            "reviews{?state,limit,cursor}",
            "分页审核队列 / Paged review queue",
        ),
        (
            "reviews/{draft_id}{?report_limit,report_cursor}",
            "草稿公开审核意见 / Public draft review feedback",
        ),
        (
            "reviews/by-decision/{review_id}{?report_limit,report_cursor}",
            "由决定查审核 / Review by decision",
        ),
        (
            "plots{?document_id,limit,cursor}",
            "分页剧情修订 / Paged plot revisions",
        ),
        (
            "plots/{plot_revision_id}",
            "固定剧情修订 / Fixed plot revision",
        ),
        (
            "reports{?plot_revision_id,limit,cursor}",
            "分页诊断报告 / Paged reports",
        ),
        (
            "reports/{report_id}",
            "固定报告与当前处置 / Fixed report and current dispositions",
        ),
        (
            "skeletons{?plot_revision_id,limit,cursor}",
            "分页短剧骨架 / Paged drama skeletons",
        ),
        (
            "skeletons/{skeleton_id}",
            "当前短剧骨架 / Current drama skeleton",
        ),
        (
            "skeletons/{skeleton_id}/revisions/{revision}",
            "固定短剧骨架 / Fixed drama skeleton",
        ),
        (
            "skeletons/{skeleton_id}/comparisons{?limit,cursor}",
            "分页原著结构差异 / Paged source comparisons",
        ),
        (
            "comparisons/{comparison_id}",
            "固定原著结构差异 / Fixed source comparison",
        ),
        (
            "operations/{operation_id}",
            "原操作回执 / Original operation receipt",
        ),
        (
            "operations/by-key{?action,key}",
            "原键查询操作 / Recover by original key",
        ),
    ]
    .into_iter()
    .map(|(path, name)| {
        ResourceTemplate::new(format!("hetu://workspace/{scope}/{path}"), name)
            .with_mime_type("application/json")
    })
    .collect()
}

pub(super) struct Page {
    limit: usize,
    cursor: Option<String>,
    context: Value,
}
type Route = (&'static str, Value, Option<Page>);

pub(super) fn route(scope: &str, uri: &str) -> Result<Route, ErrorData> {
    if uri.len() > 8192 || uri.contains(['#', '\\']) {
        return Err(invalid());
    }
    let prefix = format!("hetu://workspace/{scope}/");
    let rest = uri.strip_prefix(&prefix).ok_or_else(invalid)?;
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    validate_query_encoding(query)?;
    if path.contains('%')
        || path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err(invalid());
    }
    let mut input = json!({});
    let segments: Vec<_> = path.split('/').collect();
    let (action, allowed, paged): (&str, &[&str], bool) = match segments.as_slice() {
        ["git", "status"] => ("hetu.git.status", &[], false),
        ["git", "log"] => ("hetu.git.log", &["limit", "cursor"], false),
        ["git", "diff"] => ("hetu.git.diff", &["path"], false),
        ["git", "snapshots"] => ("hetu.git.list_snapshots", &["limit", "cursor"], false),
        ["git", "snapshots", snapshot] => {
            input["snapshot_id"] = json!(snapshot);
            ("hetu.git.get_snapshot", &[], false)
        }
        ["git", "snapshots", snapshot, "diff"] => {
            input["snapshot_id"] = json!(snapshot);
            ("hetu.git.snapshot_diff", &["path"], false)
        }
        ["workspace"] => ("hetu.workspaces.get", &[], false),
        ["capabilities"] => ("hetu.capabilities.get", &[], false),
        ["blueprint"] => ("hetu.blueprints.get", &[], false),
        ["blueprint", "revisions", revision] => {
            input["revision"] = json!(number(revision)?);
            ("hetu.blueprints.get", &[], false)
        }
        ["documents"] => ("hetu.documents.list", &["kind", "limit", "cursor"], true),
        ["documents", document] => {
            input["document_id"] = json!(document);
            ("hetu.documents.get", &[], false)
        }
        ["documents", document, "revisions", revision] => {
            input = json!({"document_id":document,"revision_id":revision});
            ("hetu.documents.get", &[], false)
        }
        ["documents", document, "script-mapping"] => {
            input["document_id"] = json!(document);
            ("hetu.drama.get_script_mapping", &[], false)
        }
        ["drafts", draft] => {
            input["draft_id"] = json!(draft);
            ("hetu.drafts.get", &[], false)
        }
        ["reviews"] => ("hetu.reviews.list", &["state", "limit", "cursor"], false),
        ["reviews", draft] => {
            input["draft_id"] = json!(draft);
            (
                "hetu.reviews.get",
                &["report_limit", "report_cursor"],
                false,
            )
        }
        ["reviews", "by-decision", review] => {
            input["review_id"] = json!(review);
            (
                "hetu.reviews.get",
                &["report_limit", "report_cursor"],
                false,
            )
        }
        ["plots"] => ("hetu.plot.list", &["document_id", "limit", "cursor"], false),
        ["plots", plot] => {
            input["plot_revision_id"] = json!(plot);
            ("hetu.plot.get", &[], false)
        }
        ["reports"] => (
            "hetu.reports.list",
            &["plot_revision_id", "limit", "cursor"],
            false,
        ),
        ["reports", report] => {
            input["report_id"] = json!(report);
            ("hetu.reports.get", &[], false)
        }
        ["skeletons"] => (
            "hetu.drama.list_skeletons",
            &["plot_revision_id", "limit", "cursor"],
            false,
        ),
        ["skeletons", skeleton] => {
            input["skeleton_id"] = json!(skeleton);
            ("hetu.drama.get_skeleton", &[], false)
        }
        ["skeletons", skeleton, "revisions", revision] => {
            input = json!({"skeleton_id":skeleton,"revision":number(revision)?});
            ("hetu.drama.get_skeleton", &[], false)
        }
        ["skeletons", skeleton, "comparisons"] => {
            input["skeleton_id"] = json!(skeleton);
            ("hetu.drama.list_comparisons", &["limit", "cursor"], false)
        }
        ["comparisons", comparison] => {
            input["comparison_id"] = json!(comparison);
            ("hetu.drama.get_comparison", &[], false)
        }
        ["operations", "by-key"] => ("hetu.operations.get", &["action", "key"], false),
        ["operations", operation] => {
            input["operation_id"] = json!(operation);
            ("hetu.operations.get", &[], false)
        }
        _ => return Err(invalid()),
    };
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        if !allowed.contains(&key.as_ref())
            || input.get(key.as_ref()).is_some()
            || value.len() > 512
        {
            return Err(invalid());
        }
        input[key.as_ref()] = if key == "limit" || key == "report_limit" {
            json!(number(&value)?)
        } else {
            json!(value)
        };
    }
    let page = if paged {
        let limit = input
            .as_object_mut()
            .unwrap()
            .remove("limit")
            .map_or(Ok(50), |v| v.as_u64().ok_or_else(invalid))?;
        if !(1..=200).contains(&limit) {
            return Err(invalid());
        }
        Some(Page {
            limit: limit as usize,
            cursor: input
                .as_object_mut()
                .unwrap()
                .remove("cursor")
                .and_then(|v| v.as_str().map(str::to_owned)),
            context: json!({"scope":scope,"query":input}),
        })
    } else {
        None
    };
    Ok((action, input, page))
}

fn number(value: &str) -> Result<u64, ErrorData> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid());
    }
    let number = value.parse().map_err(|_| invalid())?;
    if !(1..=9_007_199_254_740_991).contains(&number) {
        return Err(invalid());
    }
    Ok(number)
}

fn validate_query_encoding(query: &str) -> Result<(), ErrorData> {
    let bytes = query.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3).ok_or_else(invalid)?;
            let hex = std::str::from_utf8(hex).map_err(|_| invalid())?;
            decoded.push(u8::from_str_radix(hex, 16).map_err(|_| invalid())?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    std::str::from_utf8(&decoded).map_err(|_| invalid())?;
    Ok(())
}

pub(super) fn paginate(result: &mut Value, page: Page) -> Result<(), ErrorData> {
    let Some(records) = result["data"]["documents"].as_array() else {
        return Ok(());
    };
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!({"context":page.context,"records":records}))
                .map_err(|_| invalid())?
        )
    );
    let start = if let Some(cursor) = page.cursor {
        let (hash, offset) = cursor.split_once(':').ok_or_else(invalid)?;
        let offset: usize = offset.parse().map_err(|_| invalid())?;
        if hash != fingerprint || offset > records.len() {
            return Err(invalid());
        }
        offset
    } else {
        0
    };
    let end = start.saturating_add(page.limit).min(records.len());
    let next = (end < records.len()).then(|| format!("{fingerprint}:{end}"));
    result["data"]["documents"] = json!(&records[start..end]);
    result["data"]["next_cursor"] = json!(next);
    Ok(())
}

/// 在领域结果外附加窄资源引用；不把 ID 拼接为本地文件路径。
pub(super) fn links(scope: &str, uri: &str, result: &mut Value) {
    if !result["data"].is_object() {
        return;
    }
    let base = format!("hetu://workspace/{scope}");
    let mut refs = Vec::new();
    let mut add = |path: String| refs.push(json!({"uri":format!("{base}/{path}")}));
    for doc in result["data"]["documents"].as_array().into_iter().flatten() {
        if let (Some(id), Some(revision)) = (
            doc["document_id"].as_str(),
            doc["current_revision_id"].as_str(),
        ) {
            add(format!("documents/{id}/revisions/{revision}"));
        }
    }
    for review in result["data"]["reviews"].as_array().into_iter().flatten() {
        if let Some(id) = review["draft_id"].as_str() {
            add(format!("reviews/{id}"));
        }
    }
    for (field, id_field, path) in [
        ("plots", "plot_revision_id", "plots"),
        ("reports", "report_id", "reports"),
        ("skeletons", "skeleton_id", "skeletons"),
        ("comparisons", "comparison_id", "comparisons"),
        ("snapshots", "snapshot_id", "git/snapshots"),
    ] {
        for value in result["data"][field].as_array().into_iter().flatten() {
            if let Some(id) = value[id_field].as_str() {
                if path == "skeletons" {
                    if let Some(revision) = value["revision"].as_u64() {
                        add(format!("{path}/{id}/revisions/{revision}"));
                    }
                } else {
                    add(format!("{path}/{id}"));
                }
            }
        }
    }
    for (field, key, path) in [
        ("draft", "draft_id", "reviews"),
        ("plot", "plot_revision_id", "plots"),
        ("report", "report_id", "reports"),
        ("skeleton", "skeleton_id", "skeletons"),
        ("snapshot", "snapshot_id", "git/snapshots"),
    ] {
        if let Some(id) = result["data"][field][key].as_str() {
            add(format!("{path}/{id}"));
        }
    }
    result["data"]["mcp_resources"] = json!(refs);
    let (cursor_field, parameter) = if result["data"].get("reports_next_cursor").is_some() {
        ("reports_next_cursor", "report_cursor")
    } else {
        ("next_cursor", "cursor")
    };
    if let Some(cursor) = result["data"][cursor_field].as_str() {
        let (path, query) = uri.split_once('?').unwrap_or((uri, ""));
        let mut params: BTreeMap<String, String> = form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect();
        params.insert(parameter.into(), cursor.into());
        let query = form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params)
            .finish();
        result["data"]["mcp_next_page_uri"] = json!(format!("{path}?{query}"));
    }
}
