import path from "node:path";
import {writeFile,readFile,lstat} from "node:fs/promises";
import {createHash} from "node:crypto";
import type {TerminalBinding} from "../../shared/codex-terminal.ts";

export type ExternalMachineCommand={command:string;args:string[]};
const directoryNames=["HETU_LOCAL_SETTINGS_DIR","HETU_COLLABORATION_DIR","HETU_PLUGIN_STATE_DIR","HETU_PLUGIN_ACCESS_DIR","HETU_INTEGRATIONS_DIR"] as const;
const systemNames=["PATH","Path","PATHEXT","HOME","USERPROFILE","USER","LOGNAME","TMPDIR","TMP","TEMP","SystemRoot","WINDIR","COMSPEC","LANG","LC_ALL","XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_STATE_HOME","APPDATA","LOCALAPPDATA"] as const;

/** 共享外部进程只获得本会话机器连接；不借用gateway的环境或复制登录凭据。 */
export async function prepareExternalMachineBridge(input:{directory:string;node:string;mcp:string;cli:string;client:string;binding:TerminalBinding;source:NodeJS.ProcessEnv}){
  if(![input.node,input.mcp,input.cli,input.directory].every(path.isAbsolute))throw Error("河图会话机器入口需要已发现的绝对程序路径。");
  const env:Record<string,string>={};
  for(const name of [...systemNames,...directoryNames]){
    const value=input.source[name];if(value===undefined)continue;
    if(typeof value!=="string"||value.includes("\0")||Buffer.byteLength(value)>32768)throw Error("河图会话机器环境无效或超过预算。");
    if(directoryNames.includes(name as any)&&!path.isAbsolute(value))throw Error("河图会话设置目录必须是绝对路径。");env[name]=value;
  }
  env.HETU_PLUGIN_NODE=input.node;
  if(Buffer.byteLength(JSON.stringify(env))>65536)throw Error("河图会话机器环境超过预算。");
  const execution=["--collaboration-dir",input.binding.accessDirectory];
  const settings={env,cwd:input.directory,mcp:input.mcp,cli:input.cli,mcpArgs:["--client",input.client,...execution,...(input.binding.workRef?["--work-ref",JSON.stringify(input.binding.workRef)]:[])],cliArgs:["--client",input.client,...execution]};
  const source=`// 河图固定会话机器入口；生成自当前可信连接，不读取外部gateway环境。\nimport {spawn} from 'node:child_process';\nconst fixed=${JSON.stringify(settings)};\nconst [mode,...args]=process.argv.slice(2);\nif(!['mcp','cli'].includes(mode)||mode==='mcp'&&args.length){process.stderr.write('河图会话机器动作无效。\\n');process.exit(2);}\nconst help=mode==='cli'&&args.length===1&&['--help','-h','--version'].includes(args[0]);\nconst child=spawn(mode==='mcp'?fixed.mcp:fixed.cli,[...(help?[]:mode==='mcp'?fixed.mcpArgs:fixed.cliArgs),...args],{cwd:fixed.cwd,env:fixed.env,stdio:'inherit',shell:false,windowsHide:true});\nlet timer;\nfor(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>{child.kill(signal);timer??=setTimeout(()=>child.kill('SIGKILL'),1500);});\nchild.on('error',()=>{clearTimeout(timer);process.stderr.write('河图固定机器入口无法启动。\\n');process.exitCode=2;});\nchild.on('exit',(code,signal)=>{clearTimeout(timer);process.exitCode=code??(signal?1:0);});\n`;
  const file=path.join(input.directory,".hetu-machine-"+createHash("sha256").update(source).digest("hex")+".mjs");
  try{await writeFile(file,source,{mode:0o600,flag:"wx"});}
  catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>128*1024||await readFile(file,"utf8")!==source)throw Error("河图会话机器入口内容已变化，未覆盖原文件。");}
  return {mcp:{command:input.node,args:[file,"mcp"]},cli:{command:input.node,args:[file,"cli"]}};
}
