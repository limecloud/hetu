import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {CodexTerminal} from "../src/main/agent/codex-terminal.ts";

test("真实PTY保留中文、组合输入、多行粘贴和控制字节，调整尺寸后可退出重开",{timeout:15000},async()=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),"hetu-pty-transport-"));
  await writeFile(path.join(cwd,"resume"),`
    process.stdin.setRawMode(true);
    process.stdout.write("ARGS:"+JSON.stringify(process.argv.slice(2))+"\\r\\n");
    process.stdout.write("\\x1b]7501;state=idle\\x07READY\\r\\n");
    process.stdin.on("data",bytes=>{
      process.stdout.write("INPUT:"+bytes.toString("hex")+"\\r\\n");
      if(bytes.includes(3))process.stdout.write("INTERRUPTED\\r\\n");
      if(bytes.includes(4))process.exit(0);
    });
    process.on("SIGWINCH",()=>process.stdout.write("SIZE:"+process.stdout.columns+"x"+process.stdout.rows+"\\r\\n"));
  `);
  const terminal=new CodexTerminal();let text="",exits=0;const sequences:number[]=[];
  const until=async(predicate:()=>boolean)=>{const end=Date.now()+5000;while(!predicate()){assert(Date.now()<end,"未收到预期PTY字节："+text);await new Promise(resolve=>setTimeout(resolve,10));}};
  const start=()=>terminal.start({binary:process.execPath,endpoint:"transport-only",thread:"transport-only",cwd,env:process.env,onData:chunk=>{text+=chunk;sequences.push(terminal.sequence);},onExit:()=>{exits++;}});
  try{
    start();await until(()=>text.includes("READY"));await terminal.readyForInput();
    assert(text.includes('ARGS:["--remote","transport-only","transport-only","-c","check_for_update_on_startup=false"]'));
    const input="中文🙂e\u0301\u001b[200~第一行\n第二行\u001b[201~";
    terminal.write(input);await until(()=>text.includes(Buffer.from(input).toString("hex")));
    terminal.resize(84,27);await until(()=>text.includes("SIZE:84x27"));
    terminal.write("\u0003");await until(()=>text.includes("INTERRUPTED"));assert(terminal.connected);
    terminal.write("\u0004");await until(()=>!terminal.connected);assert.equal(exits,1);
    assert.deepEqual(sequences,sequences.map((_,index)=>index+1));assert.equal(terminal.replay,text);
    await assert.rejects(async()=>terminal.write("已退出"),/未连接/);
    text="";sequences.length=0;start();await until(()=>text.includes("READY"));assert(terminal.sequence>0);assert(!terminal.replay.includes("INPUT:"));
    assert.throws(()=>terminal.resize(1,0),/尺寸无效/);
  }finally{await terminal.close();}
});
