import test from "node:test";
import assert from "node:assert/strict";
import {verifyCodexIdentity,CodexIdentityError,validIdentityBinding} from "../src/main/agent/codex-identity.ts";

const config={config:{model_provider:"gateway",model_providers:{gateway:{base_url:"https://gateway.test/v1?key=private-query",wire_api:"responses",requires_openai_auth:false,experimental_bearer_token:"private-key",http_headers:{Authorization:"private-header"}}}}};
const provider={account:null,requiresOpenaiAuth:false};
const reader=(account:any=provider,configuration:any=config)=>async(method:string)=>method==="account/read"?account:configuration;
const rejected=(state:string)=>(error:unknown)=>error instanceof CodexIdentityError&&error.authentication.state===state;

test("独立渠道无OpenAI账号仍可接入，记录只含随机盐及摘要",async()=>{
 const first=await verifyCodexIdentity(reader(),"/private/codex-home");assert.deepEqual(first.authentication,{state:"ready",mode:"provider"});assert(validIdentityBinding(first.binding));
 assert.doesNotMatch(JSON.stringify(first),/private-query|private-key|private-header|gateway.test|codex-home/);
 assert.deepEqual(await verifyCodexIdentity(reader(),"/private/codex-home",first.binding),first);
 const second=await verifyCodexIdentity(reader(),"/private/codex-home");assert.notEqual(first.binding.salt,second.binding.salt);assert.notEqual(first.binding.provider_sha256,second.binding.provider_sha256);
});
test("读取失败、非法响应及必需登录分别阻止恢复，不泄漏原错误或凭据",async()=>{
 await assert.rejects(verifyCodexIdentity(async()=>{throw Error("private-token");},"home"),error=>rejected("unavailable")(error)&&!String(error).includes("private-token"));
 for(const account of [{},{requiresOpenaiAuth:false},{account:{},requiresOpenaiAuth:false}])await assert.rejects(verifyCodexIdentity(reader(account),"home"),rejected("unavailable"));
 await assert.rejects(verifyCodexIdentity(reader({account:null,requiresOpenaiAuth:true}),"home"),rejected("required"));
});
test("账号稳定ID、渠道与配置目录分别核对，订阅变化和密钥轮换不改变公开身份",async()=>{
 const account={account:{type:"chatgpt",email:"qa@test.invalid",planType:"plus",workspaceName:"QA"},userId:"user-first",requiresOpenaiAuth:true};
 const original=await verifyCodexIdentity(reader(account),"home");assert.doesNotMatch(JSON.stringify(original),/qa@test|user-first|QA/);
 await verifyCodexIdentity(reader({...account,account:{...account.account,planType:"pro"}}),"home",original.binding);
 await assert.rejects(verifyCodexIdentity(reader({...account,userId:"user-second"}),"home",original.binding),rejected("changed"));
 await assert.rejects(verifyCodexIdentity(reader(account),"other-home",original.binding),rejected("changed"));
 await assert.rejects(verifyCodexIdentity(reader(account,{config:{...config.config,model_provider:"other"}}),"home",original.binding),rejected("changed"));
 const rotated=structuredClone(config);rotated.config.model_providers.gateway.experimental_bearer_token="rotated-private-key";
 await verifyCodexIdentity(reader(account,rotated),"home",original.binding);
});
test("旧协议无稳定ID时只核对可见账号投影，不将显示邮箱写入记录",async()=>{
 const account={account:{type:"chatgpt",email:"first@test.invalid",workspaceName:"original"},requiresOpenaiAuth:true};
 const original=await verifyCodexIdentity(reader(account),"home");
 await assert.rejects(verifyCodexIdentity(reader({...account,account:{...account.account,email:"changed@test.invalid"}}),"home",original.binding),rejected("changed"));
 assert.doesNotMatch(JSON.stringify(original.binding),/test.invalid|original/);assert(!validIdentityBinding({...original.binding,home_sha256:"bad"}));
});
