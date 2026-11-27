import type {ExternalModel,ExternalConfigurationOption} from "../../shared/external-session.ts";

type Selection={id:string;current:string;choices:{id:string;label:string}[]};
export type AcpModelConfiguration={model?:Selection;effort?:Selection};
const label=(value:unknown)=>typeof value==="string"&&value.length>0&&value.length<=255&&!/[\x00-\x1f\x7f]/.test(value);

/** ACP的模型与思考目录可采用平铺或分组配置；不从提供方名称猜选项。 */
export function acpModelConfiguration(value:unknown):AcpModelConfiguration {
  if(value===undefined||value===null)return {};
  if(!Array.isArray(value)||value.length>64)throw Error("ACP配置目录格式无效或超过预算。");
  const configIds=new Set<string>();
  for(const row of value){if(!row||typeof row!=="object"||!label(row.id)||configIds.has(row.id))throw Error("ACP配置身份无效或重复。");configIds.add(row.id);}
  const result:AcpModelConfiguration={};
  for(const row of value){
    if(!row||typeof row!=="object"||row.type!=="select"||!["model","thought_level"].includes(row.category))continue;
    if(!label(row.id)||!label(row.currentValue)||!Array.isArray(row.options)||row.options.length>512)throw Error("ACP模型或思考配置无效。");
    const options=row.options.flatMap((option:any)=>Array.isArray(option?.options)?option.options:[option]);
    if(options.length>512||options.some((option:any)=>!label(option?.value)||!label(option?.name)))throw Error("ACP配置选项无效或超过预算。");
    const ids=new Set<string>();for(const option of options){if(ids.has(option.value))throw Error("ACP配置选项身份重复。");ids.add(option.value);}
    const choices:{id:string;label:string}[]=options.slice(0,128).map((option:any)=>({id:option.value as string,label:option.name as string}));
    const current=options.find((option:any)=>option.value===row.currentValue);if(current&&!choices.some(option=>option.id===row.currentValue))choices[choices.length-1]={id:current.value,label:current.name};
    const selection={id:row.id,current:row.currentValue,choices};
    if(row.category==="model"){
      if(result.model)throw Error("ACP返回了重复的模型配置。");result.model=selection;
    }else if(!result.effort||choices.length>result.effort.choices.length)result.effort=selection;
  }
  return result;
}

export function acpConfiguredModels(config:AcpModelConfiguration,legacy:ExternalModel[]):ExternalModel[]{
  return (config.model?.choices??legacy).map(model=>({...model,...(config.effort?{efforts:config.effort.choices}:{})}));
}

export function acpAdditionalConfiguration(value:unknown):ExternalConfigurationOption[]{
  if(value===undefined||value===null)return [];
  if(!Array.isArray(value)||value.length>64)throw Error("ACP配置目录无效或超过预算。");
  const options:ExternalConfigurationOption[]=[];
  for(const row of value){
    if(!row||typeof row!=="object"||["model","thought_level"].includes(row.category)||!["boolean","select"].includes(row.type))continue;
    if(!label(row.id)||row.id.length>248||!label(row.name)||row.description!==undefined&&row.description!==null&&(typeof row.description!=="string"||row.description.length>2000))throw Error("ACP配置字段无效。");
    const field={id:"config:"+row.id,label:row.name,...(row.description?{description:row.description}:{})};
    if(row.type==="boolean"){
      if(typeof row.currentValue!=="boolean")throw Error("ACP开关状态无效。");options.push({...field,value:row.currentValue});
    }else{
      if(!label(row.currentValue)||!Array.isArray(row.options))throw Error("ACP选择配置无效。");
      const choices=row.options.flatMap((choice:any)=>Array.isArray(choice?.options)?choice.options:[choice]);
      if(!choices.length||choices.length>128||choices.some((choice:any)=>!label(choice?.value)||!label(choice?.name))||new Set(choices.map((choice:any)=>choice.value)).size!==choices.length)throw Error("ACP选择选项无效或超过预算。");
      options.push({...field,value:row.currentValue,choices:choices.map((choice:any)=>({id:choice.value,label:choice.name}))});
    }
  }
  if(options.length>16||new Set(options.map(option=>option.id)).size!==options.length||Buffer.byteLength(JSON.stringify(options))>32000)throw Error("ACP配置目录超过预算或身份重复。");
  return options;
}
