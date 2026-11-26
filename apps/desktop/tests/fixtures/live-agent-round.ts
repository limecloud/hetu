import {expect,type Page} from "@playwright/test";
import {createHash} from "node:crypto";
import type {SessionSnapshot} from "../../src/agent-session-contract.ts";

export type LiveRound={marker:string;prompt_sha256:string;state:"prepared"|"dispatching"|"observed";complete?:boolean;user_message_id?:string;turn_id?:string;snapshot?:Partial<SessionSnapshot>};
type RoundOptions={page:Page;get():Promise<SessionSnapshot>;rounds:Record<string,LiveRound>;save():Promise<unknown>;prefix:string};

/** 发送前记录意图；观察失败后只接续原轮次，不以再次点击修复未知投递。 */
export async function dispatchLiveAgentRound(options:RoundOptions,key:string,text:string){
 const {page,get,rounds,save,prefix}=options,marker=`【${prefix} ${key}】`,prompt=marker+"\n"+text;
 let saved=rounds[key];
 const digest=createHash("sha256").update(prompt).digest("hex");
 if(!saved){saved=rounds[key]={marker,prompt_sha256:digest,state:"prepared"};await save();}else expect(saved.prompt_sha256,"固定轮次的请求已改变，不能重发").toBe(digest);
 let snapshot=await get(),message=snapshot.messages.find(item=>item.role==="user"&&item.text.includes(marker));
 if(!message&&saved.state==="prepared"){
  expect(snapshot.state,"原轮次未核对完成，不能发送新请求").toBe("ready");
  await expect(page.locator(".codex-session")).not.toHaveAttribute("aria-busy","true");
  await page.getByRole("textbox",{name:"发送给 Agent",exact:true}).fill(prompt);
  const send=page.getByRole("button",{name:"发送",exact:true});await expect(send).toBeEnabled();
  saved.state="dispatching";await save();await send.click();
 }
 if(!message){
  await expect.poll(async()=>{snapshot=await get();message=snapshot.messages.find(item=>item.role==="user"&&item.text.includes(marker));return !!message;},{timeout:45000,message:"未观察到原请求，保留本轮投递记录，不再次发送"}).toBe(true);
 }
 saved.user_message_id=message!.id;saved.turn_id=message!.turn_id;saved.state="observed";await save();
 return {saved,snapshot};
}

/** 需要观察在途故障时只调用dispatch；正常业务在同一原标记上等待结束。 */
export async function liveAgentRound(options:RoundOptions,key:string,text:string){
 if(options.rounds[key]?.complete)return options.rounds[key].snapshot!;
 const {saved}=await dispatchLiveAgentRound(options,key,text),{get,save}=options;let snapshot=await get();
 const marker=saved.marker;
 await expect.poll(async()=>{snapshot=await get();const original=snapshot.messages.find(item=>item.role==="user"&&item.text.includes(marker));return snapshot.state==="ready"&&!!original?.turn_id&&snapshot.messages.some(item=>item.role==="assistant"&&item.turn_id===original.turn_id);},{timeout:600000,intervals:[1000,2000,5000]}).toBe(true);
 saved.turn_id=snapshot.messages.find(item=>item.role==="user"&&item.text.includes(marker))!.turn_id;
 saved.complete=true;saved.snapshot={session_id:snapshot.session_id,thread_id:snapshot.thread_id,tools:snapshot.tools?.filter(tool=>tool.turn_id===saved.turn_id),messages:snapshot.messages.filter(item=>item.turn_id===saved.turn_id)};
 await save();return saved.snapshot;
}
