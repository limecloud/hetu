//! 默认产品隔离样本；不安装或调用任何创作插件。
use hetu_core::Kernel;
use serde_json::{Value, json};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    let value =
        k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}));
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert_eq!(args.len(), 2);
    let kernel=Kernel::open(json!({"workspace_path":args[0],"mode":"author","create":{"title":"默认小说","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let novel = call(&kernel, "works.list", json!({}))["works"][0]["work_ref"].clone();
    let doc = call(
        &kernel,
        "documents.create",
        json!({"kind":"novel_chapter","title":"第一章 雾港","source_format":"markdown","content":"灯塔在黎明前亮起。\n江岚合上旧日记。🌿","operation_key":"chapter"}),
    );
    let drama = call(
        &kernel,
        "drama.projects.create",
        json!({"title":"默认剧本","mode":"original","operation_key":"drama"}),
    );
    let drama_work = call(&kernel, "works.list", json!({"kind":"drama"}))["works"][0]["work_ref"].clone();
    let ep = call(
        &kernel,
        "drama.episodes.create",
        json!({"project_ref":{"project_id":drama["project"]["project_id"],"revision":drama["project"]["revision"],"sha256":drama["sha256"]},"title":"雾港初见","language_tag":"zh-CN","operation_key":"drama-episode"}),
    );
    let content = "INT. 灯塔 - 夜\n\n江岚合上日记，望向窗外。\n\n江岚\n船还没来。";
    call(
        &kernel,
        "documents.save",
        json!({"document_id":ep["document"]["document_id"],"base_revision_id":ep["document"]["current_revision_id"],"content":content,"source_format":"fountain","operation_key":"script"}),
    );
    let video = call(
        &kernel,
        "video.projects.create",
        json!({"title":"默认视频","brief":"实际片段审阅","language_tag":"zh-CN","operation_key":"video"}),
    );
    let episode = call(
        &kernel,
        "video.episodes.create",
        json!({"project_ref":{"video_project_id":video["project"]["video_project_id"],"revision":video["project"]["revision"],"sha256":video["sha256"]},"title":"雨夜","brief":"渡口灯光","operation_key":"video-episode"}),
    );
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../desktop/tests/fixtures/preview.mp4");
    let scan = call(&kernel, "assets.inspect", json!({"file_path":file}));
    let asset = call(
        &kernel,
        "assets.import",
        json!({"work_ref":video["work_ref"],"file_path":file,"expected_file":{"sha256":scan["sha256"],"size_bytes":scan["size_bytes"]},"title":"雨夜片段","source":{"source_type":"author_supplied","creator_statement":"隔离验收样本"},"rights_status":"author_owned","redistribution_allowed":true,"rights_statement":"允许交付隔离样本","operation_key":"asset"}),
    );
    let mut input = json!({"work_ref":video["work_ref"],"video_episode_id":episode["episode"]["video_episode_id"],"asset_ref":{"asset_id":asset["asset"]["asset_id"],"revision":1,"sha256":asset["sha256"]},"title":"雨夜第一版","purpose":"clip","stream_index":0,"time_base":{"numerator":1,"denominator":1000},"duration_ticks":4000,"operation_key":"media-v1"});
    let first = call(&kernel, "video.media.save", input.clone());
    input["title"] = json!("雨夜第二版");
    input["previous_media_ref"] = first["media_ref"].clone();
    input["operation_key"] = json!("media-v2");
    let second = call(&kernel, "video.media.save", input);
    let mut grants = json!({});
    for (name, work) in [
        ("novel", novel.clone()),
        ("drama", drama_work.clone()),
        ("video", video["work_ref"].clone()),
    ] {
        grants[name]=call(&kernel,"collaboration.authorize_workspace",json!({"work_ref":work,"client_adapter":"codex","collaboration_path":args[1],"operation_key":format!("grant-{name}")}))["management_ref"].clone();
    }
    println!(
        "{}",
        json!({"novel":novel,"document":doc,"drama":drama_work,"video":video["work_ref"],"episode_id":episode["episode"]["video_episode_id"],"first":first["media_ref"],"second":second["media_ref"],"grants":grants})
    );
}
