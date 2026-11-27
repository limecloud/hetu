import {mkdir} from "node:fs/promises";
import path from "node:path";
import {engineSearchEnvironment,runnableCommand,executableCandidates} from "./command-resolution.ts";
import {readLoginShellEnvironment} from "./shell-environment.ts";
import type {AgentEngine,AgentEngineId,AgentModel,SessionLaunch} from "../../agent-session-contract.ts";
import {resolveCodexCommand} from "./codex-command.ts";
import {CodexRpc} from "./codex-rpc.ts";
import desktopPackage from "../../../package.json" with {type:"json"};
import {externalProviders,externalProvider} from "../../shared/external-ai.ts";
import {hasExternalProtocol} from "./external-conversation-registry.ts";

const definitions:AgentEngine[]=[
  {id:"shell",name:"终端",available:false,chat:false,models:false},
  ...externalProviders.map(provider=>({id:provider.id,name:provider.label,available:false,chat:provider.id==="codex"||hasExternalProtocol(provider.structured?.protocol),models:provider.id==="codex",...(provider.structured?{protocol:provider.structured.protocol,minimum_versions:provider.structured.minimumVersions?[...provider.structured.minimumVersions]:undefined}:{})})),
];
export function validEngineId(id:unknown):id is AgentEngineId{return typeof id==="string"&&definitions.some(item=>item.id===id);}
export const engineName=(id:string)=>definitions.find(item=>item.id===id)?.name??"终端";
export const machineClient=(id:string)=>id==="codex"?"codex":["claude-code","claude-agent-teams"].includes(id)?"claude-code":"generic";

/** 复用登录Shell寻址，只解析已安装入口，不修改全局配置或自动安装。 */
export async function resolveEngine(id:AgentEngineId,runtimeDirectory?:string){
  if(!definitions.some(item=>item.id===id))throw Error("请选择有效的终端引擎。");
  if(id==="codex")return resolveCodexCommand(runtimeDirectory);
  const {paths,env}=await engineSearchEnvironment(runtimeDirectory);
  const commands=id==="shell"?[process.platform==="win32"?process.env.COMSPEC??"powershell.exe":process.env.SHELL??"/bin/zsh"]:[...externalProvider(id).commands];
  const override=process.env["HETU_"+id.replaceAll("-","_").toUpperCase()+"_BIN"];
  for(const command of override?[override]:commands)for(const candidate of executableCandidates(command,paths)){
    if(await runnableCommand(candidate)){
      if(id!=="shell")for(const required of externalProvider(id).requiredCommands??[])if(!(await Promise.all(executableCandidates(required,paths).map(candidate=>runnableCommand(candidate)))).some(Boolean))throw Error(engineName(id)+"缺少必需命令。");
      return {binary:candidate,env:{...env,PATH:[path.dirname(candidate),...paths].join(path.delimiter)}};
    }
  }
  throw Error("未找到"+engineName(id)+"，请先安装对应客户端。");
}
export async function discoverEngines(runtimeDirectory?:string):Promise<AgentEngine[]>{
  await readLoginShellEnvironment(true);
  return Promise.all(definitions.map(async definition=>{try{await resolveEngine(definition.id,runtimeDirectory);return {...definition,available:true};}catch{return {...definition};}}));
}

/** 只探测模型目录，不创建线程或提交模型轮次。 */
export class EngineCatalog {
  #models?:Promise<AgentModel[]>;
  private options:{directory:string;runtimeDirectory?:string};
  constructor(options:{directory:string;runtimeDirectory?:string}){this.options=options;}
  async models(client:AgentEngineId):Promise<AgentModel[]>{
    if(client!=="codex")return [];
    if(!this.#models)this.#models=this.#read().catch(error=>{this.#models=undefined;throw error;});
    return this.#models;
  }
  async #read(){
    const command=await resolveEngine("codex",this.options.runtimeDirectory);
    await mkdir(this.options.directory,{recursive:true,mode:0o700});
    const rpc=new CodexRpc({...command,args:["app-server"],cwd:this.options.directory,message:()=>{},disconnected:()=>{}});
    try{
      await rpc.open();await rpc.request("initialize",{clientInfo:{name:"hetu-model-catalog",version:desktopPackage.version},capabilities:{experimentalApi:true}});rpc.write({method:"initialized",params:{}});
      const models:AgentModel[]=[];let cursor:string|undefined;
      do{
        const result=await rpc.request("model/list",{includeHidden:false,...(cursor?{cursor}:{})});
        for(const item of result.data??[]){
          if(typeof item.model!=="string"||typeof item.displayName!=="string")continue;
          models.push({id:item.model,name:item.displayName,efforts:(item.supportedReasoningEfforts??[]).map((option:any)=>option.reasoningEffort).filter((effort:any)=>typeof effort==="string"),default_effort:item.defaultReasoningEffort});
        }
        cursor=result.nextCursor??undefined;
        if(models.length>500)throw Error("模型目录超过显示预算。");
      }while(cursor);
      return models;
    }finally{await rpc.close();}
  }
  async validate(input:unknown):Promise<SessionLaunch>{
    const value=input as SessionLaunch;
    if(!value||!definitions.some(item=>item.id===value.client)||!["gui","tui"].includes(value.surface))throw Error("会话配置无效。");
    if(value.surface==="gui"&&!definitions.find(item=>item.id===value.client)?.chat)throw Error("此引擎使用原生终端。");
    if(value.title!==undefined&&(typeof value.title!=="string"||value.title.trim().length>100))throw Error("会话名称最多100字。");
    await resolveEngine(value.client,this.options.runtimeDirectory);
    if(value.model){
      if(typeof value.model!=="string"||value.model.length>255||/[\u0000-\u001f\u007f]/.test(value.model))throw Error("模型标识无效。");
      if(value.client==="codex"){
        const model=(await this.models(value.client)).find(item=>item.id===value.model);
        if(!model)throw Error("模型已不可用，请重新选择。");
        if(value.reasoning_effort&&!model.efforts.includes(value.reasoning_effort))throw Error("该模型不支持所选推理档位。");
      }else if(value.surface!=="gui")throw Error("此引擎在创建时模型选择不可用，请使用原生终端。");
    }else if(value.reasoning_effort)throw Error("请先选择对应模型。");
    return {client:value.client,surface:value.surface,...(value.title?.trim()?{title:value.title.trim()}:{}),...(value.model?{model:value.model}:{}),...(value.reasoning_effort?{reasoning_effort:value.reasoning_effort}:{})};
  }
}
