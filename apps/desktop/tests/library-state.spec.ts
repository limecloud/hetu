import {test,expect} from "@playwright/test";
import {mkdtemp,mkdir,readFile,writeFile,symlink,realpath} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {CreativeLibrary} from "../src/main/library.ts";
import {RecoveryStore} from "../src/main/recovery.ts";

test("旧登记和符号链接规范到同一位置，重开刷新不重复作品", async () => {
 const folder=await mkdtemp(path.join(tmpdir(),"hetu-library-alias-")),directory=path.join(folder,"work"),alias=path.join(folder,"alias"),file=path.join(folder,"library.json");
 await mkdir(directory);await symlink(directory,alias);
 const work={work_ref:{workspace_id:"workspace_alias",kind:"novel" as const,object_id:"novel_alias"},title:"同一作品"};
 await writeFile(file,JSON.stringify({schema_version:1,roots:[{path:alias,workspace_id:work.work_ref.workspace_id,works:[work]},{path:directory,workspace_id:work.work_ref.workspace_id,works:[work]}]}));
 const library=new CreativeLibrary(file,new RecoveryStore(),async()=>[work]);await library.load();await library.refresh([]);
 expect(library.rows()).toHaveLength(1);expect(library.resolve(work.work_ref)).toBe(await realpath(directory));
 expect(JSON.parse(await readFile(file,"utf8")).roots).toHaveLength(1);
});

test("桌面与MCP两份创作库实例刷新和同时登记不会覆盖彼此的新作品",async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),"hetu-shared-library-")),file=path.join(folder,"profile/creative-library.json");
 const paths=[path.join(folder,"一"),path.join(folder,"二"),path.join(folder,"三")];
 await Promise.all(paths.map(directory=>mkdir(directory)));
 const works=paths.map((directory,index)=>({work_ref:{workspace_id:"workspace_"+index,kind:"novel" as const,object_id:"novel_"+index},title:"作品"+index}));
 const read=async(directory:string)=>[works[paths.findIndex(item=>path.basename(item)===path.basename(directory))]];
 const desktop=new CreativeLibrary(file,new RecoveryStore(),read),app=new CreativeLibrary(file,new RecoveryStore(),read);
 await Promise.all([desktop.load(),app.load()]);
 await Promise.all([desktop.register(paths[0],[works[0]]),app.register(paths[1],[works[1]])]);
 await desktop.refresh([]);
 expect(desktop.rows().map(work=>work.title).sort()).toEqual(["作品0","作品1"]);
 await app.register(paths[2],[works[2]]);
 await desktop.refresh([]);
 expect(desktop.rows().map(work=>work.title).sort()).toEqual(["作品0","作品1","作品2"]);
 expect(JSON.parse(await readFile(file,"utf8")).roots).toHaveLength(3);
});

test("创作库最多四路读取，完成顺序不改目录，错误和身份变化仅影响对应作品",async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),"hetu-library-bounded-")),file=path.join(folder,"profile/creative-library.json");
 const paths=Array.from({length:7},(_,index)=>path.join(folder,String(index)));
 await Promise.all(paths.map(directory=>mkdir(directory)));
 const works=paths.map((_,index)=>({work_ref:{workspace_id:"workspace_"+index,kind:"novel" as const,object_id:"novel_"+index},title:"作品"+index}));
 let active=0,maximum=0;
 const library=new CreativeLibrary(file,new RecoveryStore(),async directory=>{
  const index=Number(path.basename(directory));maximum=Math.max(maximum,++active);
  try{
   await new Promise(resolve=>setTimeout(resolve,(7-index)*5));
   if(index===5)throw new Error("位置无法读取");
   return index===2?[works[1]]:[works[index]];
  }finally{active--;}
 });
 for(const [index,directory] of paths.entries())await library.register(directory,[works[index]]);
 await library.refresh([]);
 expect(maximum).toBe(4);
 expect(library.rows().map(row=>row.title)).toEqual(works.map(row=>row.title));
 expect(library.rows().filter(row=>row.unavailable).map(row=>row.title)).toEqual(["作品2","作品5"]);
 expect(library.rows()[2].error).toContain("身份已变化");
 expect(library.rows()[5].error).toBe("位置无法读取");
 expect(JSON.parse(await readFile(file,"utf8")).roots.map((row:any)=>row.works[0].work_ref)).toEqual(works.map(row=>row.work_ref));
});
