import path from "node:path";
import {homedir} from "node:os";
import {randomUUID} from "node:crypto";
import {mkdir,writeFile,readFile,readdir,lstat,stat,symlink,link} from "node:fs/promises";
import {compareExternalVersions} from "../../shared/external-installation.ts";

export type AcpLaunchPreparation={args:string[];sessionMetadata?(initialized:any,resume:boolean):Record<string,unknown>|undefined;clientMetadata?:Record<string,unknown>};
const files=new Map([
 ["codebuddy","CODEBUDDY.local.md"],["qwen-code","QWEN.md"],["goose",".goosehints"],
 ["hermes",".hermes.md"],["kimi",".kimi-code/AGENTS.md"],["cline",".cline/rules/hetu.md"],["devin","AGENTS.local.md"],
]);

function inlineInstructions(env:NodeJS.ProcessEnv,variable:string,file:string){
 let prior:Record<string,unknown>={};
 if(env[variable]){try{prior=JSON.parse(env[variable]);}catch{throw Error("提供方会话配置不是有效JSON，已保留用户配置且未启动。");}}
 if(!prior||typeof prior!=="object"||Array.isArray(prior)||prior.instructions!==undefined&&(!Array.isArray(prior.instructions)||prior.instructions.some(value=>typeof value!=="string")||prior.instructions.length>128))throw Error("提供方原有说明目录无效，未覆盖用户配置。");
 env[variable]=JSON.stringify({...prior,instructions:[...(prior.instructions as string[]??[]),file]});
}

/** 只在本标签私有目录交付规则；不同CLI的实际读取入口独立于ACP传输。 */
export async function prepareAcpLaunch(input:{providerId:string;directory:string;instructions:string;env:NodeJS.ProcessEnv;version?:string}):Promise<AcpLaunchPreparation>{
 const {providerId:id,directory,instructions,env,version}=input,args:string[]=[],file=path.join(directory,"AGENTS.md");
 const write=async(name:string,content=instructions)=>{const target=path.join(directory,name);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,content,{mode:0o600});return target;};
 const contextFile=files.get(id);if(contextFile)await write(contextFile);
 if(id==="omp"||id==="aug")args.push("--append-system-prompt="+file);
 if(id==="droid")args.push("--append-system-prompt-file",file);
 if(id==="cursor")await write(".cursor/rules/hetu.mdc","---\ndescription: 河图固定作品范围\nalwaysApply: true\n---\n"+instructions);
 if(id==="copilot"){
   const folder=path.join(directory,".hetu-copilot-instructions");
   if(folder.includes(","))throw Error("Copilot说明目录不能包含逗号，本次未启动提供方会话。");
   await write(".hetu-copilot-instructions/.github/instructions/hetu.instructions.md",'---\napplyTo: "**"\n---\n'+instructions);
   env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS=[env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS?.trim(),folder].filter(Boolean).join(",");
 }
 if(id==="kilo"){env.KILO_ENABLE_QUESTION_TOOL="false";inlineInstructions(env,"KILO_CONFIG_CONTENT",file);}
 if(id==="mimo-code"){env.MIMOCODE_ENABLE_QUESTION_TOOL="false";inlineInstructions(env,"MIMOCODE_CONFIG_CONTENT",file);}
 if(id==="droid"){env.DROID_DISABLE_AUTO_UPDATE="true";env.FACTORY_DROID_AUTO_UPDATE_ENABLED="false";}
 if(id==="cline")env.CLINE_SESSION_BACKEND_MODE="local";
 if(id==="opencode"||id==="opencode2"){
   if(version&&compareExternalVersions(version,"2.0.0")>=0){
     const source=path.resolve(env.OPENCODE_CONFIG_DIR?.trim()||path.join(env.XDG_CONFIG_HOME?.trim()||path.join((process.platform==="win32"?env.USERPROFILE:env.HOME)||homedir(),".config"),"opencode"));
     const folder=path.join(directory,".hetu-acp-config",randomUUID());await mkdir(folder,{recursive:true,mode:0o700});
     let names:string[]=[];try{names=await readdir(source);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
     if(names.length>256)throw Error("提供方配置目录超过条目预算，未启动会话。");
     let own="";try{const info=await stat(path.join(source,"AGENTS.md"));if(!info.isFile()||info.size>64*1024)throw Error("提供方原有说明无效或超过预算，未启动会话。");own=await readFile(path.join(source,"AGENTS.md"),"utf8");if(Buffer.byteLength(own)>64*1024)throw Error("提供方原有说明读取期间超过预算，未启动会话。");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
     await writeFile(path.join(folder,"AGENTS.md"),[own.trim(),instructions].filter(Boolean).join("\n\n"),{mode:0o600,flag:"wx"});
     for(const name of names){
       if(name.toLowerCase()==="agents.md")continue;
       const original=path.join(source,name),target=path.join(folder,name),info=await lstat(original);
       if(process.platform==="win32"&&!info.isDirectory())await link(original,target);
       else await symlink(original,target,info.isDirectory()?(process.platform==="win32"?"junction":"dir"):"file");
     }
     env.OPENCODE_CONFIG_DIR=folder;
   }else inlineInstructions(env,"OPENCODE_CONFIG_CONTENT",file);
 }
 if(id==="kiro")return {args,clientMetadata:{kiro:{hooks:{enabled:true,v2:true}}},sessionMetadata:(_initialized,resume)=>resume?undefined:{kiro:{steering:[{name:"hetu",inclusion:"always",content:instructions}]}}};
 if(id==="antigravity")return {args,sessionMetadata:initialized=>{
   if(initialized.agentCapabilities?._meta?.antigravity?.systemPrompt?.append!==true)throw Error("提供方未声明接收固定范围说明的能力，没有创建会话。");
   return {antigravity:{systemPrompt:{append:instructions}}};
 }};
 return {args};
}
