import type {AgentRequest} from "./agent-session-contract.ts";

export function requestKind(request:AgentRequest){
 if(request.method.endsWith("requestUserInput"))return "questions";
 if(request.method==="item/permissions/requestApproval")return "permissions";
 if(request.method.endsWith("requestApproval"))return "approval";
 if(request.method==="mcpServer/elicitation/request")return "elicitation";
 return "unsupported";
}
export function enumOptions(schema:any):{value:string;label:string}[]{
 const source=schema?.type==="array"?schema.items:schema;
 if(Array.isArray(source?.enum))return source.enum.map((value:string,index:number)=>({value,label:source.enumNames?.[index]??value}));
 return (source?.oneOf??source?.anyOf??[]).map((value:any)=>({value:value.const,label:value.title??value.const}));
}
const object=(value:any)=>!!value&&typeof value==="object"&&!Array.isArray(value);
function equalJson(a:any,b:any):boolean{
 if(a===b)return true;
 if(Array.isArray(a))return Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>equalJson(value,b[index]));
 return object(a)&&object(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.hasOwn(b,key)&&equalJson(a[key],b[key]));
}
export function elicitationContent(schema:any,values:Record<string,unknown>){
 return Object.fromEntries(Object.entries(schema?.properties??{}).flatMap(([key,field]:[string,any])=>{
  const value=Object.hasOwn(values,key)?values[key]:field.default??(field.type==="boolean"?false:undefined);
  return value===undefined||value===""&&!schema.required?.includes(key)?[]:[[key,value]];
 }));
}
function primitive(schema:any,value:any){
 const options=enumOptions(schema);
 if(schema.type==="string"){
  if(typeof value!=="string"||value.length<(schema.minLength??0)||value.length>(schema.maxLength??64000))return false;
  if(options.length&&!options.some(option=>option.value===value))return false;
  if(schema.format==="email"&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))return false;
  if(schema.format==="uri"){try{new URL(value);}catch{return false;}}
  if(schema.format==="date"&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))))return false;
  if(schema.format==="date-time"&&!Number.isFinite(Date.parse(value)))return false;
  return true;
 }
 if(schema.type==="number"||schema.type==="integer")return typeof value==="number"&&Number.isFinite(value)&&(schema.type!=="integer"||Number.isInteger(value))&&value>=(schema.minimum??-Infinity)&&value<=(schema.maximum??Infinity);
 if(schema.type==="boolean")return typeof value==="boolean";
 if(schema.type==="array")return Array.isArray(value)&&new Set(value).size===value.length&&value.length>=(schema.minItems??0)&&value.length<=(schema.maxItems??1000)&&value.every(item=>typeof item==="string"&&options.some(option=>option.value===item));
 return false;
}
export function validateServerAnswer(request:AgentRequest,result:unknown){
 const value=result as any,params=request.params as any;
 if(!object(value)||JSON.stringify(value).length>512000)throw new Error("答复格式无效或超过预算。");
 const kind=requestKind(request);
 if(kind==="approval"){
  if(Object.keys(value).some(key=>key!=="decision")||!["accept","acceptForSession","decline","cancel"].includes(value.decision))throw new Error("不支持的审批答复。");
  const allowed=params.availableDecisions;
  if(Array.isArray(allowed)&&!allowed.includes(value.decision))throw new Error("此请求未提供该审批选项。");
 }else if(kind==="questions"){
  if(Object.keys(value).some(key=>key!=="answers")||!object(value.answers))throw new Error("请按当前问题提交答复。");
  const questions=params.questions??[];
  if(Object.keys(value.answers).length===0)return;
  if(Object.keys(value.answers).length!==questions.length||Object.keys(value.answers).some(id=>!questions.some((q:any)=>q.id===id)))throw new Error("问题身份已经变化，请重新核对。");
  for(const question of questions){const answer=value.answers[question.id];if(!object(answer)||Object.keys(answer).some(key=>key!=="answers")||!Array.isArray(answer.answers)||answer.answers.length!==1||typeof answer.answers[0]!=="string"||!answer.answers[0].trim()||answer.answers[0].length>64000)throw new Error("请回答全部问题。");if(question.options?.length&&!question.isOther&&!question.options.some((option:any)=>option.label===answer.answers[0]))throw new Error("答复不属于当前问题的选项。");}
 }else if(kind==="permissions"){
  if(Object.keys(value).some(key=>!["permissions","scope"].includes(key))||!object(value.permissions)||!["turn","session"].includes(value.scope))throw new Error("权限答复无效。");
  for(const [key,permission]of Object.entries(value.permissions))if(!Object.hasOwn(params.permissions??{},key)||!equalJson(permission,params.permissions[key]))throw new Error("不能扩大本次请求的权限范围。");
 }else if(kind==="elicitation"){
  if(Object.keys(value).some(key=>!["action","content"].includes(key))||!["accept","decline","cancel"].includes(value.action))throw new Error("不支持的表单答复。");
  if(value.action!=="accept"){if(value.content!=null)throw new Error("取消或拒绝不能附加表单内容。");return;}
  if(params.mode==="url"){if(value.content!=null)throw new Error("URL请求不接受表单内容。");return;}
  const schema=params.requestedSchema;
  if(!schema||!object(schema.properties)||!object(value.content))throw new Error("此请求无法按表单确认。");
  if(Object.keys(value.content).some(key=>!Object.hasOwn(schema.properties,key))||(schema.required??[]).some((key:string)=>!Object.hasOwn(value.content,key)))throw new Error("表单字段与当前请求不一致。");
  for(const [key,field] of Object.entries(value.content))if(!primitive(schema.properties[key],field))throw new Error("表单内容不符合字段约束："+(schema.properties[key].title??key));
 }else if(value.unsupported!==true||Object.keys(value).length!==1)throw new Error("此类型请求尚无答复协议。");
}
