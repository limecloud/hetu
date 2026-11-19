import {test,expect} from "@playwright/test";
import {mkdtemp,mkdir,readFile} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {CreativeLibrary} from "../src/main/library.ts";
import {RecoveryStore} from "../src/main/recovery.ts";

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
