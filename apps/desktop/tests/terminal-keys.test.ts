import test from "node:test";
import assert from "node:assert/strict";
import {terminalKeyInput} from "../src/renderer/terminal-keys.ts";
const key=(key:string,options:Partial<KeyboardEvent>={})=>({type:"keydown",key,isComposing:false,keyCode:0,metaKey:false,ctrlKey:false,altKey:false,shiftKey:false,...options});
test("原生TUI换行与提交保持不同，行首行尾及按词编辑符合平台键位",()=>{
 assert.equal(terminalKeyInput(key("Enter",{shiftKey:true}),true),"\u001b[13;2u");
 assert.equal(terminalKeyInput(key("Enter"),true),undefined);
 assert.equal(terminalKeyInput(key("ArrowLeft",{metaKey:true}),true),"\u0001");
 assert.equal(terminalKeyInput(key("ArrowRight",{metaKey:true}),true),"\u0005");
 assert.equal(terminalKeyInput(key("Backspace",{metaKey:true}),true),"\u0015");
 assert.equal(terminalKeyInput(key("ArrowLeft",{altKey:true}),true),"\u001bb");
 assert.equal(terminalKeyInput(key("ArrowRight",{ctrlKey:true}),false),"\u001bf");
 assert.equal(terminalKeyInput(key("f",{ctrlKey:true}),true),undefined);
 assert.equal(terminalKeyInput(key("Backspace",{ctrlKey:true}),false),"\u0017");
});
test("输入法、死键及释放事件不被转换成终端命令",()=>{
 for(const event of [key("Enter",{shiftKey:true,isComposing:true}),key("Enter",{shiftKey:true,keyCode:229}),key("Dead",{altKey:true}),key("Enter",{shiftKey:true,type:"keyup"})])assert.equal(terminalKeyInput(event,true),undefined);
});
