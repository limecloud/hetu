import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,stat} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {preparePtyHelpers} from "../scripts/pty-helper.mjs";

test("Linux源码编译布局无需不存在的prebuild，实际helper变为可执行",async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-pty-helper-")),directory=path.join(folder,"build/Release"),file=path.join(directory,"spawn-helper");
 await mkdir(directory,{recursive:true});await writeFile(file,"fixture",{mode:0o644});
 assert.deepEqual(await preparePtyHelpers(folder,"linux","x64"),[file]);assert.equal((await stat(file)).mode&0o111,0o111);
});
test("匹配当前架构的预构建可用，缺失原生helper明确失败，Windows不依赖Unix文件",async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),"hetu-pty-prebuild-")),directory=path.join(folder,"prebuilds/darwin-arm64"),file=path.join(directory,"spawn-helper");
 await mkdir(directory,{recursive:true});await writeFile(file,"fixture",{mode:0o644});
 assert.deepEqual(await preparePtyHelpers(folder,"darwin","arm64"),[file]);
 await assert.rejects(preparePtyHelpers(folder,"linux","x64"),/缺少当前平台/);assert.deepEqual(await preparePtyHelpers(folder,"win32","x64"),[]);
});
