import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {VideoReview} from "../src/main/video-review.ts";
import {RecoveryStore} from "../src/main/recovery.ts";

const work = {workspace_id:"workspace_video",kind:"video" as const,object_id:"video_project"};
const media = {media_id:"media_fixed",revision:1,sha256:"a".repeat(64)};
const draft = (comment:string) => ({comment,start:"0.2",end:"1.2",ranged:true});
function deferred() {
  let resolve!:()=>void;
  const promise = new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}

for (const clear of [false,true]) test(`较早媒体核对迟到，不覆盖${clear?"已经清除的草稿":"最后输入的视频意见"}`,async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-video-draft-order-"));
  const firstLookup=deferred(),entered=deferred();let reads=0;
  const review=new VideoReview(work,folder,new RecoveryStore(),async()=>{
    if(++reads===1){entered.resolve();await firstLookup.promise;}
    return {status:"succeeded",data:{media:{media_ref:media}}};
  },()=>true);
  const earlier=review.draft(media,draft("较早输入"));await entered.promise;
  const latest=review.draft(media,clear?null:draft("最后输入"));
  // 让后一个异步核对有机会先返回，再释放原读取；不等待固定毫秒数。
  await new Promise<void>(resolve=>setImmediate(resolve));firstLookup.resolve();
  await Promise.all([earlier,latest]);
  assert.deepEqual(await review.draft(media),clear?null:draft("最后输入"));
});

test("媒体核对失败不阻断后续意见，作品切换后的迟到草稿不能落盘",async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-video-draft-failure-"));
  let fail=true,active=true;
  const review=new VideoReview(work,folder,new RecoveryStore(),async()=>{
    if(fail){fail=false;throw Error("媒体核对暂不可用");}
    return {status:"succeeded",data:{}};
  },()=>active);
  await assert.rejects(review.draft(media,draft("未保存")),/媒体核对暂不可用/);
  await review.draft(media,draft("有效意见"));assert.deepEqual(await review.draft(media),draft("有效意见"));
  const lateLookup=deferred(),started=deferred();
  const late=new VideoReview(work,path.join(folder,"late"),new RecoveryStore(),async()=>{started.resolve();await lateLookup.promise;return {status:"succeeded",data:{}};},()=>active);
  const saving=late.draft(media,draft("不能进入另一作品"));await started.promise;active=false;lateLookup.resolve();
  await assert.rejects(saving,/视频作品已切换/);
  active=true;assert.equal(await late.draft(media),null);
});

test("Core已保存而回执中断，重新打开只沿原键恢复一条意见",async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-video-feedback-recovery-")),store=new RecoveryStore();
  const saved=new Map<string,unknown>();let lost=true;const keys:string[]=[];
  const core=async(action:string,input:any)=>{
    if(action!=="hetu.video.feedback.save")return {status:"succeeded",data:{}};
    keys.push(input.operation_key);
    if(!saved.has(input.operation_key))saved.set(input.operation_key,{feedback:{feedback_id:"feedback_original",comment:input.comment,range:input.range}});
    if(lost){lost=false;throw Error("保存回执中断");}
    return {status:"succeeded",data:saved.get(input.operation_key)};
  };
  let review=new VideoReview(work,folder,store,core,()=>true);
  const input={media_ref:media,comment:"保留原意见",range:{start_tick:200,end_tick:1200}};
  await review.draft(media,draft(input.comment));
  await assert.rejects(review.saveFeedback(input),/保存回执中断/);
  const pending=await review.journal();assert.equal(pending.status,"pending");
  await assert.rejects(review.saveFeedback({...input,comment:"不能另起保存"}),/前次意见尚待恢复/);
  review=new VideoReview(work,folder,store,core,()=>true);
  const restored=await review.recover();assert.equal(restored.status,"succeeded");
  assert.equal(restored.result.feedback.feedback_id,"feedback_original");assert.equal(saved.size,1);
  assert.deepEqual(keys,[pending.input.operation_key,pending.input.operation_key]);
  assert.deepEqual(await review.recover(),restored);assert.equal(keys.length,2);
  await review.draft(media,null);assert.equal(await review.draft(media),null);
});

async function exportFixture() {
  const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-video-export-")),target=path.join(folder,"导出字幕.vtt");
  const fixed=(asset_id:string)=>({asset_id,revision:1,sha256:createHash("sha256").update(asset_id).digest("hex")});
  const zh=fixed("caption-zh"),en=fixed("caption-en"),video=fixed("video");
  const raw=new Map([[zh.asset_id,Buffer.from("\uFEFFWEBVTT\r\n\r\n00:00.100 --> 00:01.000\r\n渡口的灯亮了。🌿\r\n")],[en.asset_id,Buffer.from("WEBVTT\r\n\r\n00:00.100 --> 00:01.000\r\nThe ferry light is on.\r\n")],[video.asset_id,Buffer.alloc(524300,7)]]);
  const blob=(reference:any,media_type:string)=>({sha256:createHash("sha256").update(raw.get(reference.asset_id)!).digest("hex"),size_bytes:raw.get(reference.asset_id)!.length,media_type});
  const preview={manifest_sha256:"original-manifest",items:[{media_ref:media,asset_ref:video,filename:"video.mp4",blob:blob(video,"video/mp4"),caption_files:[{track:{id:"zh",asset_ref:zh},filename:"same-name.vtt",blob:blob(zh,"text/vtt")},{track:{id:"en",asset_ref:en},filename:"same-name.vtt",blob:blob(en,"text/vtt")}]}]};
  let active=true,previews=0,opens=0,closes=0,opened:any;
  let afterChoose:()=>void=()=>{},afterRead:()=>void=()=>{},corrupt:"identity"|"offset"|"bytes"|undefined,final:"rights"|"manifest"|undefined;
  const review=new VideoReview(work,folder,new RecoveryStore(),async(action,input)=>{
    assert.equal(action,"hetu.video.delivery.preview");assert.deepEqual(input,{work_ref:work,media_refs:[media]});previews++;
    if(previews>1&&final==="rights")return {status:"blocked",error:{message:"字幕权利已撤回"}};
    return {status:"succeeded",data:previews>1&&final==="manifest"?{...preview,manifest_sha256:"changed"}:preview};
  },()=>active,async(method,input)=>{
    if(method==="media/open"){
      opens++;opened=input;const bytes=raw.get(input.asset_id)!;
      return {token:"read-only",asset_ref:corrupt==="identity"?{...input,asset_id:"other"}:input,size_bytes:bytes.length,media_type:input.asset_id===video.asset_id?"video/mp4":"text/vtt"};
    }
    if(method==="media/close"){closes++;return {};}
    assert.equal(method,"media/read");assert.equal(input.token,"read-only");const source=raw.get(opened.asset_id)!,bytes=Buffer.from(source.subarray(input.offset,input.offset+input.length));
    if(corrupt==="bytes")bytes[0]^=1;
    afterRead();return {offset:input.offset+(corrupt==="offset"?1:0),size_bytes:bytes.length,base64:bytes.toString("base64")};
  });
  await writeFile(target,"原文件必须保留");
  return {review,folder,target,preview,zh,en,video,raw,choose:async(name:string)=>{assert.equal(name,"same-name.vtt");afterChoose();return target;},state:()=>({previews,opens,closes,opened}),
    set:(value:{corrupt?:typeof corrupt;final?:typeof final;afterChoose?:()=>void;afterRead?:()=>void;active?:boolean})=>{if(value.corrupt)corrupt=value.corrupt;if(value.final)final=value.final;if(value.afterChoose)afterChoose=value.afterChoose;if(value.afterRead)afterRead=value.afterRead;if(value.active!==undefined)active=value.active;}};
}
test("同名双语字幕按固定引用保存原字节，视频共用流式导出且跨512KiB分块保持",async()=>{
  const f=await exportFixture();
  const result=await f.review.exportCaption(media,f.en,f.choose);assert.equal(result.saved,true);assert.deepEqual(result.caption_ref,f.en);
  assert.deepEqual(await readFile(f.target),f.raw.get(f.en.asset_id));assert.equal(f.state().opened.asset_id,f.en.asset_id);assert.equal(f.state().closes,1);
  await f.review.exportCaption(media,f.zh,f.choose);assert.deepEqual(await readFile(f.target),f.raw.get(f.zh.asset_id));
  const videoTarget=path.join(f.folder,"video.mp4");await f.review.exportFile(media,async name=>{assert.equal(name,"video.mp4");return videoTarget;});assert.deepEqual(await readFile(videoTarget),f.raw.get(f.video.asset_id));
  assert.equal(f.state().opens,3);assert.equal(f.state().closes,3);assert.equal((await readdir(f.folder)).some(name=>name.startsWith(".hetu-export-")),false);
});
test("取消、无关联及伪摘要字幕不打开文件流；格式扩展名不符不覆盖旧文件",async()=>{
  const f=await exportFixture();
  assert.deepEqual(await f.review.exportCaption(media,f.zh,async()=>undefined),{saved:false,cancelled:true});
  for(const reference of [{...f.zh,sha256:"wrong"},{...f.zh,asset_id:"foreign"},{...f.zh,revision:2},{...f.zh,work_ref:work}])await assert.rejects(f.review.exportCaption(media,reference,async()=>{throw Error("不应打开选择器");}),/不属于本版视频/);
  await assert.rejects(f.review.exportCaption(media,f.zh,async()=>f.target+".srt"),/vtt扩展名/);
  assert.equal(await readFile(f.target,"utf8"),"原文件必须保留");assert.equal(f.state().opens,0);
});
for(const corrupt of ["identity","offset","bytes"] as const)test(`字幕${corrupt}核验失败，旧目标保持且临时文件与句柄释放`,async()=>{
  const f=await exportFixture();f.set({corrupt});
  await assert.rejects(f.review.exportCaption(media,f.zh,f.choose),/不一致/);
  assert.equal(await readFile(f.target,"utf8"),"原文件必须保留");assert.equal(f.state().closes,1);assert.equal((await readdir(f.folder)).some(name=>name.startsWith(".hetu-export-")),false);
});
for(const final of ["rights","manifest"] as const)test(`字幕保存前${final}发生变化，拒绝替换旧文件`,async()=>{
  const f=await exportFixture();f.set({final});
  await assert.rejects(f.review.exportCaption(media,f.zh,f.choose),final==="rights"?/权利已撤回/:/依据已有变化/);
  assert.equal(await readFile(f.target,"utf8"),"原文件必须保留");assert.equal(f.state().closes,1);assert.equal((await readdir(f.folder)).some(name=>name.startsWith(".hetu-export-")),false);
});
for(const boundary of ["choose","read"] as const)test(`字幕${boundary}期间切换作品，不写入迟到目标`,async()=>{
  const f=await exportFixture(),leave=()=>f.set({active:false});f.set(boundary==="choose"?{afterChoose:leave}:{afterRead:leave});
  await assert.rejects(f.review.exportCaption(media,f.zh,f.choose),/视频作品已切换/);
  assert.equal(await readFile(f.target,"utf8"),"原文件必须保留");assert.equal(f.state().opens,f.state().closes);assert.equal((await readdir(f.folder)).some(name=>name.startsWith(".hetu-export-")),false);
});
test("错误字幕类型、预算及流读取失败均保留旧文件，不以改名代替格式转换",async()=>{
  for(const invalid of ["type","size"]){
    const f=await exportFixture(),blob=f.preview.items[0].caption_files[0].blob;
    if(invalid==="type")blob.media_type="application/json";else blob.size_bytes=1024*1024+1;
    await assert.rejects(f.review.exportCaption(media,f.zh,async()=>{throw Error("不应打开选择器");}),/固定字幕类型或大小不符/);assert.equal(f.state().opens,0);
    assert.equal(await readFile(f.target,"utf8"),"原文件必须保留");
  }
  const f=await exportFixture();f.set({afterRead:()=>{throw Error("字幕文件读取中断");}});
  await assert.rejects(f.review.exportCaption(media,f.zh,f.choose),/读取中断/);assert.equal(await readFile(f.target,"utf8"),"原文件必须保留");assert.equal(f.state().closes,1);assert.equal((await readdir(f.folder)).some(name=>name.startsWith(".hetu-export-")),false);
});

test("媒体决定保存丢回执后只能沿原固定预览与原键恢复，保留实际结果",async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-video-decision-recovery-")),recovery=new RecoveryStore();let active=true,lost=true;
 const writes:any[]=[],saved=new Map<string,any>();
 const preview={request:{work_ref:work,media_ref:media,purpose:"final",decision:"confirmed",expected_decision_ref:null,author_statement:"隔离测试确认本版"},snapshot:{title:"本版样本",media_ref:media},sha256:"preview-fixed"};
 const core=async(action:string,input:any)=>{
  if(action==="hetu.video.decisions.preview")return {status:"succeeded",data:{preview}};
  assert.equal(action,"hetu.video.decisions.save");writes.push(input);
  if(!saved.has(input.operation_key))saved.set(input.operation_key,{decision_ref:{decision_id:"original",revision:1,sha256:"fixed"},decision:{media_ref:media,decision:"confirmed"}});
  if(lost){lost=false;throw Error("决定回执中断");}return {status:"succeeded",data:saved.get(input.operation_key)};
 };
 let current=new VideoReview(work,folder,recovery,core,()=>active);
 const prepared=await current.prepareDecision({media_ref:media,purpose:"final",decision:"confirmed",expected_decision_ref:null,author_statement:"隔离测试确认本版"});
 assert.equal(writes.length,0);await assert.rejects(current.saveDecision(prepared.token),/回执中断/);
 assert.equal((await current.decisionJournal()).status,"pending");
 await assert.rejects(current.prepareDecision({media_ref:media,purpose:"final",decision:"confirmed",expected_decision_ref:null,author_statement:"不能重做"}),/恢复原决定/);
 await assert.rejects(current.saveDecision(prepared.token),/恢复原决定/);
 current=new VideoReview(work,folder,recovery,core,()=>active);
 const done=await current.recoverDecision();assert.equal(done.status,"succeeded");assert.equal(done.result.decision_ref.decision_id,"original");assert.equal(saved.size,1);assert.deepEqual(writes[0],writes[1]);
 assert.deepEqual(await current.recoverDecision(),done);assert.equal(writes.length,2);
 await assert.rejects(current.acknowledgeDecision({operation_key:"other",decision_ref:done.result.decision_ref}),/回读原视频决定/);
 const acknowledged=await current.acknowledgeDecision({operation_key:done.input.operation_key,decision_ref:done.result.decision_ref});assert.equal(acknowledged.acknowledged,true);assert.equal(writes.length,2);
 active=false;await assert.rejects(current.recoverDecision(),/视频作品已切换/);
});
test("媒体决定CAS明确失败保留原输入但允许重新核对，作品切换后的预览不能落盘",async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-video-decision-conflict-"));let active=true,fail=true;
 const core=async(action:string)=>action.endsWith("preview")?{status:"succeeded",data:{preview:{request:{media_ref:media},snapshot:{title:"旧版"},sha256:"fixed"}}}:fail?{status:"blocked",error:{code:"revision_conflict",message:"已有另一个决定"}}:{status:"succeeded",data:{decision_ref:{revision:2}}};
 const current=new VideoReview(work,folder,new RecoveryStore(),core,()=>active);
 const prepared=await current.prepareDecision({media_ref:media,purpose:"final",decision:"confirmed",expected_decision_ref:null,author_statement:"固定本版"});
 await assert.rejects(current.saveDecision(prepared.token),/另一个决定/);assert.equal((await current.decisionJournal()).status,"blocked");
 fail=false;const next=await current.prepareDecision({media_ref:media,purpose:"final",decision:"confirmed",expected_decision_ref:null,author_statement:"重新核对"});active=false;
 await assert.rejects(current.saveDecision(next.token),/视频作品已切换/);active=true;assert.equal((await current.decisionJournal()).status,"blocked");
});
