import {spawnSync} from "node:child_process";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {AppServer} from "../../src/main/rpc.ts";

const [base,binary,fixtureBinary,sourceDigest]=process.argv.slice(2);
if(!base||!binary||!fixtureBinary||![base,binary,fixtureBinary].every(path.isAbsolute)||sourceDigest&&!/^[a-f0-9]{64}$/.test(sourceDigest))throw Error("用法：node --experimental-strip-types tests/fixtures/project-scale.mjs <绝对输出目录> <AppServer路径> <baseline_fixture路径> [源码摘要]");
await mkdir(base,{recursive:true});
const folder=await mkdtemp(path.join(base,"scale-novel-"));
const workspace=path.join(folder,"千章作品"),profile=path.join(folder,"profile"),collaboration=path.join(folder,"collaboration");
const fixture=spawnSync(fixtureBinary,[workspace,collaboration],{encoding:"utf8"});
if(fixture.status!==0)throw Error(fixture.stderr);
const refs=JSON.parse(fixture.stdout);
const core=await AppServer.open(binary,workspace,path.join(profile,"git-authorizations"));
const pattern="海风沿着长街吹向港口江岚把旧日记放回书袋看见灯塔在远处亮起每封信都有自己的来处";
const paragraph=pattern.repeat(10).slice(0,200),content=Array.from({length:50},()=>paragraph).join("\n\n");
const start=performance.now(),documents=[];
const call=async(action,input)=>{const result=await core.request("workspace/request",{action:"hetu."+action,contract_revision:"1",input});if(result.status!=="succeeded")throw Error(JSON.stringify(result));return result.data;};
try{
 const first=await call("documents.save",{document_id:refs.document.document.document_id,base_revision_id:refs.document.revision.revision_id,content,source_format:"markdown",operation_key:"scale-first"});documents.push(first.document.document_id);
 for(let i=2;i<=1000;i++){
  const value=await call("documents.create",{kind:"novel_chapter",title:`第${String(i).padStart(4,"0")}章 海港来信`,source_format:"markdown",content,operation_key:`scale-chapter-${i}`});
  documents.push(value.document.document_id);if(i%100===0)console.log(JSON.stringify({chapters:i,elapsed_ms:Math.round(performance.now()-start)}));
 }
 const novel=await call("novels.get",{});if(novel.novel.chapters.length!==1000)throw Error("目录数量不符");
 await mkdir(profile);await writeFile(path.join(profile,"creative-library.json"),JSON.stringify({schema_version:1,roots:[{path:workspace,workspace_id:refs.novel.workspace_id,works:[{work_ref:refs.novel,title:"千章性能样本"}]}]}));
 const state={folder,workspace,profile,collaboration,work_ref:refs.novel,documents,chapters:1000,han_characters:10000000,chapter_utf8_bytes:Buffer.byteLength(content),content,seed_elapsed_ms:performance.now()-start,installed_source_sha256:sourceDigest??null};
 await writeFile(path.join(folder,"fixture.json"),JSON.stringify(state,null,2));console.log(JSON.stringify({seeded:true,chapters:state.chapters,han_characters:state.han_characters,folder,fixture:path.join(folder,"fixture.json"),elapsed_ms:state.seed_elapsed_ms}));
}finally{await core.close();}
