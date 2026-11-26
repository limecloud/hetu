export type FixedContextSource={context_ref:{context_id:string;sha256:string};fixed_ref:Record<string,unknown>;sha256:string;size_bytes?:number};

function sameValue(left:unknown,right:unknown):boolean{
 if(left===right)return true;
 if(!left||!right||typeof left!=="object"||typeof right!=="object"||Array.isArray(left)!==Array.isArray(right))return false;
 const a=left as Record<string,unknown>,b=right as Record<string,unknown>;
 return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.hasOwn(b,key)&&sameValue(a[key],b[key]));
}

/** 页面读取只接受原任务固定的同一来源；对象字段顺序不影响身份。 */
export function matchesFixedContextSource(value:FixedContextSource,expected:FixedContextSource){
 return !!value&&value.sha256===expected.sha256&&sameValue(value.context_ref,expected.context_ref)&&sameValue(value.fixed_ref,expected.fixed_ref);
}
