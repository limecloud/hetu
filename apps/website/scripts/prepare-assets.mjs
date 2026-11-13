import { mkdir,copyFile,cp,rm } from 'node:fs/promises';
const repo=new URL('../../../',import.meta.url);const out=new URL('../public/',import.meta.url);
await mkdir(new URL('brand/',out),{recursive:true});await mkdir(new URL('images/',out),{recursive:true});
await cp(new URL('assets/brand/icons/web/',repo),new URL('brand/',out),{recursive:true});
for(const name of ['app-icon-1024.png','mascot-master.png','river-seal.svg'])await copyFile(new URL('assets/brand/'+name,repo),new URL('brand/'+name,out));
await cp(new URL('assets/marketing/',repo),new URL('images/',out),{recursive:true});
// 首页原型复用原生书库与工作台插画，不复制另一份原型页面。
await cp(new URL('assets/illustrations/library/',repo),new URL('images/library/',out),{recursive:true});
await mkdir(new URL('resources/brand/',out),{recursive:true});
for(const name of ['mascot-master.png','icon-overview.png','icon-overview-en.png','wordmark.png','wordmark-en.png','wordmark-dark.png','wordmark-en-dark.png'])await copyFile(new URL('assets/brand/'+name,repo),new URL('resources/brand/'+name,out));
await copyFile(new URL('assets/brand/icons/macos/Hetu.icns',repo),new URL('resources/brand/Hetu.icns',out));
await copyFile(new URL('assets/brand/icons/windows/hetu.ico',repo),new URL('resources/brand/hetu.ico',out));
await copyFile(new URL('assets/manifest.json',repo),new URL('resources/manifest.json',out));
// 仅清理构建生成的旧文档副本；工程规范不属于网站发布资源。
await rm(new URL('sources/',out),{recursive:true,force:true});
await rm(new URL('prototype/',out),{recursive:true,force:true});
console.log('品牌与原生插画已同步；交互原型仅在首页，工程文档不参与发布。');
