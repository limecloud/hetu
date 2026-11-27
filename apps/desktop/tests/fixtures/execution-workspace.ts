import {expect,_electron as electron,type Page} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,symlink} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import {closeApplication} from "../navigation.ts";
import {fixtureBinary,machineBinary} from "../acceptance-paths.ts";
import {acp,acpForm,claudeQuestions} from "./external-protocol-fixture.ts";

const root=path.resolve(import.meta.dirname,"../../../..");

export async function launchExecutionWorkspace({seedWork=false,evidence=path.join(root,"output/verification/orca-ui-rework-2026-11-27"),node=process.env.HETU_TEST_NODE??process.execPath}:{seedWork?:boolean;evidence?:string;node?:string}={}){
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-external-ui-")),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration"),wire=path.join(folder,"wire.jsonl");
  await mkdir(profile);await writeFile(wire,"");await mkdir(evidence,{recursive:true});
  const workspace=path.join(folder,"作品");let work:any;
  if(seedWork){
    const fixture=spawnSync(fixtureBinary("external_execution_fixture"),[workspace,collaboration],{encoding:"utf8"});expect(fixture.status,fixture.stderr).toBe(0);work=JSON.parse(fixture.stdout).work_ref;
    await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:work.workspace_id,works:[{work_ref:work,title:"外部执行隔离小说"}]}]}));
  }
  // 包内Node路径可能含空格；临时链接保留同一二进制并提供可执行的shebang。
  const fixtureNode=path.join(folder,"node");await symlink(node,fixtureNode);
  for(const [name,fixture] of [["opencode",acpForm],["claude",claudeQuestions],["kilo",acp]] as const)await writeFile(path.join(folder,name),fixture.replace("NODE",fixtureNode).replace("FIXTURE_VERSION","2.0.14"),{mode:0o700});
  await writeFile(path.join(folder,"tui"),`#!${fixtureNode}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.TEST_PROTOCOL_LOG,JSON.stringify({kind:'tui-start',model:args[args.indexOf('--model')+1],role_present:fs.readFileSync('AGENTS.md','utf8').includes('保留固定角色与模型，使用原生终端继续。')})+'\\n');process.stdin.setRawMode(true);process.stdout.write('REAL-BOT-PTY-READY\\r\\n');process.stdin.on('data',data=>{fs.appendFileSync(process.env.TEST_PROTOCOL_LOG,JSON.stringify({kind:'tui-input',data:data.toString()})+'\\n');process.stdout.write(data);});\n`,{mode:0o700});
  const executable=process.env.HETU_PACKAGED_APP;
  const application=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...process.env,HETU_DESKTOP_PROFILE:profile,HETU_LOCAL_SETTINGS_DIR:path.join(profile,"local-settings"),HETU_PLUGIN_STATE_DIR:profile,HETU_COLLABORATION_DIR:collaboration,HETU_PLUGIN_NODE:node,HETU_OPENCODE_BIN:path.join(folder,"opencode"),HETU_CLAUDE_CODE_BIN:path.join(folder,"claude"),HETU_CLAUDE_AGENT_TEAMS_BIN:path.join(folder,"tui"),HETU_KILO_BIN:path.join(folder,"kilo"),CLAUDE_CONFIG_DIR:path.join(folder,"claude-config"),TEST_PROTOCOL_LOG:wire,...(!executable?{HETU_APP_SERVER:machineBinary("hetu-app-server"),HETU_CLI:machineBinary("hetu"),HETU_MCP:machineBinary("hetu-mcp")}:{})}});
  try{
    await writeFile(path.join(evidence,"fixture-"+application.process().pid+".json"),JSON.stringify({folder,profile,collaboration,application_pid:application.process().pid,packaged:!!executable},null,2)+"\n");
    const page=await application.firstWindow();await page.setViewportSize({width:1200,height:850});
    await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled({timeout:30000});
    await page.getByLabel("更多操作",{exact:true}).click();await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();
    await expect(page.getByRole("dialog",{name:"创建会话",exact:true})).toBeVisible();
    return {folder,profile,collaboration,wire,application,page,workspace,work};
  }catch(error){await closeApplication(application);throw error;}
}

export async function createExecutionChat(page:Page,client:string){
  if(!await page.getByRole("dialog",{name:"创建会话",exact:true}).isVisible())await page.getByRole("button",{name:"新建会话",exact:true}).click();
  const creation=page.getByRole("dialog",{name:"创建会话",exact:true});
  await creation.getByRole("button",{name:/^引擎(?: |$)/}).click();
  const catalog=await page.evaluate(()=>window.hetuDesktop.agentSession("catalog"));await creation.getByRole("tab",{name:catalog.find((item:any)=>item.id===client).name,exact:true}).click();
  await page.getByRole("button",{name:"打开聊天",exact:true}).click();
  await expect(creation).not.toBeVisible({timeout:45000});
  await expect(page.getByRole("button",{name:/^模型 /})).toBeVisible({timeout:30000});await page.getByRole("button",{name:/^模型 /}).click();
  const current=await page.evaluate(()=>window.hetuDesktop.agentSession("get")),label=current.external.models.find((item:any)=>item.id==="test-model").label;await page.getByRole("dialog",{name:"选择引擎与模型",exact:true}).getByRole("option",{name:label,exact:true}).click();await page.keyboard.press("Escape");
}
