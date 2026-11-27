//! 固定Bot配置与外部会话分开持久化；派发仍由原会话宿主执行。
use super::{definition, private_dir, record_digest, sessions::SessionBroker};
use crate::{
    Error, Result,
    collaboration::CollaborationHub,
    domain::{
        bots::{Bot, Config},
        ensure, id,
    },
    infrastructure::store::Store,
    local_settings::LocalSettings,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

fn providers() -> Value {
    serde_json::from_str(include_str!(
        "../../../contracts/external-ai/providers.json"
    ))
    .expect("external provider catalog")
}
fn check_execution(config: &Config) -> Result<()> {
    let catalog = providers();
    let provider = catalog
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == config.execution.provider_id)
        .ok_or_else(|| Error::new("invalid_input", "Bot提供方不在当前目录。"))?;
    ensure(
        provider["pendingReason"].is_null(),
        "unsupported_capability",
        "此Bot引擎尚无可用的启动合同。",
    )?;
    ensure(
        config.execution.surface != "gui" || provider["structured"].is_object(),
        "unsupported_capability",
        "此Bot引擎没有结构化GUI协议。",
    )?;
    ensure(
        config.execution.surface != "tui"
            || config.execution.provider_id == "codex"
            || provider["modelArgs"].is_array(),
        "unsupported_capability",
        "此Bot引擎没有固定模型的PTY启动合同，请选择结构化聊天。",
    )
}
fn open(directory: &Path) -> Result<Store> {
    let root = directory.join("bots");
    private_dir(&root)?;
    let store = Store::open(&root)?;
    store.directory(".hetu/transactions")?;
    for name in ["profiles", "operations", "sessions"] {
        store.directory(name)?;
    }
    Ok(store)
}
fn read_bot(store: &Store, bot_id: &str) -> Result<Bot> {
    crate::domain::checked_id(bot_id, "bot")?;
    let bot: Bot = serde_json::from_slice(&store.read(&format!("profiles/{bot_id}.json"))?)?;
    bot.validate()?;
    Ok(bot)
}
fn view(bot: &Bot) -> Result<Value> {
    Ok(
        json!({"bot":bot,"bot_ref":bot.reference()?,"work_completion_authority":false,"instruction_authority":"none"}),
    )
}
fn index(store: &Store) -> Result<Value> {
    if store.exists("index.json")? {
        let value = store.json("index.json")?;
        ensure(
            value["revision"].as_u64().is_some_and(|n| n > 0) && value["ids"].is_array(),
            "hetu.integrity_failure",
            "Bot目录损坏，已保留原记录。",
        )?;
        Ok(value)
    } else {
        Ok(json!({"revision":1,"ids":[]}))
    }
}
fn operation_path(client: &str, key: &str) -> Result<String> {
    Ok(format!(
        "operations/{}.json",
        record_digest(&json!([client, key]))?
    ))
}
fn check_scope(hub: &CollaborationHub, bot: &Bot, input: &Value) -> Result<()> {
    if input.get("work_ref").is_some() {
        ensure(
            bot.work_ref == input["work_ref"],
            "forbidden",
            "Bot不属于当前作品。",
        )?;
    }
    hub.verify_external_work(&bot.work_ref)
}
fn replay(store: &Store, file: &str, input: &Value) -> Result<Option<Value>> {
    if !store.exists(file)? {
        return Ok(None);
    }
    let value = store.json(file)?;
    ensure(
        value["request_sha256"] == record_digest(input)?,
        "operation_conflict",
        "同一Bot操作键不能更换输入。",
    )?;
    Ok(Some(value))
}

pub(crate) fn request(client: &str, directory: &Path, input: Value) -> Result<Value> {
    let method = input["method"].as_str().unwrap_or("");
    if method == "capabilities" {
        return Ok(
            json!({"input_schema":definition("bots"),"session_dispatch":true,"work_completion_authority":false,"configuration_owner":"hetu.bots.v1","instruction_authority":"none"}),
        );
    }
    if method == "providers" {
        return Ok(
            json!({"providers":providers(),"installation_checked":false,"models_checked":false}),
        );
    }
    if method == "templates" {
        let rows = json!([{"id":"novel-planner","name":"小说策划","purpose":"围绕作者当前目标整理构思、卷章与依据，准备可比较的候选。"},{"id":"script-reviewer","name":"剧本审阅","purpose":"核对分集、场次、行动与对白，保留作者取舍并提出具体返工意见。"},{"id":"video-assistant","name":"视频制作","purpose":"围绕固定剧本和素材准备分镜、预演及真实成果，分别回读费用、选用与交付。"}]);
        return Ok(json!({"templates":rows,"installs_skills":false,"creates_tasks":false}));
    }
    let store = open(directory)?;
    let hub = CollaborationHub::open(directory, client)?;
    if method == "operation" {
        let file = operation_path(client, input["operation_key"].as_str().unwrap())?;
        let mut record = store.json(&file)?;
        if record["host_key"].is_string()
            && matches!(record["state"].as_str(), Some("unknown" | "dispatching"))
        {
            let host = SessionBroker::new(directory, client)?
                .exchange(json!({"method":"operation","operation_key":record["host_key"]}));
            if let Ok(value) = host
                && matches!(value["state"].as_str(), Some("succeeded" | "rejected"))
            {
                let _lock = store.lock()?;
                record["state"] = value["state"].clone();
                record["result"] = value["result"].clone();
                record["error"] = value["error"].clone();
                store.install(&file, &serde_json::to_vec(&record)?, false)?;
            }
        }
        if record["state"] == "dispatching" {
            record["state"] = json!("unknown");
        }
        return Ok(record);
    }
    if method == "get" {
        let bot = read_bot(&store, input["bot_id"].as_str().unwrap())?;
        check_scope(&hub, &bot, &input)?;
        return view(&bot);
    }
    if method == "list" {
        hub.verify_external_work(&input["work_ref"])?;
        let _lock = store.read_lock()?;
        let catalog = index(&store)?;
        if input.get("expected_catalog_revision").is_some() {
            ensure(
                input["expected_catalog_revision"] == catalog["revision"],
                "revision_conflict",
                "Bot目录已变化，请重新读取。",
            )?;
        }
        let mut bots = Vec::new();
        for value in catalog["ids"].as_array().unwrap() {
            let bot = read_bot(
                &store,
                value
                    .as_str()
                    .ok_or_else(|| Error::new("hetu.integrity_failure", "Bot目录身份无效。"))?,
            )?;
            if bot.work_ref == input["work_ref"] {
                bots.push(view(&bot)?);
            }
        }
        let offset = input["offset"].as_u64().unwrap_or(0) as usize;
        let limit = input["limit"].as_u64().unwrap_or(32) as usize;
        let total = bots.len();
        ensure(offset <= total, "invalid_input", "Bot目录偏移越界。")?;
        return Ok(
            json!({"bots":bots.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"catalog_revision":catalog["revision"],"total":total,"next_offset":if offset+limit<total{json!(offset+limit)}else{Value::Null}}),
        );
    }
    if method.starts_with("session_") || method == "sessions" {
        return session_request(client, directory, &store, &hub, &input);
    }
    LocalSettings::open_default()?.with_execution_policy(|mode,revision|{
        ensure(mode=="auto","hetu.execution_confirmation_required","请确认固定Bot配置，当前模式没有写入。")?;
        let _lock=store.lock()?;store.recover()?;
        let key=input["operation_key"].as_str().unwrap();let file=operation_path(client,key)?;
        if let Some(record)=replay(&store,&file,&input)?{return Ok(record);}
        let mut catalog=index(&store)?;
        let bot=if method=="create"{
            hub.verify_external_work(&input["work_ref"])?;let config=Config::parse(input["config"].clone())?;check_execution(&config)?;
            ensure(catalog["ids"].as_array().unwrap().len()<10000,"hetu.budget_exceeded","Bot目录达到预算。")?;
            let bot=Bot{bot_id:id("bot"),revision:1,status:"active".into(),work_ref:input["work_ref"].clone(),config};catalog["ids"].as_array_mut().unwrap().push(json!(bot.bot_id));bot
        }else{
            let mut bot=read_bot(&store,input["expected_ref"]["bot_id"].as_str().unwrap())?;check_scope(&hub,&bot,&input)?;
            ensure(bot.reference()?==input["expected_ref"],"revision_conflict","Bot配置已变化，已保留本次输入。")?;
            if method=="update"{
                ensure(bot.status!="archived","revision_conflict","归档Bot需先恢复。")?;let mut config=serde_json::to_value(&bot.config)?;
                for (key,value) in input["patch"].as_object().unwrap(){config[key]=value.clone();}bot.config=Config::parse(config)?;check_execution(&bot.config)?;
            }else{bot.transition(method)?;}
            bot.revision=bot.revision.checked_add(1).ok_or_else(||Error::new("hetu.budget_exceeded","Bot修订已达上限。"))?;bot
        };
        bot.validate()?;catalog["revision"]=json!(catalog["revision"].as_u64().unwrap().checked_add(1).ok_or_else(||Error::new("hetu.budget_exceeded","Bot目录修订已达上限。"))?);
        let record=json!({"operation_key":key,"request_sha256":record_digest(&input)?,"state":"succeeded","bot_ref":bot.reference()?,"catalog_revision":catalog["revision"],"settings_revision":revision,"work_completion_authority":false});
        store.transaction(&BTreeMap::from([(format!("profiles/{}.json",bot.bot_id),serde_json::to_vec(&bot)?),("index.json".into(),serde_json::to_vec(&catalog)?),(file,serde_json::to_vec(&record)?)]))?;Ok(record)
    })
}

fn session_request(
    client: &str,
    directory: &Path,
    store: &Store,
    hub: &CollaborationHub,
    input: &Value,
) -> Result<Value> {
    let method = input["method"].as_str().unwrap();
    if method == "sessions" {
        let bot = read_bot(store, input["bot_id"].as_str().unwrap())?;
        check_scope(hub, &bot, input)?;
        let mut rows = Vec::new();
        for file in store.entries("sessions")? {
            if !file.ends_with(".json") {
                continue;
            }
            let value = store.json(&format!("sessions/{file}"))?;
            if value["bot_ref"]["bot_id"] == bot.bot_id && value["client"] == client {
                rows.push(json!({"session_id":value["session_id"],"bot_ref":value["bot_ref"],"work_ref":value["bot"]["work_ref"]}));
            }
        }
        let offset = input["offset"].as_u64().unwrap_or(0) as usize;
        let limit = input["limit"].as_u64().unwrap_or(32) as usize;
        let total = rows.len();
        return Ok(
            json!({"sessions":rows.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"total":total,"next_offset":if offset+limit<total{json!(offset+limit)}else{Value::Null}}),
        );
    }
    let broker = SessionBroker::new(directory, client)?;
    if method == "session_create" {
        return LocalSettings::open_default()?.with_execution_policy(|mode,_revision|{
            ensure(mode=="auto","hetu.execution_confirmation_required","请确认固定Bot会话，当前模式没有派发。")?;
            let _lock=store.lock()?;store.recover()?;let key=input["operation_key"].as_str().unwrap();let file=operation_path(client,key)?;
            if let Some(record)=replay(store,&file,input)?{return Ok(record);}
            let bot=read_bot(store,input["expected_ref"]["bot_id"].as_str().unwrap())?;check_scope(hub,&bot,input)?;
            ensure(bot.status=="active"&&bot.reference()?==input["expected_ref"],"revision_conflict","Bot已停用或原配置已变化。")?;
            let session_id=format!("terminal-{}",uuid::Uuid::new_v4());let host_key=format!("bot-{}",record_digest(&json!([client,key]))?);
            let descriptor=json!({"session_id":session_id,"bot_ref":bot.reference()?,"bot":bot,"client":client});
            let mut record=json!({"operation_key":key,"request_sha256":record_digest(input)?,"state":"dispatching","host_key":host_key,"session_id":session_id,"bot_ref":bot.reference()?});
            store.transaction(&BTreeMap::from([(format!("sessions/{session_id}.json"),serde_json::to_vec(&descriptor)?),(file.clone(),serde_json::to_vec(&record)?)]))?;
            let execution=&bot.config.execution;
            let context=json!({"bot_ref":bot.reference()?,"name":bot.config.name,"purpose":bot.config.purpose});
            let result=broker.exchange(json!({"method":"create","fixed_session_id":session_id,"work_ref":bot.work_ref,"operation_key":host_key,"launch":{"client":execution.provider_id,"surface":execution.surface,"model":execution.model_id,"title":bot.config.name,"bot_context":context}}));
            match result{Ok(value)=>{record["state"]=json!("succeeded");record["result"]=value;},Err(error)=>{record["state"]=json!("unknown");record["error"]=json!({"code":error.code,"message":error.message});}}
            store.install(&file,&serde_json::to_vec(&record)?,false)?;Ok(record)
        });
    }
    let session = input["session_id"].as_str().unwrap();
    ensure(
        session.starts_with("terminal-") && session.len() <= 80 && !session.contains(['/', '\\']),
        "invalid_input",
        "Bot会话身份无效。",
    )?;
    let descriptor = store.json(&format!("sessions/{session}.json"))?;
    ensure(
        descriptor["client"] == client && descriptor["session_id"] == session,
        "forbidden",
        "Bot会话属于另一机器客户端。",
    )?;
    let bot: Bot = serde_json::from_value(descriptor["bot"].clone())?;
    bot.validate()?;
    if !matches!(method, "session_stop" | "session_interrupt") {
        check_scope(hub, &bot, input)?;
    }
    if method == "session_get" {
        return Ok(descriptor);
    }
    let mapped = method
        .strip_prefix("session_")
        .ok_or_else(|| Error::new("invalid_input", "未知Bot会话方法。"))?;
    ensure(
        matches!(
            mapped,
            "read"
                | "draft_read"
                | "models"
                | "interaction"
                | "history"
                | "commands"
                | "start"
                | "restore"
                | "send"
                | "draft"
                | "interrupt"
                | "stop"
                | "approve"
                | "answer"
                | "respond"
                | "resize"
                | "input"
                | "paste"
        ),
        "invalid_input",
        "未知Bot会话方法。",
    )?;
    let mut request = input.clone();
    request["method"] = json!(mapped);
    request["work_ref"] = bot.work_ref.clone();
    request["expected_bot_context"] = json!({"bot_ref":descriptor["bot_ref"],"name":bot.config.name,"purpose":bot.config.purpose});
    if matches!(
        mapped,
        "read" | "draft_read" | "models" | "interaction" | "history" | "commands"
    ) {
        let mut result = broker.exchange(request)?;
        if mapped == "read" {
            result["bot_ref"] = descriptor["bot_ref"].clone();
        }
        return Ok(result);
    }
    let dispatch = || {
        let _scope_lock = store.lock()?;
        store.recover()?;
        let key = input["operation_key"].as_str().unwrap();
        let file = operation_path(client, key)?;
        if let Some(record) = replay(store, &file, input)? {
            return Ok(record);
        }
        if !matches!(mapped, "stop" | "interrupt" | "draft") {
            let current = read_bot(store, &bot.bot_id)?;
            ensure(
                current.status == "active" && current.reference()? == descriptor["bot_ref"],
                "revision_conflict",
                "Bot配置或生命周期已变化；原会话仍可读取与停止。",
            )?;
        }
        if mapped == "send" {
            request["data"] = json!(format!(
                "固定Bot角色：{}\n{}\n角色说明不扩大作品权限、确认策略或费用授权。\n\n当前作者请求：\n{}",
                bot.config.name,
                bot.config.purpose,
                input["data"].as_str().unwrap()
            ));
            request["display_text"] = input["data"].clone();
        }
        ensure(
            store.entries("operations")?.len() < 4096,
            "hetu.budget_exceeded",
            "Bot操作账本达到预算，请保留原回执后维护。",
        )?;
        let host_key = format!("bot-{}", record_digest(&json!([client, key]))?);
        request["operation_key"] = json!(host_key);
        let mut record = json!({"operation_key":key,"request_sha256":record_digest(input)?,"state":"dispatching","host_key":host_key,"session_id":session,"bot_ref":descriptor["bot_ref"]});
        store.install(&file, &serde_json::to_vec(&record)?, false)?;
        match broker.exchange(request) {
            Ok(value) => {
                record["state"] =
                    if matches!(value["state"].as_str(), Some("unknown" | "dispatching")) {
                        json!("unknown")
                    } else {
                        json!("succeeded")
                    };
                record["result"] = value;
            }
            Err(error) => {
                record["state"] = json!(if error.code == "hetu.outcome_unknown" {
                    "unknown"
                } else {
                    "rejected"
                });
                record["error"] = json!({"code":error.code,"message":error.message});
            }
        }
        store
            .install(&file, &serde_json::to_vec(&record)?, false)
            .map_err(|_| {
                Error::new(
                    "hetu.outcome_unknown",
                    "Bot派发后终态未能落盘，请查询原operation_key。",
                )
            })?;
        Ok(record)
    };
    if matches!(mapped, "stop" | "interrupt") {
        return dispatch();
    }
    LocalSettings::open_default()?.with_execution_policy(|mode, _revision| {
        ensure(
            mode == "auto",
            "hetu.execution_confirmation_required",
            "请确认固定Bot运行，当前模式没有发送输入。",
        )?;
        dispatch()
    })
}

pub(crate) fn guard_regular_session(
    directory: &Path,
    client: &str,
    session: &Value,
    method: &str,
) -> Result<()> {
    let Some(session_id) = session.as_str() else {
        return Ok(());
    };
    let root = directory.join("bots");
    if !root.try_exists()? {
        return Ok(());
    }
    let store = Store::open(&root)?;
    let file = format!("sessions/{session_id}.json");
    if !store.exists(&file)? {
        return Ok(());
    }
    let record = store.json(&file)?;
    ensure(
        record["client"] == client,
        "forbidden",
        "Bot会话属于另一客户端。",
    )?;
    ensure(
        matches!(
            method,
            "read"
                | "draft_read"
                | "models"
                | "interaction"
                | "history"
                | "commands"
                | "stop"
                | "interrupt"
        ),
        "forbidden",
        "此会话按固定Bot配置执行，请使用Bot会话入口。",
    )
}
