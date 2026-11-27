import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,chmod,mkdir} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {runnableCommand,executableCandidates} from "../src/main/agent/command-resolution.ts";
import {resolveCodexCommand} from "../src/main/agent/codex-command.ts";
import {spawnSync} from "node:child_process";
import {readLoginShellEnvironment} from "../src/main/agent/shell-environment.ts";

async function failedShell(folder:string){
 const shell=path.join(folder,"shell");await writeFile(shell,"#!/bin/sh\nexit 1\n");await chmod(shell,0o755);return shell;
}

test("Finder最小PATH仍能发现Bun全局安装并执行Codex",async(context)=>{
 if(process.platform!=="darwin")return;
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-bun-command-")),bin=path.join(folder,".bun/bin");
 await mkdir(bin,{recursive:true});
 const binary=path.join(bin,"codex");await writeFile(binary,"#!/usr/bin/env node\nconsole.log('codex-bun-probe');\n");await chmod(binary,0o755);
 context.mock.method(os,"homedir",()=>folder);
 const previousPath=process.env.PATH,previousOverride=process.env.HETU_CODEX_BIN,previousShell=process.env.SHELL,previousBun=process.env.BUN_INSTALL;
 try{
  process.env.PATH="/usr/bin:/bin:/usr/sbin:/sbin";delete process.env.HETU_CODEX_BIN;delete process.env.BUN_INSTALL;process.env.SHELL=await failedShell(folder);
  const command=await resolveCodexCommand(path.dirname(process.execPath));
  assert.equal(command.binary,binary);
  const result=spawnSync(command.binary,["--version"],{env:command.env,encoding:"utf8"});
  assert.equal(result.status,0);assert.equal(result.stdout.trim(),"codex-bun-probe");
 }finally{process.env.PATH=previousPath;if(previousOverride===undefined)delete process.env.HETU_CODEX_BIN;else process.env.HETU_CODEX_BIN=previousOverride;if(previousShell===undefined)delete process.env.SHELL;else process.env.SHELL=previousShell;if(previousBun===undefined)delete process.env.BUN_INSTALL;else process.env.BUN_INSTALL=previousBun;}
});

test("失效shebang不冒充已安装CLI，跳过旧入口找到可运行版本",async()=>{
 if(process.platform==="win32")return;
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-command-")),old=path.join(folder,"old"),current=path.join(folder,"current");await mkdir(old);await mkdir(current);
 const broken=path.join(old,"codex"),valid=path.join(current,"codex");await writeFile(broken,"#!/no-such-hetu-interpreter/bin/node\n");await writeFile(valid,"#!/bin/sh\nexit 0\n");await chmod(broken,0o755);await chmod(valid,0o755);
 assert.equal(await runnableCommand(broken),false);assert.equal(await runnableCommand(valid),true);assert.equal(await runnableCommand(old),false);
 const previousPath=process.env.PATH,previousOverride=process.env.HETU_CODEX_BIN,previousShell=process.env.SHELL;
 try{process.env.SHELL=await failedShell(folder);process.env.PATH=[old,current].join(path.delimiter);delete process.env.HETU_CODEX_BIN;assert.equal((await resolveCodexCommand()).binary,valid);process.env.HETU_CODEX_BIN=broken;await assert.rejects(resolveCodexCommand(),/未找到可执行/);}
 finally{process.env.PATH=previousPath;if(previousOverride===undefined)delete process.env.HETU_CODEX_BIN;else process.env.HETU_CODEX_BIN=previousOverride;if(previousShell===undefined)delete process.env.SHELL;else process.env.SHELL=previousShell;}
});

test("登录Shell的自定义安装优先、并发只探测一次，刷新后发现新路径",async(context)=>{
 if(process.platform==="win32")return;
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-shell-path-")),first=path.join(folder,"自定义 安装"),next=path.join(folder,"更新后"),inherited=path.join(folder,"old");
 for(const bin of [first,next,inherited]){await mkdir(bin);await writeFile(path.join(bin,"codex"),"#!/bin/sh\nexit 0\n");await chmod(path.join(bin,"codex"),0o755);}
 const shell=path.join(folder,"shell"),counter=path.join(folder,"count"),configuration=path.join(folder,"path");
 await writeFile(configuration,first);
 await writeFile(shell,"#!/bin/sh\n[ \"$1\" = '-ilc' ] || exit 2\nprintf 'probe\\n' >> '"+counter+"'\nprintf '启动提示，不属于PATH\\n'\nprintf '\\0HETU_ENGINE_PATH\\0'\n/bin/cat '"+configuration+"'\nprintf '\\n\\0HETU_ENGINE_MISE\\0mise-state\\n\\0HETU_ENGINE_END\\0'\nprintf '退出提示\\n'\n");await chmod(shell,0o755);
 context.mock.method(os,"homedir",()=>folder);
 const previous={PATH:process.env.PATH,SHELL:process.env.SHELL,HETU_CODEX_BIN:process.env.HETU_CODEX_BIN};
 try{
  process.env.PATH=inherited;process.env.SHELL=shell;delete process.env.HETU_CODEX_BIN;
  const commands=await Promise.all([resolveCodexCommand(),resolveCodexCommand(),resolveCodexCommand()]);
  assert.ok(commands.every(command=>command.binary===path.join(first,"codex")));
  assert.equal(commands[0].env.__MISE_DIFF,"mise-state");assert.equal(process.env.PATH,inherited);
  const {readFile}=await import("node:fs/promises");assert.equal((await readFile(counter,"utf8")).trim(),"probe");
  await writeFile(configuration,next);await readLoginShellEnvironment(true);
  assert.equal((await resolveCodexCommand()).binary,path.join(next,"codex"));
 }finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test("登录Shell挂起或输出超限时有界结束，仍使用已继承的可执行入口",async(context)=>{
 if(process.platform==="win32")return;
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-shell-fallback-")),binary=path.join(folder,"codex"),shell=path.join(folder,"shell");
 await writeFile(binary,"#!/bin/sh\nexit 0\n");await chmod(binary,0o755);
 context.mock.method(os,"homedir",()=>folder);
 const previous={PATH:process.env.PATH,SHELL:process.env.SHELL,HETU_CODEX_BIN:process.env.HETU_CODEX_BIN};
 try{
  process.env.PATH=folder;process.env.SHELL=shell;delete process.env.HETU_CODEX_BIN;
  await writeFile(shell,"#!/bin/sh\ntrap '' TERM\n/bin/sleep 30\n");await chmod(shell,0o755);
  const started=Date.now();assert.equal((await resolveCodexCommand()).binary,binary);assert.ok(Date.now()-started<10000);
  await writeFile(shell,"#!/bin/sh\nwhile :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n'; done\n");
  await readLoginShellEnvironment(true);assert.equal((await resolveCodexCommand()).binary,binary);
 }finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
test("Windows既有可执行扩展名和绝对路径保持原值，不添加第二个exe",()=>{
 assert.deepEqual(executableCandidates("powershell.exe",["C:\\Windows"],"win32"),["C:\\Windows\\powershell.exe"]);
 assert.deepEqual(executableCandidates("codex",["C:\\tools"],"win32"),["C:\\tools\\codex.exe","C:\\tools\\codex.cmd"]);
 assert.deepEqual(executableCandidates("C:\\custom\\agent.cmd",["C:\\tools"],"win32"),["C:\\custom\\agent.cmd"]);
});
