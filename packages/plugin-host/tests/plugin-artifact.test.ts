import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {savePluginArtifact} from '../../../apps/desktop/src/main/plugin-artifact.ts';
import {pluginService} from '../../../apps/desktop/src/main/plugin-services.ts';
const bytes=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
const input={suggested_name:'camera.png',media_type:'image/png',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
test('二进制派生文件固定字节原子保存，取消及错误保留原文件',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hetu-artifact-')),file=path.join(root,'camera.png');let selected=0;
 const context={choose:async()=>{selected++;return file;},check(){}};
 assert.deepEqual(await savePluginArtifact(input,context),{saved:true,bytes:bytes.length,sha256:input.sha256});assert.deepEqual(await readFile(file),bytes);
 await writeFile(file,'原文件');
 for(const bad of [{...input,sha256:'0'.repeat(64)},{...input,suggested_name:'../camera.png'},{...input,base64:input.base64+' '},{...input,media_type:'model/gltf-binary'},{...input,base64:'AAAA',sha256:createHash('sha256').update(Buffer.alloc(3)).digest('hex')}]){await assert.rejects(savePluginArtifact(bad,context));assert.equal(await readFile(file,'utf8'),'原文件');}
 assert.equal(selected,1);assert.deepEqual(await savePluginArtifact(input,{...context,choose:async()=>undefined}),{saved:false,cancelled:true});
 let checks=0;await assert.rejects(savePluginArtifact(input,{...context,check(){if(++checks===3)throw new Error('上下文变化');}}),/上下文变化/);assert.equal(await readFile(file,'utf8'),'原文件');assert.deepEqual(await readdir(root),['camera.png']);
});
test('二进制服务核验固定作品与摘要，不接收路径或未知字段',async()=>{
 const work={workspace_id:'workspace_test',kind:'video' as const,object_id:'video_test'},ref={object_id:'ext_11111111-1111-4111-8111-111111111111',revision:1,sha256:'a'.repeat(64)};let saved=0;
 const context={work,check(){},preferences:()=>({theme:'light',language:'zh-CN'}),handoff:async()=>{},openDocument:async()=>{},request:async()=>({status:'succeeded',data:{object:{work_ref:work},sha256:ref.sha256}}),saveArtifact:async()=>{saved++;return {saved:true};}};
 assert.deepEqual(await pluginService('save_artifact',{...input,object_ref:ref},context),{saved:true});
 await assert.rejects(pluginService('save_artifact',{...input,object_ref:{...ref,sha256:'b'.repeat(64)}},context),/摘要/);
 await assert.rejects(pluginService('save_artifact',{...input,object_ref:ref,file_path:'/tmp/a'},context),/无效/);
 await assert.rejects(pluginService('save_artifact',{...input,object_ref:ref},{...context,work:{...work,object_id:'other'}}),/范围/);assert.equal(saved,1);
});
test('完整32MiB预算不会触发正则栈溢出，超出预算在选择文件前拒绝',async()=>{
 const bytes=Buffer.alloc(32*1024*1024,1);bytes.write('PK\x03\x04','binary');
 const payload={suggested_name:'batch.zip',media_type:'application/zip',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
 let selected=0;const context={check(){},choose:async()=>{selected++;return undefined;}};
 assert.deepEqual(await savePluginArtifact(payload,context),{saved:false,cancelled:true});
 await assert.rejects(savePluginArtifact({...payload,base64:payload.base64+'AAAA'},context),/预算/);
 assert.equal(selected,1);
});

test('书稿译稿与声音派生格式核验签名、扩展名及原字节',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hetu-creative-files-'));
 const epub=Buffer.alloc(58);epub.writeUInt32LE(0x04034b50);epub.writeUInt16LE(8,26);epub.write('mimetype',30);epub.write('application/epub+zip',38);
 const wav=Buffer.from('RIFF\x04\x00\x00\x00WAVE','binary');
 const samples=[['book.epub','application/epub+zip',epub],['book.pdf','application/pdf',Buffer.from('%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n')],['draft.html','text/html',Buffer.from('<!doctype html><html lang="zh-CN"><body>原稿</body></html>')],['draft.xlf','application/xliff+xml',Buffer.from('<?xml version="1.0"?><xliff version="2.0"></xliff>')],['voice.wav','audio/wav',wav]] as const;
 for(const [name,type,bytes]of samples){const file=path.join(root,name);let selected=0;const context={check(){},choose:async()=>{selected++;return file;}},payload={suggested_name:name,media_type:type,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
  assert.equal((await savePluginArtifact(payload,context)).saved,true);assert.deepEqual(await readFile(file),bytes);
  await assert.rejects(savePluginArtifact({...payload,suggested_name:name+'.bad'},context));
  const wrong=Buffer.from('并非此格式');await assert.rejects(savePluginArtifact({...payload,base64:wrong.toString('base64'),sha256:createHash('sha256').update(wrong).digest('hex')},context));assert.equal(selected,1);assert.deepEqual(await readFile(file),bytes);
 }
 const invalid=Buffer.from('<html>\u0000</html>');await assert.rejects(savePluginArtifact({suggested_name:'bad.html',media_type:'text/html',base64:invalid.toString('base64'),sha256:createHash('sha256').update(invalid).digest('hex')},{check(){},choose:async()=>{throw Error('错误文件不应进入选择');}}));
});

test('字幕派生格式保存中文多行原字节，伪类型和非法UTF-8在选择前拒绝',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hetu-subtitle-files-'));
 const samples=[['captions.srt','application/x-subrip','1\n00:00:00,000 --> 00:00:01,000\n雨港来信\n第二行\n'],['captions.vtt','text/vtt','WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n雨港来信\n'],['captions.ass','text/x-ssa','[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,雨港来信\n']] as const;
 for(const [name,type,text] of samples){
  const bytes=Buffer.from(text),file=path.join(root,name),payload={suggested_name:name,media_type:type,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};let choices=0;
  const context={check(){},choose:async()=>{choices++;return file;}};
  assert.equal((await savePluginArtifact(payload,context)).saved,true);assert.deepEqual(await readFile(file),bytes);
  for(const wrong of [Buffer.from('不是此格式'),Buffer.from(text+'\u0000'),Buffer.concat([bytes,Buffer.from([255])])])await assert.rejects(savePluginArtifact({...payload,base64:wrong.toString('base64'),sha256:createHash('sha256').update(wrong).digest('hex')},context));
  await assert.rejects(savePluginArtifact({...payload,suggested_name:name+'.html'},context));assert.equal(choices,1);assert.deepEqual(await readFile(file),bytes);
  assert.deepEqual(await savePluginArtifact(payload,{check(){},choose:async()=>undefined}),{saved:false,cancelled:true});
 }
});
