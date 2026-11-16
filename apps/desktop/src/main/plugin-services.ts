import type {WorkRef,WorkSurface} from '@hetu/plugin-sdk';
import {sameWork,unwrap} from '@hetu/plugin-sdk';

/** 插件只得到窄服务的结果；连接授权由受信宿主保存并交接。 */
export async function pluginService(action:string,input:Record<string,any>,context:{
  work:WorkRef;check():void;
  request(action:string,input:Record<string,unknown>):Promise<any>;
  preferences():{theme:string;language:string};
  handoff(input:Record<string,unknown>):Promise<void>;
  openDocument(id:string):Promise<void>;
  exportFile?(input:Record<string,unknown>):Promise<unknown>;
  closeView?():void;
  openWork?(target:WorkSurface):Promise<void>;
}){
  context.check();
  const closed=(keys:string[])=>{if(!input||Object.keys(input).some(k=>!keys.includes(k)))throw new Error('插件服务参数无效。');};
  if(action==='preferences'){closed([]);return context.preferences();}
  if(action==='open_work'){
    closed(['target']);
    if(!['profile','manuscript','canon'].includes(input.target)||!context.openWork)throw new Error('当前宿主工作面不可用。');
    await context.openWork(input.target);return {requested:true};
  }
  if(action==='close_view'){
    closed([]);
    if(!context.closeView)throw new Error('当前宿主未提供返回入口。');
    context.closeView();return {requested:true};
  }
  if(action==='work_snapshot'){closed([]);const r=unwrap(await context.request('hetu.novels.snapshot',{}));context.check();return r;}
  if(action==='handoff'){
    closed(['goal','object_ref','node_id','run_ref']);
    if(typeof input.goal!=='string'||!input.goal.trim()||input.goal.length>8000)throw new Error('请说明当前创作目标。');
    const validateRef=async(ref:any)=>{
      if(!ref||Object.keys(ref).sort().join(',')!=='object_id,revision,sha256'||!/^ext_[a-f0-9-]{36}$/.test(ref.object_id)||!Number.isSafeInteger(ref.revision)||ref.revision<1||!/^[a-f0-9]{64}$/.test(ref.sha256))throw new Error('成果引用无效。');
      const r=unwrap<any>(await context.request('hetu.extensions.objects.get',{object_id:ref.object_id,revision:ref.revision}));
      context.check();if(!sameWork(r.object.work_ref,context.work)||r.sha256!==ref.sha256)throw new Error('成果范围或摘要不一致。');return r.object;
    };
    const object=input.object_ref?await validateRef(input.object_ref):undefined;
    if(input.node_id&&(!object?.content?.nodes?.some((n:any)=>n.id===input.node_id)))throw new Error('节点不属于固定成果。');
    if(input.run_ref){const run=await validateRef(input.run_ref);if(!object||run.content?.plan_ref?.object_id!==object.object_id)throw new Error('工作记录不属于所选成果。');}
    context.check();await context.handoff(input);return {copied:true};
  }
  if(action==='open_document'){
    closed(['source_ref']);const source=input.source_ref;
    if(source?.kind!=='document'||!sameWork(source.work_ref,context.work))throw new Error('请选择当前作品的固定正文。');
    unwrap(await context.request('hetu.extensions.sources.inspect',{source_ref:source}));context.check();
    await context.openDocument(source.document_id);return {opened:true};
  }
  if(action==='export_file'){
    closed(['action','input','suggested_name']);
    if(typeof input.action!=='string'||!input.input||typeof input.input!=='object'||Array.isArray(input.input)||typeof input.suggested_name!=='string'||!input.suggested_name.trim()||input.suggested_name.length>120||/[\\/\u0000-\u001f]/.test(input.suggested_name))throw new Error('导出参数无效。');
    if(!context.exportFile)throw new Error('当前宿主未提供文件导出服务。');
    context.check();return context.exportFile(input);
  }
  throw new Error('未知插件宿主服务。');
}
