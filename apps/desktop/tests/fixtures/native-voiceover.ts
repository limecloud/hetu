import {execFileSync} from "node:child_process";
import {expect} from "@playwright/test";
import {nativeImeInput} from "./native-ime.ts";

type ReaderProcess={name:string;pid:number;bundle:string;executable:string};
const readerBundle="com.apple.VoiceOver",welcomeBundle="com.apple.VoiceOverQuickstart";
const script=(source:string)=>execFileSync("osascript",["-e",source],{encoding:"utf8",timeout:5000}).trim();

export class NativeVoiceOver {
 readonly audit:{initial:ReaderProcess[];observations:ReaderProcess[][];startup:unknown[];captions:unknown[];readings:{expected:string[];source:string;sample:number}[];started:boolean;restored:boolean;script_permissions_changed:false}={initial:[],observations:[],startup:[],captions:[],readings:[],started:false,restored:false,script_permissions_changed:false};
 private owned=new Set<number>();
 private helper:string;
 constructor(private targetPID:number,private diagnostics:string){
  if(process.platform!=="darwin")throw Error("真实VoiceOver验收只在macOS运行。");
  this.helper=process.env.HETU_VOICEOVER_CAPTION_HELPER??"";
  if(!this.helper)throw Error("先编译只读字幕探针并设置HETU_VOICEOVER_CAPTION_HELPER；未启动读屏。");
  this.audit.initial=this.processes();
  if(this.audit.initial.length)throw Error("已有VoiceOver相关进程，本测试不接管或关闭用户的读屏。");
 }
 private processes():ReaderProcess[]{
  // System Events顺次读取的进程可能中途退出，产生missing value；只读原生宿主目录。
  const rows=JSON.parse(execFileSync(this.helper,["--processes"],{encoding:"utf8",timeout:5000})) as ReaderProcess[];
  if(!Array.isArray(rows)||rows.some(row=>!Number.isSafeInteger(row.pid)||row.pid<2))throw Error("无法核对VoiceOver进程身份。");
  this.audit.observations.push(rows);return rows;
 }
 private welcomeAction(pid:number,action:"start"|"stop"){
  const titles=action==="start"?["使用旁白","Use VoiceOver"]:["关闭旁白","Turn Off VoiceOver"];
  return script(`tell application "System Events" to tell (first application process whose unix id is ${pid} and bundle identifier is "${welcomeBundle}")
if (count of windows) is 0 then return "pending"
if (count of windows) is not 1 then error "首次使用窗口不唯一"
${titles.map(title=>`if exists button "${title}" of window 1 then
click button "${title}" of window 1
return "handled"
end if`).join("\n")}
return "pending"
end tell`)==="handled";
 }
 async start(){
  if(this.processes().length)throw Error("读屏状态在启动前变化，未发送快捷键。");
  // open -a只会启动VoiceOverStarter；系统快捷键才进入真实reader／首次使用流程。
  this.audit.started=true;nativeImeInput(this.targetPID,"key code 96 using command down");
  let acceptedWelcome=false;
  await expect.poll(()=>{
   const rows=this.processes();
   if(rows.some(row=>!row.bundle||!row.executable))return false;
   if(rows.some(row=>![readerBundle,welcomeBundle].includes(row.bundle)))throw Error("出现非预期的VoiceOver宿主。");
   if(rows.filter(row=>row.executable.endsWith("/VoiceOver")).length>1||rows.filter(row=>row.bundle===welcomeBundle).length>1)throw Error("读屏进程不唯一。");
   rows.forEach(row=>this.owned.add(row.pid));
   const welcome=rows.find(row=>row.bundle===welcomeBundle);
   if(welcome){if(!acceptedWelcome)acceptedWelcome=this.welcomeAction(welcome.pid,"start");return false;}
   // Starter和reader具有相同bundle ID，须核对实际可执行文件，等待首次使用完成。
   if(rows.length!==1||rows[0].bundle!==readerBundle||!rows[0].executable.endsWith("/VoiceOver"))return false;
   // 真实reader也可能在欢迎窗口之前短暂出现；字幕实际输出后才算就绪。
   const native=JSON.parse(execFileSync(this.helper,[String(this.targetPID),String(rows[0].pid)],{encoding:"utf8",timeout:15000}));
   this.audit.startup.push(native);
   return native.frontmost_matches&&native.reader_matches&&native.captured_windows===1&&native.recognized_lines.length>0;
  },{timeout:15000}).toBe(true);
 }
 async read(expected:string[]){
  const matches=(result:any)=>{
   if(!result.frontmost_matches||!result.reader_matches||!result.screen_capture_permission||result.read_failures||result.candidate_windows!==1)return false;
   const text=(result.recognized_lines as string[]).join("").replace(/\s/g,"");
   return expected.every(word=>text.includes(word.replace(/\s/g,"")));
  };
  const inspect=(diagnostics:boolean)=>{
   const rows=this.processes(),reader=rows.find(row=>row.bundle===readerBundle);
   if(rows.length!==1||!reader||!this.owned.has(reader.pid))throw Error("读屏归属已改变。");
   const result=JSON.parse(execFileSync(this.helper,[String(this.targetPID),String(reader.pid),...(diagnostics?[this.diagnostics]:[])],{encoding:"utf8",timeout:15000}));
   this.audit.captions.push(result);return result;
  };
  // DOM焦点先于原生AX刷新；等待确切原生当前值后再请求系统朗读。
  let result:any;
  await expect.poll(()=>{
   const native=inspect(true),title=[native.target_focus?.title,native.target_focus?.description].filter(Boolean).join(" ");result=native;
   return native.frontmost_matches&&native.reader_matches&&expected.every(word=>title.includes(word));
  },{timeout:10000}).toBe(true);
  // 焦点变化已朗读当前值时保留该瞬时字幕；再发读取会使其被后续帮助提示覆盖。
  if(matches(result)){this.audit.readings.push({expected,source:"focus_announcement",sample:this.audit.captions.length-1});return result;}
  // 明确读当前键盘焦点，不把应用自身AX文字或reader启动当作朗读。
  nativeImeInput(this.targetPID,"key code 118 using {control down, option down}");
  await expect.poll(()=>{
   result=inspect(true);
   return matches(result);
  },{timeout:12000,intervals:[500,1000,2000]}).toBe(true);
  this.audit.readings.push({expected,source:"requested_keyboard_focus",sample:this.audit.captions.length-1});
  return result;
 }
 async restore(){
  if(!this.audit.started||this.audit.restored)return;
  const rows=this.processes();
  if(rows.some(row=>!this.owned.has(row.pid)))throw Error("读屏进程归属已变化，未切换未知实例。");
  const welcome=rows.find(row=>row.bundle===welcomeBundle);
  if(welcome)await expect.poll(()=>this.welcomeAction(welcome.pid,"stop"),{timeout:5000}).toBe(true);
  else if(rows.length===1&&rows[0].bundle===readerBundle)script('tell application "System Events" to key code 96 using command down');
  else if(rows.length)throw Error("无法核对读屏恢复状态。");
  await expect.poll(()=>this.processes(),{timeout:15000}).toEqual(this.audit.initial);
  this.audit.restored=true;
 }
}
