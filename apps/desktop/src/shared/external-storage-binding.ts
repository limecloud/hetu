export type ExternalProfileBinding={kind:"hermes";name:string;selected:string;canonical:string;source:"home"|"active_profile"|"default"};
export type ExternalStorageBinding={
  revision:1;
  provider_id:string;
  location:"local";
  program:string;
  directories:{name:string;selected:string;canonical:string;source:"environment"|"default"}[];
  profile?:ExternalProfileBinding;
};
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const fields=(value:Record<string,unknown>,names:string[])=>Object.keys(value).every(key=>names.includes(key));
const absolute=(value:unknown)=>typeof value==="string"&&value.length>0&&value.length<=4096&&!/[\x00-\x1f\x7f]/.test(value)&&(/^(?:\/|[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/).test(value);
export function validExternalProfileBinding(value:unknown):value is ExternalProfileBinding{
  return object(value)&&fields(value,["kind","name","selected","canonical","source"])&&value.kind==="hermes"&&typeof value.name==="string"&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.name)&&absolute(value.selected)&&absolute(value.canonical)&&["home","active_profile","default"].includes(value.source);
}

/** 本机进程与目录选择的固定值；不包含登录身份、凭据或权限。 */
export function validExternalStorageBinding(value:unknown,provider?:string):value is ExternalStorageBinding{
  if(!object(value)||!fields(value,["revision","provider_id","location","program","directories","profile"])||value.revision!==1||value.location!=="local"||typeof value.provider_id!=="string"||!/^[a-z0-9-]{1,80}$/.test(value.provider_id)||provider!==undefined&&value.provider_id!==provider||!absolute(value.program)||!Array.isArray(value.directories)||!value.directories.length||value.directories.length>8||value.profile!==undefined&&(value.provider_id!=="hermes"||!validExternalProfileBinding(value.profile)))return false;
  const names=new Set<string>();
  for(const row of value.directories){if(!object(row)||!fields(row,["name","selected","canonical","source"])||typeof row.name!=="string"||!/^[A-Z_]{1,64}$/.test(row.name)||names.has(row.name)||!absolute(row.selected)||!absolute(row.canonical)||!["environment","default"].includes(row.source))return false;names.add(row.name);}
  return names.has("HOST_HOME")&&new TextEncoder().encode(JSON.stringify(value)).length<=8192;
}

export function sameExternalStorageBinding(left:ExternalStorageBinding,right:ExternalStorageBinding){
  if(!validExternalStorageBinding(left)||!validExternalStorageBinding(right))return false;
  const normalize=(binding:ExternalStorageBinding)=>({revision:binding.revision,provider_id:binding.provider_id,location:binding.location,program:binding.program,directories:[...binding.directories].sort((a,b)=>a.name.localeCompare(b.name)).map(row=>({name:row.name,selected:row.selected,canonical:row.canonical,source:row.source})),...(binding.profile?{profile:{kind:binding.profile.kind,name:binding.profile.name,selected:binding.profile.selected,canonical:binding.profile.canonical,source:binding.profile.source}}:{})});
  return JSON.stringify(normalize(left))===JSON.stringify(normalize(right));
}

/** 旧Hermes位置记录未固定profile；首次接续只允许在相同根位置补充基线。 */
export function canBindExternalStorage(previous:ExternalStorageBinding,current:ExternalStorageBinding){
  return sameExternalStorageBinding(previous,current)||previous.provider_id==="hermes"&&previous.profile===undefined&&!!current.profile&&sameExternalStorageBinding({...previous,profile:current.profile},current);
}
