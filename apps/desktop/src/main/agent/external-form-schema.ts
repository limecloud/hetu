import {boundedExternalElicitation,type ExternalFormField} from "../../shared/external-elicitation.ts";
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const known=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));
const nullable=(value:unknown)=>value===undefined||value===null;

/** 协议共享的扁平表单解析；完整保留已支持约束，未知约束整份拒绝。 */
export function externalFormFields(value:unknown):ExternalFormField[]{
  if(!object(value))throw Error("提供方表单结构无效。");
  const schema=value;
  if(!known(schema,["$schema","type","properties","required","additionalProperties"])||schema.additionalProperties!==undefined&&schema.additionalProperties!==false||schema.type!=="object"||!object(schema.properties)||!nullable(schema.required)&&(!Array.isArray(schema.required)||schema.required.some((key:unknown)=>typeof key!=="string"||!Object.hasOwn(schema.properties,key))||new Set(schema.required).size!==schema.required.length))throw Error("提供方表单结构或必填字段无效。");
  const fields=Object.entries(schema.properties).map(([id,raw])=>{
    if(!object(raw))throw Error("提供方表单字段无效。");
    const common=["type","title","description","default"],allowed=raw.type==="string"?[...common,"format","minLength","maxLength","enum","enumNames","oneOf"]:raw.type==="array"?[...common,"items","minItems","maxItems"]:["number","integer"].includes(raw.type)?[...common,"minimum","maximum"]:common;
    if(!known(raw,allowed))throw Error("提供方表单包含未接通的字段约束。");
    if(raw.enumNames!==undefined&&raw.enum===undefined)throw Error("提供方表单选项名称缺少对应枚举。");
    const field:ExternalFormField={id,title:raw.title??id,type:raw.type,required:(schema.required??[]).includes(id),...(raw.description!==null&&raw.description!==undefined?{description:raw.description}:{})};
    const constraints={minLength:"min_length",maxLength:"max_length",minimum:"minimum",maximum:"maximum",minItems:"min_items",maxItems:"max_items",format:"format"} as const;
    for(const [source,target] of Object.entries(constraints))if(!nullable(raw[source]))(field as any)[target]=raw[source];
    const choices=(row:unknown):NonNullable<ExternalFormField["options"]>=>{
      if(!object(row))throw Error("提供方表单选项无效。");
      if([row.enum,row.oneOf,row.anyOf].filter(value=>value!==undefined).length!==1)throw Error("提供方表单选项组合包含未接通约束。");
      if(row.enum!==undefined){
        if(!Array.isArray(row.enum))throw Error("提供方表单选项无效。");
        if(!nullable(row.enumNames)&&(!Array.isArray(row.enumNames)||row.enumNames.length!==row.enum.length))throw Error("提供方表单选项名称不完整。");
        return row.enum.map((value:unknown,index:number)=>{const label=Array.isArray(row.enumNames)?row.enumNames[index]:value;if(typeof value!=="string"||typeof label!=="string")throw Error("提供方表单选项值或名称无效。");return {value,label};});
      }
      if(row.enumNames!==undefined)throw Error("提供方表单选项名称缺少对应枚举。");
      const values=row.oneOf??row.anyOf;
      if(!Array.isArray(values))throw Error("提供方表单选项未接通。");
      return values.map(row=>{if(!object(row)||!known(row,["const","title","description"]))throw Error("提供方表单选项包含未接通约束。");const value=row.const,label=row.title??value;if(typeof value!=="string"||typeof label!=="string"||row.description!==undefined&&typeof row.description!=="string")throw Error("提供方表单选项值、名称或说明无效。");return {value,label,...(row.description!==undefined?{description:row.description}:{})};});
    };
    if(raw.type==="array"){
      if(!object(raw.items)||!known(raw.items,["type","enum","anyOf"])||raw.items.type!==undefined&&raw.items.type!=="string")throw Error("提供方表单多选字段无效。");field.options=choices(raw.items);
    }else if(raw.enum!==undefined||raw.oneOf!==undefined)field.options=choices(raw);
    return field;
  });
  const checked=boundedExternalElicitation({id:"schema-check",revision:0,title:"表单字段",server:"字段校验",message:"",mode:"form",fields});
  if(checked.mode!=="form")throw Error("表单模式无效。");return checked.fields;
}
