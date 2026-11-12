import { mkdir,copyFile,cp,readFile,writeFile,rm } from 'node:fs/promises';
const repo=new URL('../../../',import.meta.url);const out=new URL('../public/',import.meta.url);
await mkdir(new URL('brand/',out),{recursive:true});await mkdir(new URL('images/',out),{recursive:true});
await cp(new URL('assets/brand/icons/web/',repo),new URL('brand/',out),{recursive:true});
for(const name of ['app-icon-1024.png','mascot-master.png','river-seal.svg'])await copyFile(new URL('assets/brand/'+name,repo),new URL('brand/'+name,out));
await cp(new URL('assets/marketing/',repo),new URL('images/',out),{recursive:true});
await mkdir(new URL('resources/brand/',out),{recursive:true});
for(const name of ['mascot-master.png','icon-overview.png','icon-overview-en.png'])await copyFile(new URL('assets/brand/'+name,repo),new URL('resources/brand/'+name,out));
await copyFile(new URL('assets/brand/icons/macos/Hetu.icns',repo),new URL('resources/brand/Hetu.icns',out));
await copyFile(new URL('assets/brand/icons/windows/hetu.ico',repo),new URL('resources/brand/hetu.ico',out));
await copyFile(new URL('assets/manifest.json',repo),new URL('resources/manifest.json',out));
// 仅清理构建生成的旧文档副本；工程规范不属于网站发布资源。
await rm(new URL('sources/',out),{recursive:true,force:true});
// 原型与品牌资源共用仓库权威源，构建时投影公开资源，不手工双写。
const prototype=new URL('prototype/',out);await mkdir(prototype,{recursive:true});
for(const name of ['index.html','workbench.html','workbench.js','styles.css']){
 let value=await readFile(new URL('design/'+name,repo),'utf8');
 value=value.replaceAll('../assets/brand/app-icon-1024.png','/brand/app-icon-1024.png')
  .replaceAll('../assets/brand/icons/web/favicon.ico','/brand/favicon.ico')
  .replaceAll('../assets/brand/mascot-master.png','/brand/mascot-master.png')
  .replaceAll('../assets/brand/icon-overview.png','/resources/brand/icon-overview.png')
  .replaceAll('../assets/marketing/','/images/')
  .replaceAll('../assets/manifest.json','/resources/manifest.json')
  .replaceAll('../docs/32-品牌视觉与原型规范.md','/brand/')
  .replaceAll('../docs/README.md','/docs/')
  .replaceAll('../README.md','/')
  .replaceAll('href="website.html"','href="/"')
  .replace(/\.\.\/output\/imagegen\/([^" ]+)\.png/g,'/images/$1.webp');
 await writeFile(new URL(name,prototype),value);
}
console.log('品牌、宣传图与交互原型已从 Monorepo 共享来源同步，工程文档不参与发布。');
