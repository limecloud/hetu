import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,chmod,mkdir} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {runnableCommand,executableCandidates} from "../src/main/agent/command-resolution.ts";
import {resolveCodexCommand} from "../src/main/agent/codex-command.ts";

test("失效shebang不冒充已安装CLI，跳过旧入口找到可运行版本",async()=>{
 if(process.platform==="win32")return;
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-command-")),old=path.join(folder,"old"),current=path.join(folder,"current");await mkdir(old);await mkdir(current);
 const broken=path.join(old,"codex"),valid=path.join(current,"codex");await writeFile(broken,"#!/no-such-hetu-interpreter/bin/node\n");await writeFile(valid,"#!/bin/sh\nexit 0\n");await chmod(broken,0o755);await chmod(valid,0o755);
 assert.equal(await runnableCommand(broken),false);assert.equal(await runnableCommand(valid),true);assert.equal(await runnableCommand(old),false);
 const previousPath=process.env.PATH,previousOverride=process.env.HETU_CODEX_BIN;
 try{process.env.PATH=[old,current].join(path.delimiter);delete process.env.HETU_CODEX_BIN;assert.equal((await resolveCodexCommand()).binary,valid);process.env.HETU_CODEX_BIN=broken;await assert.rejects(resolveCodexCommand(),/未找到可执行/);}
 finally{process.env.PATH=previousPath;if(previousOverride===undefined)delete process.env.HETU_CODEX_BIN;else process.env.HETU_CODEX_BIN=previousOverride;}
});
test("Windows既有可执行扩展名和绝对路径保持原值，不添加第二个exe",()=>{
 assert.deepEqual(executableCandidates("powershell.exe",["C:\\Windows"],"win32"),["C:\\Windows\\powershell.exe"]);
 assert.deepEqual(executableCandidates("codex",["C:\\tools"],"win32"),["C:\\tools\\codex.exe","C:\\tools\\codex.cmd"]);
 assert.deepEqual(executableCandidates("C:\\custom\\agent.cmd",["C:\\tools"],"win32"),["C:\\custom\\agent.cmd"]);
});
