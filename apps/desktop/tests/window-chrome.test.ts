import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import type {BrowserWindow} from "electron";
import {setWindowFullscreen,setWindowTitlebarHeight,updateWindowChrome} from "../src/main/window-chrome.ts";

class Window extends EventEmitter {
  native=false;simple=false;requests:boolean[]=[];simpleRequests:boolean[]=[];buttons?:{x:number;y:number};messages:any[]=[];
  isDestroyed(){return false;}isFullScreen(){return this.native;}isSimpleFullScreen(){return this.simple;}
  setSimpleFullScreen(value:boolean){this.simpleRequests.push(value);this.simple=value;}
  setFullScreen(value:boolean){this.requests.push(value);setTimeout(()=>{this.native=value;this.emit(value?"enter-full-screen":"leave-full-screen");},15);}
  setWindowButtonPosition(value:{x:number;y:number}){this.buttons=value;}
  webContents={getZoomFactor:()=>1,send:(_channel:string,value:any)=>{this.messages.push(value);}};
  get view(){return this as unknown as BrowserWindow;}
}
test("异步进入和退出全屏串行完成，不同时激活简单全屏",async()=>{
  const window=new Window();const entering=setWindowFullscreen(window.view,true),leaving=setWindowFullscreen(window.view,false);
  assert.equal(await entering,true);assert.equal(await leaving,false);
  assert.deepEqual(window.requests,[true,false]);assert.deepEqual(window.simpleRequests,[]);assert.equal(window.native,false);assert.equal(window.messages.at(-1).fullscreen,false);
});
test("单行终端标题栏与原页面各自恢复原生按钮位置",()=>{
  const window=new Window();updateWindowChrome(window.view);const original=window.buttons;
  setWindowTitlebarHeight(window.view,36);
  if(process.platform==="darwin")assert.deepEqual(window.buttons,{x:16,y:11});
  setWindowTitlebarHeight(window.view,52);assert.deepEqual(window.buttons,original);
});
