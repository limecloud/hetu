import {test,expect} from "@playwright/test";
import {acceptTextSourcePage,nextTextSourceRange,previousTextSourceRange,type TextSourcePage,type SourceRange} from "../src/source-text.ts";

const text="甲🌿乙\r\n丙",bytes=new TextEncoder().encode(text),source={context_ref:{context_id:"context_0",sha256:"a".repeat(64)},fixed_ref:{kind:"document",document_id:"original",revision_id:"fixed"},sha256:"a".repeat(64),size_bytes:bytes.length};
function page(start:number,end:number,requestedEnd=bytes.length):TextSourcePage{
 const content=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(start,end));
 return {...source,content,range:{byte_start:start,byte_end:end},complete:end===requestedEnd,next_range:end<requestedEnd?{byte_start:end,byte_end:requestedEnd}:null,source_ref:{document_id:"original",revision_id:"fixed",byte_start:start,byte_end:end,quote:content}};
}

test("固定原文按成功UTF-8范围累计覆盖，重读和前后页不重复计数",()=>{
 const first=acceptTextSourcePage(undefined,source,page(0,7));expect(first.loaded_bytes).toBe(7);expect(first.complete).toBe(false);expect(first.page_index).toBe(0);expect(previousTextSourceRange(first)).toBeUndefined();expect(nextTextSourceRange(first)).toEqual({byte_start:7,byte_end:15});
 const second=acceptTextSourcePage(first,source,page(7,12),nextTextSourceRange(first));expect(second.loaded_bytes).toBe(12);expect(second.page_index).toBe(1);expect(previousTextSourceRange(second)).toEqual({byte_start:0,byte_end:7});
 const back=acceptTextSourcePage(second,source,page(0,7,7),previousTextSourceRange(second));expect(back.loaded_bytes).toBe(12);expect(back.percentage).toBe(second.percentage);expect(nextTextSourceRange(back)).toEqual({byte_start:7,byte_end:12});expect(back.page_index).toBe(0);
 expect(second.pages).toHaveLength(2);expect(first.loaded_ranges).toEqual([{byte_start:0,byte_end:7}]);
 const reread=acceptTextSourcePage(back,source,page(7,12,12),nextTextSourceRange(back)),last=acceptTextSourcePage(reread,source,page(12,15),nextTextSourceRange(reread));
 expect(last.loaded_bytes).toBe(15);expect(last.complete).toBe(true);expect(last.percentage).toBe(100);expect(nextTextSourceRange(last)).toBeUndefined();expect(last.pages).toHaveLength(3);
});

test("最后一页及局部读取完成不代表整份原文已载入，空原文可准确完成",()=>{
 const last=acceptTextSourcePage(undefined,source,page(12,15),{byte_start:12,byte_end:15});expect(last.page.complete).toBe(true);expect(last.complete).toBe(false);expect(last.loaded_bytes).toBe(3);
 const local=acceptTextSourcePage(undefined,source,page(0,7,7),{byte_start:0,byte_end:7});expect(local.complete).toBe(false);
 const emptySource={...source,size_bytes:0},empty={...page(0,0,0),size_bytes:0};expect(acceptTextSourcePage(undefined,emptySource,empty).complete).toBe(true);
});

test("错误来源、摘要、分页及引句不推进已有位置和覆盖",()=>{
 const before=acceptTextSourcePage(undefined,source,page(0,7)),snapshot=structuredClone(before),request:SourceRange={byte_start:7,byte_end:15};
 for(const changed of [
  {...page(7,12),context_ref:{...source.context_ref,context_id:"context_1"}},
  {...page(7,12),fixed_ref:{...source.fixed_ref,revision_id:"new"}},
  {...page(7,12),sha256:"b".repeat(64)},
  {...page(7,12),size_bytes:16},
  {...page(7,12),range:{byte_start:8,byte_end:12}},
  {...page(7,12),content:"截断或替换🌿"},
  {...page(7,12),complete:true},
  {...page(7,12),next_range:{byte_start:7,byte_end:15}},
  {...page(7,12),source_ref:{...page(7,12).source_ref,quote:"其他引句"}},
  {...page(7,12),content:"",range:{byte_start:7,byte_end:7},source_ref:{byte_start:7,byte_end:7,quote:""},next_range:{byte_start:7,byte_end:15}},
 ])expect(()=>acceptTextSourcePage(before,source,changed,request)).toThrow(/来源或分页/);
 expect(before).toEqual(snapshot);
 expect(()=>acceptTextSourcePage(before,{...source,fixed_ref:{...source.fixed_ref,revision_id:"other"}},page(7,12),request)).toThrow();
});

test("同一固定引用忽略字段顺序，缺口不会因重复或重叠片段被计为全文",()=>{
 const reordered={...page(0,7),fixed_ref:{revision_id:"fixed",document_id:"original",kind:"document"}};
 const first=acceptTextSourcePage(undefined,source,reordered),gap=acceptTextSourcePage(first,source,page(12,15),{byte_start:12,byte_end:15});
 expect(gap.complete).toBe(false);expect(gap.loaded_bytes).toBe(10);
 const repeated=acceptTextSourcePage(gap,source,page(0,7,7),{byte_start:0,byte_end:7});expect(repeated.loaded_bytes).toBe(10);expect(repeated.pages).toHaveLength(2);
 const filled=acceptTextSourcePage(repeated,source,page(7,12,12),{byte_start:7,byte_end:12});expect(filled.complete).toBe(true);
});
