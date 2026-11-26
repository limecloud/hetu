import http from "node:http";
import {readFileSync,appendFileSync,watchFile,unwatchFile} from "node:fs";
import path from "node:path";
import {WebSocketServer} from "ws";

const [directory,...args]=process.argv.slice(2),stateFile=path.join(directory,"identity.json"),log=path.join(directory,"protocol.jsonl");
const read=()=>JSON.parse(readFileSync(stateFile,"utf8"));
const server=http.createServer(),peers=new WebSocketServer({server});server.listen(args[args.indexOf("--listen")+1].slice(7));
let previous=read(),loggedIn=false;
const pending=[];
watchFile(stateFile,{interval:10},()=>{
 let current;try{current=read();}catch{return;}
 if(JSON.stringify(current)===JSON.stringify(previous))return;previous=current;
 for(const peer of peers.clients){
  peer.send(JSON.stringify({method:"account/updated",params:{authMode:current.account?.account?.type??null}}));
  if(loggedIn&&current.login_completed){loggedIn=false;peer.send(JSON.stringify({method:"account/login/completed",params:{loginId:"fixed-login",success:true}}));}
 }
 for(let index=pending.length-1;index>=0;index--)if(!current[pending[index].hold])pending.splice(index,1)[0].reply();
});
process.on("exit",()=>unwatchFile(stateFile));
peers.on("connection",peer=>peer.on("message",raw=>{
 const message=JSON.parse(raw.toString());if(message.id===undefined)return;
 appendFileSync(log,JSON.stringify({method:message.method})+"\n");
 const send=result=>peer.send(JSON.stringify({id:message.id,result})),state=read();
 if(message.method==="initialize"){
  if(state.early_account_update)peer.send(JSON.stringify({method:"account/updated",params:{authMode:state.account?.account?.type??null}}));
  send({codexHome:path.join(directory,"codex-home"),userAgent:"codex-cli fixture"});
 }
 else if(message.method==="account/read")state.read_failure?peer.send(JSON.stringify({id:message.id,error:{message:"private-source-detail-must-not-escape"}})):send(state.account);
 else if(message.method==="config/read"){
  const reply=()=>{send(state.configuration);if(read().late_completion)setTimeout(()=>peer.send(JSON.stringify({method:"turn/completed",params:{threadId:"identity-original-thread",turn:{id:"late-old-turn",status:"completed"}}})),10);};
  if(state.configuration_hold)pending.push({hold:"configuration_hold",reply});else reply();
 }
 else if(message.method==="account/login/start"){loggedIn=true;setTimeout(()=>send({type:"chatgpt",loginId:"fixed-login",authUrl:"https://auth.openai.com/authorize?state=private-test-login"}),state.login_delay_ms??0);}
 else if(message.method.startsWith("thread/")){
  const reply=()=>send({thread:{id:"identity-original-thread",turns:[]}});
  if(state.thread_hold)pending.push({hold:"thread_hold",reply});else reply();
 }
 else send({});
}));
