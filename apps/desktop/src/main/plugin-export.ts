import {createHash,randomUUID} from 'node:crypto';
import {open,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {unwrap} from '@hetu/plugin-sdk';

/** 只在作者选择目标后写入；分段须同一固定清单，失败不替换现有文件。 */
export async function exportPluginFile(input:{action:string;input:Record<string,unknown>;suggested_name:string},context:{
  choose(name:string):Promise<string|undefined>;check():void;
  invoke(action:string,input:Record<string,unknown>):Promise<any>;
}){
  const target=await context.choose(input.suggested_name);if(!target)return {saved:false,cancelled:true};context.check();
  const temporary=path.join(path.dirname(target),'.hetu-export-'+randomUUID()+'.tmp');
  const file=await open(temporary,'wx',0o600);let complete=false;
  try{
    let cursor:string|undefined,manifest:string|undefined,total=0,bytes=0,index=0;const seen=new Set<string>();
    do{
      context.check();const part=unwrap<any>(await context.invoke(input.action,{...input.input,...(cursor?{cursor}:{})}));context.check();
      if(index===0&&part.project_ref&&Number.isSafeInteger(part.offset)){
        let chunk=part;const ref=JSON.stringify(part.project_ref),expectedBytes=part.total_bytes;
        if(!Number.isSafeInteger(expectedBytes)||expectedBytes<0||expectedBytes>256*1024*1024||!['text/markdown','application/json','text/html'].includes(part.media_type))throw new Error('固定对象导出预算或格式无效。');
        const mediaType=part.media_type;
        while(true){
          context.check();
          if(JSON.stringify(chunk.project_ref)!==ref||chunk.media_type!==mediaType||chunk.total_bytes!==expectedBytes||chunk.offset!==bytes||typeof chunk.content!=='string'||createHash('sha256').update(chunk.content).digest('hex')!==chunk.content_sha256)throw new Error('固定对象导出分块不连续或摘要不一致。');
          const length=Buffer.byteLength(chunk.content);if(!length&&expectedBytes!==0)throw new Error('固定对象导出缺少内容。');
          bytes+=length;if(bytes>expectedBytes||bytes>256*1024*1024)throw new Error('固定对象导出超出声明范围。');
          await file.write(chunk.content);index++;
          if(chunk.next_offset===null){if(bytes!==expectedBytes)throw new Error('固定对象导出缺少分块。');break;}
          if(chunk.next_offset!==bytes||bytes>=expectedBytes)throw new Error('固定对象导出偏移不连续。');
          chunk=unwrap<any>(await context.invoke(input.action,{...input.input,offset:bytes}));context.check();
        }
        await file.sync();await file.close();context.check();await rename(temporary,target);complete=true;return {saved:true,parts:index,bytes};
      }
      if(!Array.isArray(part.manifest)||part.index!==index||part.total!==part.manifest.length||part.total<1||part.total>1002||typeof part.content!=='string'||createHash('sha256').update(part.content).digest('hex')!==part.content_sha256)throw new Error('导出分段不完整或摘要不一致。');
      const fixed=JSON.stringify({manifest:part.manifest,plan_ref:part.plan_ref,media_type:part.media_type});
      if(manifest&&manifest!==fixed)throw new Error('导出期间固定清单改变。');manifest=fixed;total=part.total;
      if(!['text/markdown','application/json'].includes(part.media_type))throw new Error('不支持此导出格式。');
      bytes+=Buffer.byteLength(part.content);if(bytes>256*1024*1024)throw new Error('导出超过256MiB预算。');
      if(index===0&&part.media_type==='application/json')await file.write('[\n');
      if(index)await file.write(part.media_type==='application/json'?',\n':'\n\n---\n\n');
      if(part.media_type==='application/json')JSON.parse(part.content);
      await file.write(part.content);index++;
      cursor=part.next_cursor??undefined;if(cursor){if(seen.has(cursor))throw new Error('导出分页循环。');seen.add(cursor);}
      if(!cursor&&index!==total)throw new Error('导出缺少分段。');
      if(!cursor&&part.media_type==='application/json')await file.write('\n]\n');
    }while(cursor);
    await file.sync();await file.close();context.check();await rename(temporary,target);complete=true;return {saved:true,parts:total,bytes};
  }finally{if(!complete){await file.close().catch(()=>{});await rm(temporary,{force:true});}}
}
