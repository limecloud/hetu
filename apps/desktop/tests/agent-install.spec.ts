import {test,expect} from "@playwright/test";
import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {AgentConnectionInstall} from "../src/main/agent-connection-install.ts";
import {RecoveryStore} from "../src/main/recovery.ts";

test("安装未知结果恢复原键，完成旧版本后才能准备更新",async()=>{
 const file=path.join(await mkdtemp(path.join(tmpdir(),"hetu-install-recovery-")),"journal.json");
 let count=0,approvals=0,unknown=true,version="1",installed="";
 const plans=new Map<string,any>(),keys:string[]=[];
 const machine=async(action:string,input:any)=>{
  if(action==="hetu.local_settings.prepare"){
   const id="localop_00000000-0000-4000-8000-"+String(++count).padStart(12,"0");
   const plan={operation_id:id,sha256:"a".repeat(64),state:"pending",revision:1,fixed:{kind:"agent_suite",agent_client:"codex",work_ref:null,suite:{suite_id:"general",version}},installation:{state:"registered",version}};
   plans.set(id,plan);return structuredClone(plan);
  }
  if(action==="hetu.local_settings.get_operation")return structuredClone(plans.get(input.operation_id));
  if(action==="hetu.local_settings.execute"){
   const plan=plans.get(input.operation_id);keys.push(input.operation_key);plan.state="executing";
   if(unknown){unknown=false;throw new Error("回执未知");}
   plan.state="executed";installed=plan.fixed.suite.version;return structuredClone(plan);
  }
  if(action==="hetu.local_settings.inspect_suite")return {state:installed?"found":"missing",registration:"enabled",version_differs:installed!==version};
  throw new Error(action);
 };
 const installer=new AgentConnectionInstall(machine,async plan=>{approvals++;plans.get(plan.operation_id).state="approved";},new RecoveryStore(),file);
 const target={kind:"agent_suite" as const,agent_client:"codex",suite_id:"general"};
 await expect(installer.run(target)).rejects.toThrow("回执未知");
 const original=JSON.parse(await readFile(file,"utf8"));
 await installer.run(target);
 expect(keys).toEqual([original.operation_key,original.operation_key]);
 expect(count).toBe(1);expect(approvals).toBe(1);
 await installer.run(target);expect(keys).toHaveLength(2);
 version="2";await installer.run(target);
 expect(count).toBe(2);expect(approvals).toBe(2);
 expect(keys[2]).not.toBe(original.operation_key);expect(installed).toBe("2");
 expect(JSON.parse(await readFile(file,"utf8")).state).toBe("registered");
});

test("取消固定安装不执行或写执行恢复键",async()=>{
 const file=path.join(await mkdtemp(path.join(tmpdir(),"hetu-install-cancel-")),"journal.json");
 let executed=false;
 const installer=new AgentConnectionInstall(async(action)=>{if(action==="hetu.local_settings.prepare")return {state:"pending"};executed=true;throw new Error("unexpected");},async()=>{throw new Error("已取消");},new RecoveryStore(),file);
 await expect(installer.run()).rejects.toThrow("已取消");
 expect(executed).toBe(false);expect(await readFile(file).catch(()=>null)).toBeNull();
});
