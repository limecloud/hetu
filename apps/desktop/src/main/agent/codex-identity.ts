import {createHash,randomUUID} from "node:crypto";
import type {CodexAuthentication} from "../../agent-session-contract.ts";

export type CodexIdentityBinding={schema_version:1;salt:string;home_sha256:string;provider_sha256:string;account_sha256:string};
type Request=(method:string,params:unknown)=>Promise<any>;
export class CodexIdentityError extends Error{
 readonly authentication:CodexAuthentication;
 constructor(authentication:CodexAuthentication,message:string){super(message);this.authentication=authentication;}
}
const unavailable=()=>new CodexIdentityError({state:"unavailable"},"无法核对 Codex 登录与渠道状态。请检查原配置后重新连接，原线程和草稿已保留。");
const hash=(salt:string,value:unknown)=>createHash("sha256").update(salt+"\n"+JSON.stringify(value)).digest("hex");
export function validIdentityBinding(value:unknown):value is CodexIdentityBinding{
 const item=value as CodexIdentityBinding;
 return !!item&&Object.keys(item).every(key=>["schema_version","salt","home_sha256","provider_sha256","account_sha256"].includes(key))&&item.schema_version===1&&typeof item.salt==="string"&&/^[a-f0-9-]{36}$/.test(item.salt)&&[item.home_sha256,item.provider_sha256,item.account_sha256].every(value=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value));
}
function endpoint(value:unknown){
 if(value===undefined||value===null)return null;
 if(typeof value!=="string")throw unavailable();
 try{const url=new URL(value);return url.origin+url.pathname;}catch{throw unavailable();}
}
/** 仅投影公开身份和渠道路由；不复制账号对象、配置、环境或凭据。 */
export async function verifyCodexIdentity(request:Request,home:string,previous?:CodexIdentityBinding):Promise<{binding:CodexIdentityBinding;authentication:CodexAuthentication}>{
 let account:any,configuration:any;
 try{account=await request("account/read",{refreshToken:false});configuration=await request("config/read",{includeLayers:false});}catch{throw unavailable();}
 if(typeof account?.requiresOpenaiAuth!=="boolean"||!configuration?.config||typeof configuration.config!=="object")throw unavailable();
 if(account.account===null&&account.requiresOpenaiAuth)throw new CodexIdentityError({state:"required"},"请先登录 Codex。原会话和草稿已保留。");
 const identity=account.account;
 if(identity!==null&&(!identity||!["apiKey","chatgpt","amazonBedrock","gcp"].includes(identity.type)))throw unavailable();
 const provider=configuration.config.model_provider??"openai";
 if(typeof provider!=="string")throw unavailable();
 const settings=configuration.config.model_providers?.[provider]??{};
 const mode=identity?.type??"provider",salt=previous?.salt??randomUUID();
 const workspace=account.workspaceRouting?.chatgptAccountId??identity?.workspaceName??null;
 const accountProjection=typeof account.userId==="string"?[mode,"user",account.userId,workspace]:mode==="chatgpt"?[mode,"profile",identity.email??null,workspace]:[mode];
 const binding:CodexIdentityBinding={schema_version:1,salt,home_sha256:hash(salt,home),provider_sha256:hash(salt,[provider,endpoint(settings.base_url),settings.wire_api??null,settings.requires_openai_auth??null,settings.project_id??null,settings.location??null]),account_sha256:hash(salt,accountProjection)};
 if(previous&&["home_sha256","provider_sha256","account_sha256"].some(key=>previous[key as keyof CodexIdentityBinding]!==binding[key as keyof CodexIdentityBinding]))throw new CodexIdentityError({state:"changed",mode},"Codex 账号或渠道配置已变化。请恢复原配置后重新连接，或新建会话；原线程和草稿已保留。");
 return {binding,authentication:{state:"ready",mode}};
}
