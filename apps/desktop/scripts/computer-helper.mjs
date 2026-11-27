import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdir} from "node:fs/promises";
import path from "node:path";

/** 随桌面制品编译原生观察适配器，不改变本机系统权限。 */
export async function buildComputerHelper(desktop){
  if(process.platform!=="darwin")return;
  const architecture={arm64:"arm64",x64:"x86_64"}[process.arch];
  if(!architecture)throw Error("原生电脑观察尚未支持当前macOS架构。");
  const directory=path.join(desktop,"dist/native");await mkdir(directory,{recursive:true});
  await promisify(execFile)("/usr/bin/xcrun",["swiftc","-parse-as-library","-O","-target",architecture+"-apple-macos14.0","-module-name","HetuComputerObservation","-o",path.join(directory,"hetu-computer"),...['computer-helper.swift','computer-actions.swift'].map(file=>path.join(desktop,"native",file))],{timeout:120000,maxBuffer:1024*1024});
}
