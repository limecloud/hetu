export type ExternalFormValue=string|number|boolean|string[];
export type ExternalFormField={id:string;title:string;description?:string;type:"string"|"number"|"integer"|"boolean"|"array";required:boolean;options?:{value:string;label:string;description?:string}[];min_length?:number;max_length?:number;minimum?:number;maximum?:number;min_items?:number;max_items?:number;format?:"email"|"uri"|"date"|"date-time"};
type RequestBase={id:string;revision:number;title:string;message:string;server:string;environment_id?:string;provider_item_id?:string};
export type ExternalElicitation=RequestBase&({mode:"form";fields:ExternalFormField[]}|{mode:"url";url:string;elicitation_id:string});
export type ExternalElicitationResponse={action:"accept"|"decline"|"cancel";content?:Record<string,ExternalFormValue>};

const text=(value:unknown,max:number,empty=false)=>typeof value==="string"&&(empty||value.length>0)&&value.length<=max&&!/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const fits=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length<=32000;
export function externalElicitationUrl(value:unknown):string {
  if(!text(value,8192))throw Error("外部验证链接无效。");
  const url=new URL(value as string);
  if(!["https:","http:"].includes(url.protocol)||url.username||url.password)throw Error("外部验证只接受不含账户凭据的HTTP或HTTPS链接。");
  return value as string;
}

/** 只有有界字段与原选项进入界面，表单不携带可执行布局或验证脚本。 */
export function boundedExternalElicitation(value:ExternalElicitation):ExternalElicitation {
  if(!record(value)||!text(value.id,255)||!Number.isSafeInteger(value.revision)||value.revision<0||!text(value.title,255)||!text(value.message,8000,true)||!text(value.server,255)||value.environment_id!==undefined&&!text(value.environment_id,255)||value.provider_item_id!==undefined&&!text(value.provider_item_id,255)||!fits(value))throw Error("外部表单格式无效或超过预算。");
  if(value.mode==="url"){
    externalElicitationUrl(value.url);if(!text(value.elicitation_id,255))throw Error("外部验证缺少原请求身份。");
  }else if(value.mode==="form"){
    if(!Array.isArray(value.fields)||value.fields.length>16)throw Error("外部表单字段超过预算。");
    const ids=new Set<string>();
    for(const field of value.fields){
      if(!record(field)||!text(field.id,255)||ids.has(field.id)||!text(field.title,255)||field.description!==undefined&&!text(field.description,2000,true)||!['string','number','integer','boolean','array'].includes(field.type)||typeof field.required!=="boolean")throw Error("外部表单字段无效。");
      ids.add(field.id);
      if(field.options!==undefined){
        if(!["string","array"].includes(field.type)||!Array.isArray(field.options)||!field.options.length||field.options.length>32||new Set(field.options.map(option=>option.value)).size!==field.options.length||field.options.some(option=>!text(option.value,2000,true)||!text(option.label,2000)||option.description!==undefined&&!text(option.description,2000,true)))throw Error("外部表单选项无效或超过预算。");
      }
      if(field.type==="array"&&!field.options)throw Error("外部表单只接受固定选项的多选字段。");
      for(const key of ['min_length','max_length','min_items','max_items'] as const)if(field[key]!==undefined&&(!Number.isSafeInteger(field[key])||field[key]!<0))throw Error("外部表单长度限制无效。");
      for(const key of ['minimum','maximum'] as const)if(field[key]!==undefined&&!Number.isFinite(field[key]))throw Error("外部表单数值限制无效。");
      if(field.min_length!==undefined&&field.min_length>Math.min(field.max_length??8000,8000)||field.min_items!==undefined&&field.min_items>Math.min(field.max_items??32,field.options?.length??32)||field.minimum!==undefined&&field.maximum!==undefined&&field.minimum>field.maximum)throw Error("外部表单限制无法满足。");
      if(field.format!==undefined&&!["email","uri","date","date-time"].includes(field.format))throw Error("外部表单格式未接通。");
    }
  }else throw Error("外部表单模式未接通。");
  return structuredClone(value);
}

function matchesFormat(value:string,format:ExternalFormField["format"]){
  if(format==="email")return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if(format==="uri"){try{return !!new URL(value).protocol;}catch{return false;}}
  if(format==="date")return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  if(format==="date-time")return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)&&Number.isFinite(Date.parse(value));
  return true;
}

/** 接受、拒绝和取消分开；回答保持原类型，缺少可选值不会变成默认授权。 */
export function validateExternalElicitationResponse(request:ExternalElicitation,value:unknown):ExternalElicitationResponse {
  if(!record(value)||Object.keys(value).some(key=>!["action","content"].includes(key))||!["accept","decline","cancel"].includes(value.action as string)||!fits(value))throw Error("外部表单回答无效或超过预算。");
  const action=value.action as ExternalElicitationResponse["action"];
  if(action!=="accept"||request.mode==="url"){
    if(Object.hasOwn(value,"content"))throw Error("此表单决定不能附带字段内容。");return {action};
  }
  if(!record(value.content)||Object.keys(value.content).some(key=>!request.fields.some(field=>field.id===key)))throw Error("回答包含未知字段或缺少表单内容。");
  const content=value.content;
  for(const field of request.fields){
    if(!Object.hasOwn(content,field.id)){if(field.required)throw Error("请填写必填字段："+field.title);continue;}
    const input=content[field.id],fail=()=>{throw Error("字段不符合原表单约束："+field.title);};
    if(field.type==="string"){
      if(typeof input!=="string"||!text(input,8000,true))fail();
      const size=Array.from(input as string).length;
      if(size<(field.min_length??0)||size>(field.max_length??8000)||!matchesFormat(input as string,field.format)||field.options&&!field.options.some(option=>option.value===input))fail();
    }else if(field.type==="number"||field.type==="integer"){
      if(typeof input!=="number"||!Number.isFinite(input)||field.type==="integer"&&!Number.isSafeInteger(input)||field.minimum!==undefined&&(input as number)<field.minimum||field.maximum!==undefined&&(input as number)>field.maximum)fail();
    }else if(field.type==="boolean"){if(typeof input!=="boolean")fail();}
    else if(!Array.isArray(input)||input.length<(field.min_items??0)||input.length>Math.min(field.max_items??32,32)||new Set(input).size!==input.length||input.some(value=>typeof value!=="string"||!field.options?.some(option=>option.value===value)))fail();
  }
  return {action,content:structuredClone(content) as Record<string,ExternalFormValue>};
}
