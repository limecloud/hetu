export type ExternalCommand={name:string;description:string;argument_hint?:string};
export type ExternalCommandCatalog={revision:number;reported:boolean;commands:ExternalCommand[]};

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
export function validExternalCommandName(value:unknown):value is string{return typeof value==="string"&&value.length>0&&value.length<=255&&!value.startsWith("/")&&!/[\s\x00-\x1f\x7f]/u.test(value);}
/** 原命令是提供方数据；不猜测内置命令，不裁掉未知输入约束后继续调用。 */
export function boundedExternalCommands(value:unknown):ExternalCommand[]{
 if(!Array.isArray(value)||value.length>128)throw Error("提供方命令目录无效或超过预算。");
 const names=new Set<string>();
 const commands=value.map(row=>{
  if(!object(row)||Object.keys(row).some(key=>!["name","description","input","_meta"].includes(key))||!validExternalCommandName(row.name)||names.has(row.name)||typeof row.description!=="string"||row.description.length>4096||/[\x00-\x08\x0b-\x1f\x7f]/.test(row.description))throw Error("提供方命令身份、说明或目录字段无效。");
  names.add(row.name);let hint:string|undefined;
  if(row.input!==undefined&&row.input!==null){if(!object(row.input)||Object.keys(row.input).some(key=>!["hint","_meta"].includes(key))||typeof row.input.hint!=="string"||row.input.hint.length>1024||/[\x00-\x1f\x7f]/.test(row.input.hint))throw Error("提供方命令的输入方式尚未接通。");hint=row.input.hint;}
  return {name:row.name,description:row.description,...(hint!==undefined?{argument_hint:hint}:{})};
 });
 if(new TextEncoder().encode(JSON.stringify(commands)).length>24000)throw Error("提供方命令目录超过24KiB。");
 return commands;
}
export function externalCommandText(command:ExternalCommand,argument:unknown=""):string{
 if(!validExternalCommandName(command.name)||typeof argument!=="string"||/[\x00-\x08\x0b-\x1f\x7f]/.test(argument))throw Error("提供方命令或参数无效。");
 if(argument.length&&command.argument_hint===undefined)throw Error("原命令没有声明接收参数。");
 const text="/"+command.name+(argument.length?" "+argument:"");
 if(new TextEncoder().encode(text).length>64*1024)throw Error("提供方命令请求超过64KiB。");return text;
}
