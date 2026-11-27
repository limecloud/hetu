// 固定协议帧与独立进程夹具；不调用模型服务。
export const acp=`#!NODE
if(process.argv.includes('--version')){console.log('FIXTURE_VERSION');process.exit(0);}
const fs=require('node:fs'),readline=require('node:readline');const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');let prompt;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line);fs.appendFileSync(process.env.TEST_PROTOCOL_LOG,JSON.stringify(v)+'\\n');
 if(v.method==='initialize')return send({id:v.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,_meta:{antigravity:{systemPrompt:{append:true}}}}}});
 if(v.method==='session/new'||v.method==='session/load')return send({id:v.id,result:{sessionId:'session-fixed',models:{availableModels:[{modelId:'test-model',name:'测试模型'}]}}});
 if(v.method==='session/set_model')return send({id:v.id,result:{}});
 if(v.method==='session/prompt'){prompt=v.id;return send({id:'permission-fixed',method:'session/request_permission',params:{sessionId:'session-fixed',toolCall:{title:'固定工具'},options:[{optionId:'allow-once',name:'允许一次',kind:'allow_once'},{optionId:'reject-once',name:'拒绝',kind:'reject_once'}]}});}
 if(v.id==='permission-fixed'&&v.result){send({method:'session/update',params:{sessionId:'wrong',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'CROSS_SESSION'}}}});send({method:'session/update',params:{sessionId:'session-fixed',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP运行完成🌿'}}}});send({id:prompt,result:{stopReason:'end_turn'}});}
 if(v.method==='session/cancel')send({id:prompt,result:{stopReason:'cancelled'}});
});`;
export const claude=`#!NODE
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');const args=process.argv.slice(2),at=args.includes('--session-id')?args.indexOf('--session-id'):args.indexOf('--resume'),session=args[at+1];const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const directory=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-'));fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,session+'.jsonl'),JSON.stringify({type:'assistant',uuid:session,parentUuid:null,sessionId:session,cwd:process.cwd(),message:{role:'assistant',content:'Claude流式历史'}})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);fs.appendFileSync(process.env.TEST_PROTOCOL_LOG,JSON.stringify(v)+'\\n');
 if(v.type==='control_request'){send({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:v.request.subtype==='initialize'?{models:[{value:'test-model',displayName:'测试模型'}]}:{}}});if(v.request.subtype==='interrupt')send({type:'result',subtype:'success',session_id:session});return;}
 if(v.type==='user')return send({type:'control_request',request_id:'permission-fixed',request:{subtype:'can_use_tool',tool_name:'fixture',input:{fixed:true}}});
 if(v.type==='control_response'){send({type:'stream_event',session_id:session,event:{type:'message_start',message:{id:'answer-fixed'}}});send({type:'stream_event',session_id:session,event:{type:'content_block_delta',delta:{type:'text_delta',text:'Claude流式完成🌿'}}});send({type:'assistant',session_id:session,message:{id:'answer-fixed',content:[{type:'text',text:'Claude流式完成🌿'}]}});send({type:'result',subtype:'success',session_id:session});}
});`;
export const pi=`#!NODE
const fs=require('node:fs'),readline=require('node:readline');const args=process.argv.slice(2),file=args[args.indexOf('--session')+1];let running=false;const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');const reply=(v,data)=>send({id:v.id,type:'response',command:v.type,success:true,data});
readline.createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);fs.appendFileSync(process.env.TEST_PROTOCOL_LOG,JSON.stringify(v)+'\\n');
 if(v.type==='get_state')return reply(v,{sessionId:'pi-fixed',sessionFile:file,model:{id:'m',provider:'p'},isStreaming:running,isCompacting:false,pendingMessageCount:0});
 if(v.type==='get_available_models')return reply(v,{models:[{id:'m',provider:'p',name:'测试模型'}]});
 if(v.type==='get_messages')return reply(v,{messages:[{role:'assistant',content:'Pi原会话历史'}]});
 if(v.type==='set_model')return reply(v,{});
 if(v.type==='prompt'){running=true;reply(v,{});send({type:'message_start',message:{role:'assistant',content:[]}});send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Pi流式完成🌿'}});return send({type:'agent_end'});}
 if(v.type==='abort'){running=false;reply(v,{});return send({type:'agent_settled'});}
});`;

export const acpForm=acp.replace(/ if\(v\.method==='session\/prompt'\).*\n/,
 ` if(v.method==='session/prompt'){prompt=v.id;return send({id:'form-fixed',method:'elicitation/create',params:{sessionId:'session-fixed',message:'请选择这次审阅的重点。',requestedSchema:{type:'object',additionalProperties:false,required:['direction'],properties:{direction:{type:'string',title:'审阅重点',enum:['language','structure'],enumNames:['语言表达','叙事结构']},includeNotes:{type:'boolean',title:'保留作者意见'}}}}});}\n`)
 .replace("v.id==='permission-fixed'&&v.result","v.id==='form-fixed'&&v.result");

export const claudeQuestions=claude.replace("tool_name:'fixture',input:{fixed:true}","tool_name:'AskUserQuestion',input:{questions:[{header:'创作方向',question:'下一轮先处理哪个问题？',multiSelect:false,options:[{label:'人物动机',description:'核对角色选择的依据。'},{label:'叙事节奏',description:'检查分段与转场。'}]}]}");
