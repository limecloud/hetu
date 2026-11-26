import {test,expect} from "@playwright/test";
import {readSourceEntity,readSourceProfessional,type ProfessionalProjection} from "../src/source-json.ts";

const header={entity_sha256:"a".repeat(64),context_ref:{context_id:"fixed",sha256:"b".repeat(64)}};
const root=()=>({...header,entity_page:{result_path:"",summary:{kind:"object",size_bytes:80},fields:[{name:"description",result_path:"/description"}]}});
const text=(content:string,start:number,end:number,complete:boolean)=>({...header,entity_page:{result_path:"/description",summary:{kind:"string",size_bytes:12},page:{content,sha256:"c".repeat(64),size_bytes:7,range:{byte_start:start,byte_end:end},complete,next_range:complete?null:{byte_start:end}}}});

test("固定实体的UTF-8字段重组保留Emoji，换摘要、错范围或重复分页均拒绝",async()=>{
 const read=async(path:string,offset:number)=>path===""?root():offset===0?text("江",0,3,false):text("🌿",3,7,true);
 expect((await readSourceEntity(read)).entity).toEqual({description:"江🌿"});
 await expect(readSourceEntity(async(path,offset)=>{const result=await read(path,offset);return offset>0?{...result,entity_sha256:"d".repeat(64)}:result;})).rejects.toThrow("身份已变化");
 await expect(readSourceEntity(async(path,offset)=>path&&offset>0?text("🌿",4,8,true):read(path,offset))).rejects.toThrow("分页不完整");
 await expect(readSourceEntity(async(path,offset)=>path?{...text("江",0,3,false),entity_page:{...text("江",0,3,false).entity_page,result_path:"/other"}}:root())).rejects.toThrow("分页不完整");
});

test("固定数组的过大成员沿原路径展开，不接受不前进的目录或遗漏成员",async()=>{
 const record={...header,entity_page:{result_path:"",summary:{kind:"object",size_bytes:100},fields:[{name:"facts",result_path:"/facts"}]}};
 const array=(offset:number)=>({...header,entity_page:offset===0?{result_path:"/facts",summary:{kind:"array",size_bytes:80,items:2},next_path:"/facts/0"}:{result_path:"/facts",summary:{kind:"array",size_bytes:80,items:2},items:[{predicate:"age",value:24}],next_offset:null}});
 const read=async(path:string,offset:number):Promise<any>=>path===""?record:path==="/facts"?array(offset):{...header,entity_page:{result_path:"/facts/0",summary:{kind:"object",size_bytes:40},value:{predicate:"identity",value:"守塔人"}}};
 expect((await readSourceEntity(read)).entity.facts).toEqual([{predicate:"identity",value:"守塔人"},{predicate:"age",value:24}]);
 await expect(readSourceEntity(async(path,offset)=>path==="/facts"?{...array(1),entity_page:{...array(1).entity_page,items:[],next_offset:0}}:read(path,offset))).rejects.toThrow("分页不完整");
 await expect(readSourceEntity(async(path,offset)=>path==="/facts"&&offset>0?{...array(1),entity_page:{...array(1).entity_page,items:[]}}:read(path,offset))).rejects.toThrow("分页不完整");
});

test("专业投影逐页核对原任务、Owner、作品、修订与摘要，未知字段完整保留",async()=>{
 const fixed={context_ref:{context_id:"context_0",sha256:"a".repeat(64)},fixed_ref:{kind:"plugin_object",work_ref:{workspace_id:"workspace_1",kind:"novel",object_id:"novel_1"},owner_plugin_id:"org.hetu.notes",object_id:"ext_1",revision:1,sha256:"a".repeat(64)},sha256:"a".repeat(64)};
 const read=async(path:string,offset:number):Promise<ProfessionalProjection>=>({...fixed,source_kind:"plugin",page:path===""?{result_path:"",summary:{kind:"object",size_bytes:80},fields:[{name:"未知/字段~",result_path:"/未知~1字段~0"},{name:"__proto__",result_path:"/__proto__"}]}:path==="/__proto__"?{result_path:path,summary:{kind:"object",size_bytes:20},value:{preserved:true}}:{...text(offset===0?"江":"🌿",offset,offset===0?3:7,offset!==0).entity_page,result_path:path}});
 const result=await readSourceProfessional(read,fixed);
 expect(result.professional).toEqual({"未知/字段~":"江🌿",["__proto__"]:{preserved:true}});expect(Object.getPrototypeOf(result.professional)).toBeNull();
 for(const changed of [{sha256:"b".repeat(64)},{context_ref:{...fixed.context_ref,context_id:"context_1"}},{fixed_ref:{...fixed.fixed_ref,revision:2}},{fixed_ref:{...fixed.fixed_ref,owner_plugin_id:"org.hetu.other"}},{fixed_ref:{...fixed.fixed_ref,work_ref:{...fixed.fixed_ref.work_ref,object_id:"novel_2"}}}]){
  await expect(readSourceProfessional(async(path,offset)=>({...await read(path,offset),...(path?changed:{})}),fixed)).rejects.toThrow("身份已变化");
 }
});
