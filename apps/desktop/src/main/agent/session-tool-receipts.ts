import {constants} from "node:fs";
import {open} from "node:fs/promises";
import path from "node:path";
import type {AgentTool} from "../../agent-session-contract.ts";

/** 读取原会话中继的完整回执；引用仍须由Core核验。 */
export async function readSessionToolReceipts(directory:string):Promise<AgentTool[]>{
 let file;
 try{file=await open(path.join(directory,"receipts.json"),constants.O_RDONLY|constants.O_NOFOLLOW);}
 catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw Error("原会话成果回执无法安全读取。");}
 try{
  const metadata=await file.stat();
  if(!metadata.isFile()||metadata.nlink!==1||metadata.size>2_000_000)throw Error("成果回执不是有界普通文件。");
  const text=await file.readFile("utf8");if(Buffer.byteLength(text)>2_000_000)throw Error("成果回执超过预算。");
  const tools=JSON.parse(text);
  if(!Array.isArray(tools)||tools.length>64||tools.some(tool=>!tool||typeof tool.id!=="string"||typeof tool.turn_id!=="string"||tool.kind!=="mcp"||tool.server!=="hetu"||typeof tool.title!=="string"||!["completed","failed","running","unknown"].includes(tool.state)||typeof tool.output!=="string"||Buffer.byteLength(tool.output)>128_000))throw Error("原会话成果回执无效。");
  return tools;
 }finally{await file.close();}
}
