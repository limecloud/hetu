import {matchesFixedContextSource,type FixedContextSource} from "./source-reference.ts";
import {readObjectProjection,type JsonProjection as Projection} from "../../../packages/workbench-ui/src/json-projection.ts";
export type EntityProjection={entity_sha256:string;entity_page:Projection;[key:string]:unknown};
export type ProfessionalProjection=FixedContextSource&{source_kind:"plugin";page:Projection};

/** 沿同一固定实体的公开字段分页重组，不扩大到整份设定。 */
export async function readSourceEntity(read:(result_path:string,offset:number)=>Promise<EntityProjection>){
 const {first,object:entity}=await readObjectProjection(read,result=>result.entity_page,result=>result.entity_sha256);
 const {entity_page,...metadata}=first;
 return {...metadata,entity,complete:true};
}

/** 专业对象始终匹配任务附加时的完整引用，不依赖插件运行时。 */
export async function readSourceProfessional(read:(result_path:string,offset:number)=>Promise<ProfessionalProjection>,expected:FixedContextSource,initial?:ProfessionalProjection){
 const {first,object}=await readObjectProjection(read,result=>result.page,result=>
  result.source_kind==="plugin"&&matchesFixedContextSource(result,expected)?result.sha256:"",initial);
 const {page,...metadata}=first;
 return {...metadata,professional:object,complete:true};
}
