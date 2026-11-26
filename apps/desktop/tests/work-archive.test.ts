import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {archiveWork} from "../src/main/work-archive.ts";
import {AppServer} from "../src/main/rpc.ts";
import {fixtureBinary,machineBinary} from "./acceptance-paths.ts";

test("共享归档核对三类作品身份、取消零写与确认期间CAS冲突，同根正文及兄弟保持",async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),"hetu-archive-domain-")),workspace=path.join(folder,"work");
  const fixture=spawnSync(fixtureBinary("baseline_fixture"),[workspace,path.join(folder,"collaboration")],{encoding:"utf8"});
  assert.equal(fixture.status,0,fixture.error?.message??fixture.stderr);const refs=JSON.parse(fixture.stdout);
  const core=await AppServer.open(machineBinary("hetu-app-server"),workspace),other=await AppServer.open(machineBinary("hetu-app-server"),workspace);
  const call=async(action:string,input:any)=>{const result=await core.request("workspace/request",{action,input,contract_revision:"1"});assert.equal(result.status,"succeeded",JSON.stringify(result));return result.data;};
  const read=(work_ref:any)=>call("hetu.works.get",{work_ref});
  try {
    const document=await call("hetu.documents.get",{document_id:refs.document.document.document_id});
    for(const kind of ["novel","drama","video"] as const){
      const work=refs[kind],before=await read(work),siblings=await Promise.all(["novel","drama","video"].filter(value=>value!==kind).map(value=>read(refs[value])));
      assert.equal(await archiveWork(core,work,true,async()=>false),false);assert.deepEqual(await read(work),before);
      assert.equal(await archiveWork(core,work,true,async()=>true),true);assert.equal((await read(work)).summary.archived,true);
      assert.equal(await archiveWork(core,work,false,async()=>true),true);const restored=await read(work);assert.equal(restored.summary.archived,false);
      // 对比完整业务资料；归档字段和不可变修订链的元数据单独核对。
      const stable=(record:any)=>{const {revision,updated_at,previous_sha256,archived,...value}=record;return value;};
      assert.equal(restored.record.revision,before.record.revision+2);
      assert.deepEqual(stable(restored.record),stable(before.record));
      assert.deepEqual(await Promise.all(["novel","drama","video"].filter(value=>value!==kind).map(value=>read(refs[value]))),siblings);
      const snapshot=await read(work);
      await assert.rejects(archiveWork(core,work,true,async()=>{
        assert.equal(await archiveWork(other,work,true,async()=>true),true);return true;
      }),{code:"revision_conflict"});
      const concurrent=await read(work);assert.equal(concurrent.summary.fixed_ref.revision_ref.revision,snapshot.summary.fixed_ref.revision_ref.revision+1);
      assert.equal(concurrent.summary.archived,true);await archiveWork(core,work,false,async()=>true);
    }
    let confirmed=false;
    await assert.rejects(archiveWork(core,{...refs.novel,workspace_id:"workspace_00000000-0000-4000-8000-000000000001"},true,async()=>{confirmed=true;return true;}));
    assert.equal(confirmed,false);
    assert.deepEqual(await call("hetu.documents.get",{document_id:document.document.document_id}),document);
  } finally {await other.close();await core.close();}
});
