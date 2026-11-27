import React,{useEffect,useRef,useState} from "react";
import type {AgentModel,SessionSnapshot} from "../agent-session-contract.ts";
import {desktop} from "./bridge.ts";
import {AgentLaunchPicker,engineTitle,type AgentPickerValue} from "./agent-launch-picker.tsx";

/** 模型控件留在输入底部；选择只调用当前执行端已声明的原生能力。 */
export function AgentModelControl({snapshot,notify}:{snapshot:SessionSnapshot;notify(message:string):void}){
 const [models,setModels]=useState<AgentModel[]>([]),[busy,setBusy]=useState(false),changing=useRef(false),external=snapshot.external;
 const scope=snapshot.work_ref?{work_ref:snapshot.work_ref}:{scope:"library"};
 useEffect(()=>{let active=true;if(external){setModels(external.models.map(model=>({id:model.id,name:model.label,efforts:(model.efforts??[]).map(effort=>effort.id)})));return;}
  if(snapshot.capabilities?.models)void desktop.agentSession("models",{...scope,session_id:snapshot.session_id}).then(value=>{if(active)setModels((value.data??[]).map((model:any)=>({id:model.model,name:model.displayName??model.model,efforts:(model.supportedReasoningEfforts??[]).map((effort:any)=>effort.reasoningEffort)})));}).catch(()=>{});return()=>{active=false;};
 },[snapshot.session_id,external?.models,snapshot.capabilities?.models]);
 const change=async(value:AgentPickerValue)=>{
  if(changing.current||!value.model||snapshot.state!=="ready")return;changing.current=true;setBusy(true);
  try{
   const fixed={...scope,session_id:snapshot.session_id,generation:snapshot.generation};
   if(external){if(value.model!==external.model)await desktop.agentSession("external",{...fixed,external_method:"model",external_input:{model_id:value.model}});if(value.reasoning_effort&&value.reasoning_effort!==external.effort)await desktop.agentSession("external",{...fixed,external_method:"effort",external_input:{effort_id:value.reasoning_effort}});}
   else await desktop.agentSession("model",{...fixed,model_id:value.model,effort_id:value.reasoning_effort});
  }catch(error){notify((error as Error).message);}finally{changing.current=false;setBusy(false);}
 };
 if(!models.length&&!snapshot.model&&!external?.model)return null;
 return <AgentLaunchPicker value={{client:snapshot.client,model:external?.model??snapshot.model,reasoning_effort:external?.effort??snapshot.reasoning_effort}} onChange={value=>void change(value)} engines={[{id:snapshot.client,name:engineTitle(snapshot.client),available:true,models:true,chat:true}]} models={models} label="模型" showEngine={false} allowDefault={false} disabled={busy||snapshot.state!=="ready"}/>;
}
