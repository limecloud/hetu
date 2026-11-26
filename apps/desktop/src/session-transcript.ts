import type {AgentTool,SessionMessage,SessionSnapshot} from "./agent-session-contract.ts";

export type TranscriptEntry={key:string;sequence:number;turn?:string}&({kind:"message";message:SessionMessage}|{kind:"tool";tool:AgentTool});
/** 原生项身份与本机顺序只组织会话投影，不据此推导业务保存。 */
export function sessionTranscript(snapshot:Pick<SessionSnapshot,"messages"|"tools">):TranscriptEntry[]{
 const messages:TranscriptEntry[]=snapshot.messages.map((message,index)=>({kind:"message",message,key:"message:"+(message.item_id??message.id??`${message.turn_id??"legacy"}:${message.at}:${index}`),sequence:message.sequence??index+1,turn:message.turn_id}));
 const tools:TranscriptEntry[]=(snapshot.tools??[]).map((tool,index)=>({kind:"tool",tool,key:"tool:"+tool.id,sequence:tool.sequence??messages.length+index+1,turn:tool.turn_id}));
 return [...messages,...tools].sort((a,b)=>a.sequence-b.sequence);
}
export function toolDuration(tool:AgentTool){
 const duration=tool.duration_ms??(tool.started_at&&tool.completed_at?Date.parse(tool.completed_at)-Date.parse(tool.started_at):undefined);
 if(duration===undefined||!Number.isFinite(duration)||duration<0)return;
 return duration<1000?`${Math.round(duration)} ms`:`${(duration/1000).toFixed(1)} s`;
}
export function shouldSendKey(event:{key:string;shiftKey:boolean;metaKey:boolean;ctrlKey:boolean;altKey:boolean;repeat:boolean;isComposing:boolean},enterSends:boolean){
 return event.key==="Enter"&&!event.isComposing&&!event.repeat&&!event.shiftKey&&!event.altKey&&(event.metaKey||event.ctrlKey||enterSends);
}
