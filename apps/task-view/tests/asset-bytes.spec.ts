import {test, expect} from "@playwright/test";
import {createHash} from "node:crypto";
import {readFixedAssetBytes} from "../../../packages/workbench-ui/src/asset-bytes.ts";

function source(change: (action: string, value: any) => any = (_action,value) => value) {
  const bytes=Buffer.from("WEBVTT\n\n"+"隔离字幕🌿".repeat(2000));
  const sha=createHash("sha256").update(bytes).digest("hex"), ref={asset_id:"fixed",revision:1,sha256:"a".repeat(64)};
  const asset={blob:{size_bytes:bytes.length,media_type:"text/vtt",sha256:sha}};
  const calls:string[]=[];
  const read=async(action:string,input:any)=>{
    calls.push(action);
    if(action==="hetu.assets.get")return change(action,{asset,sha256:ref.sha256});
    const chunk=bytes.subarray(input.offset,input.offset+input.length),next=input.offset+chunk.length;
    return change(action,{asset_ref:ref,offset:input.offset,total_bytes:bytes.length,blob_sha256:sha,base64:chunk.toString("base64"),size_bytes:chunk.length,next_offset:next<bytes.length?next:null});
  };
  return {bytes,ref,asset,read,calls};
}

test("固定资产分块重组与完整摘要核对，结束前重新核验原权限",async()=>{
  const s=source();expect(Buffer.from(await readFixedAssetBytes(s.asset,s.ref,s.read,()=>true,1048576))).toEqual(s.bytes);
  expect(s.calls.filter(a=>a==="hetu.assets.read_blob").length).toBeGreaterThan(1);
  expect(s.calls.at(-1)).toBe("hetu.assets.get");
});

test("错误版本、缺段、篡改字节、过量及读取后撤权都不返回可显示文件",async()=>{
  for(const change of [
    (a:string,v:any)=>a.endsWith("read_blob")?{...v,asset_ref:{...v.asset_ref,revision:2}}:v,
    (a:string,v:any)=>a.endsWith("read_blob")?{...v,next_offset:0}:v,
    (a:string,v:any)=>a.endsWith("read_blob")?{...v,base64:Buffer.alloc(v.size_bytes).toString("base64")}:v,
    (a:string,v:any)=>a.endsWith("get")?{...v,sha256:"b".repeat(64)}:v,
  ]) {
    const s=source(change);await expect(readFixedAssetBytes(s.asset,s.ref,s.read,()=>true,1048576)).rejects.toThrow();
  }
  const s=source();await expect(readFixedAssetBytes(s.asset,s.ref,s.read,()=>true,10)).rejects.toThrow(/预算/);
  await expect(readFixedAssetBytes(s.asset,s.ref,async(a,i)=>{if(a.endsWith("get"))throw Error("撤权");return s.read(a,i);},()=>true,1048576)).rejects.toThrow("撤权");
});

test("关闭时的迟到响应停止继续分页，不复活预览",async()=>{
  const s=source();let active=true;
  await expect(readFixedAssetBytes(s.asset,s.ref,async(a,i)=>{const value=await s.read(a,i);active=false;return value;},()=>active,1048576)).rejects.toThrow(/结束/);
  expect(s.calls).toHaveLength(1);
});
