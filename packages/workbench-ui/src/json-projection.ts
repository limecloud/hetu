export type JsonProjection={result_path:string;summary:{kind:string;size_bytes:number;items?:number|null};value?:unknown;fields?:{name:string;result_path:string}[];items?:unknown[];next_path?:string;next_offset?:number|null;page?:{content:string;sha256:string;size_bytes:number;range:{byte_start:number;byte_end:number};complete:boolean;next_range?:{byte_start:number}|null}};

/** 结构化读取共用分页器；身份由各自Owner的固定引用核对。 */
export async function readObjectProjection<T>(read:(result_path:string,offset:number)=>Promise<T>,project:(result:T)=>JsonProjection,identity:(result:T)=>string,initial?:T,maxBytes=1024*1024){
 let calls=0,sha:string|undefined;
 const bytes=(text:string)=>new TextEncoder().encode(text).length;
 const invalid=()=>{throw Error("固定来源的分页不完整或身份已变化。");};
 async function page(path:string,offset:number,provided?:T){
  if(++calls>4096)throw Error("固定来源超过本次读取预算。");
  const result=provided??await read(path,offset),value=project(result),key=identity(result);
  if(!value||value.result_path!==path||typeof key!=="string"||!key||sha&&sha!==key)invalid();
  sha??=key;
  return {result,value};
 }
 async function assemble(path:string,first?:JsonProjection,depth=0):Promise<unknown>{
  if(depth>32)invalid();
  let value=first??(await page(path,0)).value;
  if(Object.hasOwn(value,"value"))return value.value;
  if(value.page){
   let offset=0,text="",head=value.page;
   for(;;){
    const chunk=value.page!;
    if(!chunk||chunk.sha256!==head.sha256||chunk.size_bytes!==head.size_bytes||chunk.range.byte_start!==offset||chunk.range.byte_end-offset!==bytes(chunk.content))invalid();
    text+=chunk.content;offset=chunk.range.byte_end;
    if(offset>head.size_bytes||offset>maxBytes)invalid();
    if(chunk.complete){if(chunk.next_range||offset!==head.size_bytes)invalid();return text;}
    if(!chunk.next_range||chunk.next_range.byte_start!==offset||offset<=chunk.range.byte_start)invalid();
    value=(await page(path,offset)).value;
   }
  }
  if(value.fields){
   const result:Record<string,unknown>=Object.create(null),seen=new Set<string>();
   for(const field of value.fields){
    if(seen.has(field.name)||field.result_path!==path+"/"+field.name.replaceAll("~","~0").replaceAll("/","~1"))invalid();
    seen.add(field.name);result[field.name]=await assemble(field.result_path,undefined,depth+1);
   }
   return result;
  }
  if(value.summary?.kind==="array"){
   const result:unknown[]=[],count=value.summary.items;let offset=0;
   for(;;){
    if(value.summary.items!==count)invalid();
    if(value.next_path){
     if(value.next_path!==`${path}/${offset}`)invalid();
     result.push(await assemble(value.next_path,undefined,depth+1));offset++;
    }else{
     if(!Array.isArray(value.items))invalid();
     result.push(...value.items!);
     const next=value.next_offset;
     if(next===null||next===undefined){if(result.length!==count)invalid();return result;}
     if(next!==offset+value.items!.length||next<=offset)invalid();offset=next;
    }
    value=(await page(path,offset)).value;
   }
  }
  return invalid();
 }
 const first=await page("",0,initial);
 if(first.value.summary.kind!=="object"||first.value.summary.size_bytes>maxBytes)throw Error("固定来源超过本次读取预算。");
 const object=await assemble("",first.value);
 if(!object||typeof object!=="object"||Array.isArray(object)||bytes(JSON.stringify(object))>maxBytes)invalid();
 return {first:first.result,object:object as Record<string,unknown>};
}
