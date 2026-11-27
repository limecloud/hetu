import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {closeApplication} from "./navigation.ts";

test("Finder环境发现真实Codex并连接TUI，恢复原线程且不发送模型请求",async({},info)=>{
 test.skip(process.env.HETU_LIVE_CODEX!=="1","需显式启用真实Codex本机验证。");test.setTimeout(180000);
 const root=path.resolve(import.meta.dirname,"../../.."),profile=await mkdtemp(path.join(os.tmpdir(),"hetu-codex-discovery-"));
 const env:NodeJS.ProcessEnv={...process.env,PATH:process.platform==="win32"?process.env.PATH:"/usr/bin:/bin:/usr/sbin:/sbin",HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:path.join(profile,"collaboration"),HETU_LOCAL_SETTINGS_DIR:path.join(profile,"settings"),HETU_PLUGIN_STATE_DIR:profile};
 for(const key of ["HETU_CODEX_BIN","ELECTRON_RUN_AS_NODE","HETU_APP_SERVER","HETU_CLI","HETU_MCP","HETU_PLUGIN_NODE"])delete env[key];
 const executable=process.env.HETU_PACKAGED_APP;
 const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env});
 try{
  const page=await app.firstWindow();await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled();
  const engines=await page.evaluate(()=>window.hetuDesktop.agentSession("catalog",{scope:"library"}));
  expect(engines.find((engine:any)=>engine.id==="codex")?.available).toBe(true);
  await page.evaluate(()=>window.hetuDesktop.agentSession("new",{scope:"library",launch:{client:"codex",surface:"tui"}}));
  const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));
  await expect.poll(async()=>{const state=await get();return state.terminal_connected&&state.terminal_replay?.includes("]7501;state=idle");},{timeout:60000}).toBe(true);
  const original=await get();expect(original.thread_id).toBeTruthy();expect(original.messages).toHaveLength(0);
  await page.evaluate(()=>window.hetuDesktop.agentSession("stop",{scope:"library"}));
  await page.evaluate(()=>window.hetuDesktop.agentSession("start",{scope:"library"}));
  await expect.poll(async()=>{const state=await get();return state.terminal_connected&&state.terminal_replay?.includes("]7501;state=idle");},{timeout:60000}).toBe(true);
  const restored=await get();expect(restored.thread_id).toBe(original.thread_id);expect(restored.messages).toHaveLength(0);
  await writeFile(info.outputPath("discovery.json"),JSON.stringify({packaged:!!executable,minimal_path:true,explicit_codex_override:false,real_tui_connected:true,same_thread_restored:true,model_messages:0},null,2)+"\n");
 }finally{await closeApplication(app);}
});
