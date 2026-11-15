use hetu_core::Kernel;
use serde_json::{Value,json};
use std::path::Path;
fn call(k:&Kernel, action:&str,input:Value)->Value { k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input})) }
fn ok(value:Value)->Value { assert!(matches!(value["status"].as_str(),Some("succeeded"|"pending")),"{value}");value["data"].clone() }
fn open(path:&Path,author:bool,create:bool)->Kernel {
 let mut input=json!({"workspace_path":path,"mode":if author {"author"} else {"agent"}});
 if create {input["create"]=json!({"title":"版本协作测试","locale":"zh-CN","operation_key":"init"});} Kernel::open(input).unwrap()
}
fn prepared(agent:&Kernel,action:&str,mut input:Value,key:&str)->Value {
 input["operation_key"]=json!(format!("inner-{key}"));
 ok(call(agent,"agent_operations.prepare",json!({"action":format!("hetu.git.{action}"),"input":input,"summary":"核对版本操作","operation_key":format!("prepare-{key}")})))
}
fn execute(author:&Kernel,agent:&Kernel,plan:&Value,key:&str)->Value {
 assert_eq!(call(agent,"agent_operations.execute",json!({"proposal_id":plan["proposal_id"],"proposal_sha256":plan["proposal_sha256"],"operation_key":format!("early-{key}")}))["error"]["code"],"hetu.author_confirmation_required");
 ok(call(author,"agent_operations.decide",json!({"proposal_id":plan["proposal_id"],"proposal_sha256":plan["proposal_sha256"],"expected_state_revision":plan["state_revision"],"decision":"approve","operation_key":format!("approve-{key}")})));
 let input=json!({"proposal_id":plan["proposal_id"],"proposal_sha256":plan["proposal_sha256"],"operation_key":format!("execute-{key}")});
 let result=ok(call(agent,"agent_operations.execute",input.clone()));
 assert_eq!(ok(call(agent,"agent_operations.execute",input)),result);result
}
fn raw_commit(repo:&git2::Repository,base:Option<git2::Oid>,content:&str)->git2::Oid {
 let mut tree=repo.treebuilder(base.map(|id|repo.find_commit(id).unwrap().tree().unwrap()).as_ref()).unwrap();
 let blob=repo.blob(content.as_bytes()).unwrap();tree.insert("README.md",blob,0o100644).unwrap();
 let id=tree.write().unwrap();let tree=repo.find_tree(id).unwrap();
 let signature=git2::Signature::new("测试作者","author@hetu.test",&git2::Time::new(1000,0)).unwrap();
 let parents=base.map(|id|repo.find_commit(id).unwrap()).into_iter().collect::<Vec<_>>();
 repo.commit(None,&signature,&signature,content,&tree,&parents.iter().collect::<Vec<_>>()).unwrap()
}
#[test]
fn version_lines_merge_conflicts_and_replay_preserve_author_worktree_and_index() {
 let root=tempfile::tempdir().unwrap();let path=root.path().join("作品 中文 🌧️");let author=open(&path,true,true);let agent=open(&path,false,false);
 ok(call(&author,"git.init",json!({"branch":"main","operation_key":"git"})));
 let repo=git2::Repository::open(&path).unwrap();let base=raw_commit(&repo,None,"初稿");repo.reference("refs/heads/main",base,false,"base").unwrap();
 std::fs::write(path.join("README.md"),"作者当前正文不应变化").unwrap();
 let index_before=std::fs::read(path.join(".git/index")).ok();
 let head=ok(call(&agent,"git.status",json!({})))["head"].clone();
 let create=prepared(&agent,"branch_create",json!({"expected_head":head,"branch":"短剧改编","start_commit":base.to_string()}),"branch");
 assert!(repo.find_reference("refs/heads/短剧改编").is_err());execute(&author,&agent,&create,"branch");
 let ours=raw_commit(&repo,Some(base),"本地修改");let theirs=raw_commit(&repo,Some(base),"对方修改");
 repo.reference("refs/heads/main",ours,true,"ours").unwrap();repo.reference("refs/heads/短剧改编",theirs,true,"theirs").unwrap();
 let preview=ok(call(&agent,"git.merge_preview",json!({"target_commit":theirs.to_string()})));
 assert_eq!(preview["ready"],false);assert_eq!(preview["conflicts"][0]["path"],"README.md");
 assert_eq!(preview["conflicts"][0]["theirs"]["text"],"对方修改");
 let plan=prepared(&agent,"merge",json!({"expected_head":ok(call(&agent,"git.status",json!({})))["head"],"target_commit":theirs.to_string(),"resolutions":[{"path":"README.md","choice":"theirs"}],"author":{"name":"作者","email":"author@hetu.test"},"message":"明确采用对方的版本记录"}),"merge");
 let result=execute(&author,&agent,&plan,"merge");
 let merged=git2::Oid::from_str(result["result"]["head"]["commit_id"].as_str().unwrap()).unwrap();
 let commit=repo.find_commit(merged).unwrap();assert_eq!(commit.parent_count(),2);
 assert_eq!(repo.find_blob(commit.tree().unwrap().get_name("README.md").unwrap().id()).unwrap().content(),"对方修改".as_bytes());
 assert_eq!(std::fs::read_to_string(path.join("README.md")).unwrap(),"作者当前正文不应变化");assert_eq!(std::fs::read(path.join(".git/index")).ok(),index_before);
 // 模拟引用已移动但结果事务尚未持久化。不能以新 HEAD 作为合并父节点。
 let state_path=path.join(format!(".hetu/agent-proposals/{}.state.json",plan["proposal_id"].as_str().unwrap()));
 let mut state:Value=serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
 state["state"]=json!("executing");state.as_object_mut().unwrap().remove("result");
 std::fs::write(&state_path,serde_json::to_vec(&state).unwrap()).unwrap();
 let recovered=ok(call(&agent,"agent_operations.execute",json!({"proposal_id":plan["proposal_id"],"proposal_sha256":plan["proposal_sha256"],"operation_key":"merge-after-crash"})));
 assert_eq!(recovered["result"]["head"]["commit_id"],merged.to_string());
 assert_eq!(repo.head().unwrap().target(),Some(merged));
 let switch=prepared(&agent,"branch_switch",json!({"expected_head":ok(call(&agent,"git.status",json!({})))["head"],"branch":"短剧改编"}),"switch");execute(&author,&agent,&switch,"switch");
 assert_eq!(repo.head().unwrap().target(),Some(theirs));assert_eq!(std::fs::read_to_string(path.join("README.md")).unwrap(),"作者当前正文不应变化");
}
#[test]
fn fixed_remote_push_fetch_and_pull_recover_without_force_overwriting() {
 let root=tempfile::tempdir().unwrap();let path=root.path().join("work");let author=open(&path,true,true);let agent=open(&path,false,false);
 ok(call(&author,"git.init",json!({"branch":"main","operation_key":"git"})));
 let repo=git2::Repository::open(&path).unwrap();let base=raw_commit(&repo,None,"初稿");repo.reference("refs/heads/main",base,false,"base").unwrap();
 let remote_path=root.path().join("本地 远端.git");let bare=git2::Repository::init_bare(&remote_path).unwrap();
 let save=prepared(&agent,"remote_save",json!({"remote":"origin","url":remote_path}),"remote");execute(&author,&agent,&save,"remote");
 let push=prepared(&agent,"push",json!({"remote":"origin","branch":"main","target_commit":base.to_string()}),"push");execute(&author,&agent,&push,"push");
 assert_eq!(bare.find_reference("refs/heads/main").unwrap().target(),Some(base));
 let local_next=raw_commit(&repo,Some(base),"本地后续");
 let stale_push=prepared(&agent,"push",json!({"remote":"origin","branch":"main","target_commit":local_next.to_string()}),"stale-push");
 ok(call(&author,"agent_operations.decide",json!({"proposal_id":stale_push["proposal_id"],"proposal_sha256":stale_push["proposal_sha256"],"expected_state_revision":stale_push["state_revision"],"decision":"approve","operation_key":"approve-stale-push"})));
 let other=raw_commit(&bare,Some(base),"远端的新稿");bare.reference("refs/heads/main",other,true,"other").unwrap();
 assert_eq!(call(&agent,"agent_operations.execute",json!({"proposal_id":stale_push["proposal_id"],"proposal_sha256":stale_push["proposal_sha256"],"operation_key":"execute-stale-push"}))["error"]["code"],"revision_conflict");
 assert_eq!(bare.find_reference("refs/heads/main").unwrap().target(),Some(other));
 let fetch=prepared(&agent,"fetch",json!({"remote":"origin","branch":"main"}),"fetch");execute(&author,&agent,&fetch,"fetch");
 assert_eq!(repo.find_reference("refs/remotes/origin/main").unwrap().target(),Some(other));
 let pull=prepared(&agent,"pull",json!({"expected_head":ok(call(&agent,"git.status",json!({})))["head"],"target_commit":other.to_string(),"author":{"name":"作者","email":"author@hetu.test"},"message":"合并远端"}),"pull");execute(&author,&agent,&pull,"pull");
 assert_eq!(repo.head().unwrap().target(),Some(other));
 assert_eq!(call(&agent,"agent_operations.prepare",json!({"action":"hetu.git.remote_save","input":{"remote":"bad","url":"https://token:secret@github.com/team/book.git","operation_key":"bad"},"summary":"不允许地址带凭据","operation_key":"bad"}))["error"]["code"],"invalid_input");
 repo.config().unwrap().set_str("url.ssh://git@other.invalid/.insteadof","https://approved.invalid/").unwrap();
 assert_eq!(call(&agent,"agent_operations.prepare",json!({"action":"hetu.git.push","input":{"remote":"origin","branch":"main","target_commit":other.to_string(),"operation_key":"rewritten"},"summary":"拒绝仓库改写已审阅地址","operation_key":"rewritten"}))["error"]["code"],"forbidden");
}
