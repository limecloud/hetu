import React,{useEffect,useMemo,useRef,useState} from "react";
import type {SessionSnapshot} from "../agent-session-contract.ts";
import {CodexTerminal,type TerminalTransport} from "./codex-terminal.tsx";
import {TerminalWriteQueue} from "./external-terminal-write-queue.ts";

type Request=(input:Record<string,unknown>)=>Promise<any>;
const project=(value:any,output=value.output??""):SessionSnapshot=>({...value,messages:[],updated_at:new Date().toISOString(),terminal_replay:output});

/** 沿公开Bot会话读取同一PTY；原序列缺段交给既有TerminalStream回读，不另启进程。 */
export function BotTerminal({session,request,preferences,notify,enabled,registerFlush,toolbarTarget}:{session:any;request:Request;preferences:any;notify(message:string):void;enabled:boolean;registerFlush(value:(()=>Promise<void>)|undefined):void;toolbarTarget?:HTMLElement|null}){
  const [snapshot,setSnapshot]=useState(()=>project(session)),[readError,setReadError]=useState(false),latest=useRef(request),errors=useRef(notify);latest.current=request;errors.current=notify;
  const channel=useMemo(()=>{
    const writes=new TerminalWriteQueue(input=>latest.current(input),()=>setReadError(true));
    const read=async()=>{
      const first=await latest.current({method:"session_read",session_id:session.session_id,limit:8000});
      let text=first.output,next=first.next_offset,pages=1;
      while(next!==null&&next!==undefined){
        if(++pages>128)throw Error("终端回放超过读取预算，请核对原会话。");
        const page=await latest.current({method:"session_read",session_id:session.session_id,offset:next,limit:8000,expected_generation:first.generation,expected_sequence:first.terminal_sequence});
        if(page.next_offset!==null&&page.next_offset<=next)throw Error("终端回放游标没有推进。");text+=page.output;next=page.next_offset;
      }
      return project(first,text);
    };
    const transport:TerminalTransport={read,input:value=>writes.enqueue({method:"session_input",...value}),resize:value=>writes.enqueue({method:"session_resize",...value}),subscribe:listener=>{
      let active=true,timer:ReturnType<typeof setTimeout>,previous:SessionSnapshot|undefined;
      const poll=async()=>{
        try{
          const current=await read();if(!active)return;setSnapshot(current);
          if(!previous||current.generation!==previous.generation||current.terminal_sequence!==previous.terminal_sequence){
            const delta=previous&&current.generation===previous.generation&&current.terminal_replay!.startsWith(previous.terminal_replay!)?current.terminal_replay!.slice(previous.terminal_replay!.length):current.terminal_replay!;
            listener({type:"terminal",session_id:current.session_id!,generation:current.generation!,sequence:current.terminal_sequence!,data:delta});
          }
          previous=current;
        }catch(error){if(active){setReadError(true);errors.current((error as Error).message+" 请关闭重开原会话后核对。");}return;}
        if(active)timer=setTimeout(()=>void poll(),500);
      };
      void poll();return()=>{active=false;clearTimeout(timer);};
    }};return {transport,flush:()=>writes.flush()};
  },[session.session_id]);
  useEffect(()=>{registerFlush(channel.flush);return()=>registerFlush(undefined);},[channel]);
  return <div className="external-bot-terminal"><CodexTerminal snapshot={snapshot} transport={channel.transport} preferences={preferences} notify={notify} readOnly={!enabled||readError} toolbarTarget={toolbarTarget}/></div>;
}
