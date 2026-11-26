import {test,expect} from "@playwright/test";
import {feedbackTextSelection} from "../src/feedback-target.ts";

test("跨页原句的UTF-8选区加上原页偏移，不按显示字符计数",()=>{
 const content="开篇🌿\r\n来信保留。",start=Buffer.byteLength("开篇🌿\r\n"),base={kind:"context" as const,context_ref:{context_id:"context_0",sha256:"a".repeat(64)}};
 expect(feedbackTextSelection(base,content,{byte_start:start,byte_end:start+6,quote:"来信"},8192)).toEqual({...base,range:{byte_start:8192+start,byte_end:8192+start+6,quote:"来信"}});
 expect(base).not.toHaveProperty("range");
});
test("空、错原句、非UTF-8边界及超预算选区不构造可保存引用",()=>{
 const base={kind:"candidate" as const,candidate_ref:{candidate_id:"one"}};
 for(const selection of [{byte_start:0,byte_end:0,quote:""},{byte_start:0,byte_end:3,quote:"错"},{byte_start:1,byte_end:4,quote:"🌿"},{byte_start:0,byte_end:99,quote:"越界"}])expect(()=>feedbackTextSelection(base,"🌿来信",selection)).toThrow();
 const large="字".repeat(6000);expect(()=>feedbackTextSelection(base,large,{byte_start:0,byte_end:Buffer.byteLength(large),quote:large})).toThrow(/缩小范围/);
 expect(()=>feedbackTextSelection(base,"来信",{byte_start:0,byte_end:6,quote:"来信"},Number.MAX_SAFE_INTEGER)).toThrow();
});
