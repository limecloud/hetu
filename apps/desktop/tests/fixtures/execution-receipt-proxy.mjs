import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {readFileSync,writeFileSync,renameSync} from "node:fs";

/** 隔离验收替换或暂扣指定计划的一次成功回执，领域执行仍来自原MCP。 */
export function proxyMcp({command,control,args}) {
 const child=spawn(command,args,{stdio:["pipe","pipe","inherit"]});
 const change=update=>{const value=JSON.parse(readFileSync(control,"utf8"));update(value);writeFileSync(control+".tmp",JSON.stringify(value),{mode:0o600});renameSync(control+".tmp",control);};
 createInterface({input:process.stdin}).on("line",line=>{
  const request=JSON.parse(line);
  if(request.method==="tools/call"){
   const params=request.params,argument=params.arguments??{},action=params.name==="hetu_call_action"?argument.action:({hetu_execute_plan:"hetu.execution.execute",hetu_read_execution_plan:"hetu.execution.get_plan"})[params.name],input=params.name==="hetu_call_action"?argument.input:argument;
   const id=input?.plan_ref?.plan_id;
   if(id&&["hetu.execution.execute","hetu.execution.get_plan"].includes(action))change(value=>{
    const key=action==="hetu.execution.execute"?"executions":"reads";value[key]??={};value[key][id]=(value[key][id]??0)+1;
    if(action==="hetu.execution.get_plan"&&value.used){value.reads_after_drop??={};value.reads_after_drop[id]=(value.reads_after_drop[id]??0)+1;}
   });
  }
  child.stdin.write(line+"\n");
 }).on("close",()=>child.stdin.end());
 createInterface({input:child.stdout}).on("line",line=>{
  const response=JSON.parse(line),receipt=response.result?.structuredContent;
  if(receipt?.action==="hetu.execution.execute"&&receipt.status==="succeeded"&&receipt.data?.state==="completed"){
   let drop=false,hold=false;
   change(value=>{
    const commands=receipt.data.fixed?.commands;
    if(value.enabled&&!value.used&&value.hold_operation_key&&commands?.length===1&&commands[0].input?.operation_key===value.hold_operation_key){
     value.used=true;value.held=true;value.held_receipt=receipt;value.completed_steps=receipt.data.results.length;value.plan_ref={plan_id:receipt.data.plan_id,sha256:receipt.data.sha256};hold=true;return;
    }
    if(value.enabled&&!value.used&&value.plan_ref?.plan_id===receipt.data.plan_id&&value.plan_ref?.sha256===receipt.data.sha256){value.used=true;value.completed_steps=receipt.data.results.length;drop=true;}
   });
   if(hold)return;
   if(drop){const fault={action:"hetu.execution.execute",status:"pending",error:{code:"transport_result_unknown",message:"隔离验收：执行回执丢失，结果未知。请查询原 plan_ref 的 get_plan 并回读领域对象，不重复提交或更换计划。"}};response.result={isError:true,structuredContent:fault,content:[{type:"text",text:JSON.stringify(fault)}]};line=JSON.stringify(response);}
  }
  process.stdout.write(line+"\n");
 });
 child.on("error",()=>process.exit(1));child.on("exit",code=>process.exit(code??1));
 process.on("SIGTERM",()=>{child.kill();process.exit(0);});
}
