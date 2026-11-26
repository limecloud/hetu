import http from "node:http";
import {appendFileSync,readFileSync,writeFileSync,watchFile,unwatchFile} from "node:fs";
import path from "node:path";
import WebSocket,{WebSocketServer} from "ws";

const [directory,...args]=process.argv.slice(2);
const {first,second}=JSON.parse(readFileSync(path.join(directory,"threads.json"),"utf8"));
const control=path.join(directory,"control"),stage=path.join(directory,"stage"),log=path.join(directory,"protocol.jsonl");
const idle=()=>process.stdout.write("\u001b]7501;state=idle:app=codex\u0007");

if(args[0]==="resume"){
 const endpoint=args[args.indexOf("--remote")+1],peer=new WebSocket("ws+unix://"+endpoint.slice(7)+":/");
 let next=10,buffer="";
 peer.on("open",()=>peer.send(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"fixture-terminal",version:"1"}}})));
 peer.on("message",raw=>{
  const message=JSON.parse(raw.toString());
  if(message.id===1)peer.send(JSON.stringify({id:2,method:"thread/resume",params:{threadId:first}}));
  else if(message.result?.thread||message.error)idle();
 });
 peer.on("error",()=>process.exit(1));peer.on("close",()=>process.exit(0));
 process.stdin.setRawMode?.(true);
 process.stdin.on("data",data=>{
  buffer+=data.toString();let end;
  while((end=buffer.search(/[\r\n]/))!==-1){
   const command=buffer.slice(0,end);buffer=buffer.slice(end+1);
   if(command==="native-new")peer.send(JSON.stringify({id:++next,method:"thread/start",params:{}}));
   else if(command==="native-old")peer.send(JSON.stringify({id:++next,method:"thread/resume",params:{threadId:first}}));
   else if(command==="native-second")peer.send(JSON.stringify({id:++next,method:"thread/resume",params:{threadId:second}}));
  }
 });
}else{
 const server=http.createServer(),peers=new WebSocketServer({server});server.listen(args[args.indexOf("--listen")+1].slice(7));
 peers.on("connection",peer=>{
  let client="";
  peer.on("message",raw=>{
   const message=JSON.parse(raw.toString());if(message.id===undefined)return;
   if(message.method==="initialize")client=message.params?.clientInfo?.name??"";
   appendFileSync(log,JSON.stringify({client,method:message.method})+"\n");
   const send=result=>peer.send(JSON.stringify({id:message.id,result}));
   if(message.method==="account/read")send({account:null,requiresOpenaiAuth:false});
   else if(message.method==="config/read")send({config:{}});
   else if(message.method==="thread/start")send({thread:{id:client==="fixture-terminal"?second:first,turns:[]}});
   else if(["thread/resume","thread/read"].includes(message.method)){
    const thread={id:message.params.threadId,turns:[]};
    if(client!=="fixture-terminal"&&message.method==="thread/resume"&&thread.id===second){
     writeFileSync(stage,"held");
     const release=()=>{
      const mode=readFileSync(control,"utf8");if(!["release","reject"].includes(mode))return;
      unwatchFile(control,release);
      if(mode==="reject")peer.send(JSON.stringify({id:message.id,error:{code:-32000,message:"隔离线程恢复被拒绝"}}));
      else send({thread});
     };
     watchFile(control,{interval:10},release);release();
    }else send({thread});
   }else send({});
  });
 });
}
