import test from "node:test";
import assert from "node:assert/strict";
import {elicitationContent,validateServerAnswer} from "../src/agent-request.ts";
import type {AgentRequest} from "../src/agent-session-contract.ts";
const request=(method:string,params:any):AgentRequest=>({id:1,method,params,generation:1});

test("MCP表单保留未勾选布尔值，验证必填、枚举和数字范围",()=>{
 const schema={type:"object",required:["confirmed","count","choice"],properties:{confirmed:{type:"boolean"},count:{type:"integer",minimum:1,maximum:3},choice:{type:"string",enum:["one","two"]},note:{type:"string"}}};
 const form=request("mcpServer/elicitation/request",{mode:"form",requestedSchema:schema});
 const content=elicitationContent(schema,{count:2,choice:"two",note:""});
 assert.deepEqual(content,{confirmed:false,count:2,choice:"two"});
 assert.doesNotThrow(()=>validateServerAnswer(form,{action:"accept",content}));
 for(const bad of [{...content,count:4},{...content,count:1.5},{...content,choice:"other"},{...content,unknown:"x"},{count:2,choice:"one"}])assert.throws(()=>validateServerAnswer(form,{action:"accept",content:bad}));
 assert.throws(()=>validateServerAnswer(form,{action:"cancel",content}));
 assert.doesNotThrow(()=>validateServerAnswer(form,{action:"cancel"}));
});
test("权限答复与字段顺序无关，拒绝扩权及新字段",()=>{
 const permissions=request("item/permissions/requestApproval",{permissions:{fileSystem:{read:["a"],write:["b"]}}});
 assert.doesNotThrow(()=>validateServerAnswer(permissions,{permissions:{fileSystem:{write:["b"],read:["a"]}},scope:"turn"}));
 assert.doesNotThrow(()=>validateServerAnswer(permissions,{permissions:{},scope:"turn"}));
 assert.throws(()=>validateServerAnswer(permissions,{permissions:{fileSystem:{read:["a"],write:["b","c"]}},scope:"turn"}));
 assert.throws(()=>validateServerAnswer(permissions,{permissions:{network:{}},scope:"session"}));
});
test("审批和问题必须属于当前请求，未知验证方式不能伪造表单接受",()=>{
 assert.throws(()=>validateServerAnswer(request("item/commandExecution/requestApproval",{availableDecisions:["decline"]}),{decision:"accept"}));
 const question=request("item/tool/requestUserInput",{questions:[{id:"q",options:[{label:"A"}]}]});
 assert.throws(()=>validateServerAnswer(question,{answers:{other:{answers:["A"]}}}));
 assert.throws(()=>validateServerAnswer(question,{answers:{q:{answers:["B"]}}}));
 assert.doesNotThrow(()=>validateServerAnswer(question,{answers:{}}));
 assert.throws(()=>validateServerAnswer(request("mcpServer/elicitation/request",{mode:"openai/userVerification"}),{action:"accept",content:{}}));
 assert.doesNotThrow(()=>validateServerAnswer(request("unknown",{}),{unsupported:true}));
});
