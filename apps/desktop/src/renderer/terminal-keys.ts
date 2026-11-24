type Key=Pick<KeyboardEvent,"key"|"type"|"metaKey"|"ctrlKey"|"altKey"|"shiftKey"|"isComposing"|"keyCode">;

/** 显式修正宿主与原生TUI不同的编辑键，组合输入交回xterm。 */
export function terminalKeyInput(event:Key,mac:boolean):string|undefined {
  if(event.type!=="keydown"||event.isComposing||event.keyCode===229||["Dead","Process","Unidentified"].includes(event.key))return;
  const {key,metaKey:meta,ctrlKey:ctrl,altKey:alt,shiftKey:shift}=event;
  if(key==="Enter"&&!meta&&!ctrl&&!alt&&shift)return "\u001b[13;2u";
  if(key==="Enter"&&!meta&&!ctrl&&alt&&!shift)return "\u001b\r";
  if(key==="Enter"&&!meta&&ctrl&&!alt&&!shift)return "\u001b[13;5u";
  if(key==="Backspace"&&!meta&&ctrl&&!alt&&!shift)return "\u0017";
  if(mac&&meta&&!ctrl&&!alt&&!shift)return ({Backspace:"\u0015",Delete:"\u000b",ArrowLeft:"\u0001",ArrowRight:"\u0005"} as Record<string,string>)[key];
  if(!meta&&!ctrl&&alt&&!shift)return ({ArrowLeft:"\u001bb",ArrowRight:"\u001bf",Backspace:"\u001b\u007f"} as Record<string,string>)[key];
  if(!mac&&!meta&&ctrl&&!alt&&!shift)return ({ArrowLeft:"\u001bb",ArrowRight:"\u001bf"} as Record<string,string>)[key];
}
