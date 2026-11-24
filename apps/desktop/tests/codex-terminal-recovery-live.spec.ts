import {createTerminal,switchAgentSurface} from "./navigation.ts";
import {test,expect,_electron as electron} from "@playwright/test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import os from "node:os";

const root=path.resolve(import.meta.dirname,"../../..");
test("真实终端客户端意外退出后重连原引擎，拒绝旧代次且不重复启动",async()=>{
  test.skip(process.env.HETU_LIVE_CODEX!=="1","需显式启用真实本机Codex验收");
  test.skip(process.platform==="win32","当前进程核验使用Unix进程树，Windows另行实测");
  test.setTimeout(120000);
  const profile=await mkdtemp(path.join(os.tmpdir(),"hetu-terminal-recovery-"));
  const executable=process.env.HETU_PACKAGED_APP;
  const env={...process.env,HETU_DESKTOP_PROFILE:profile,HETU_COLLABORATION_DIR:path.join(profile,"collaboration")};
  for(const key of ["HETU_APP_SERVER","HETU_CLI","HETU_MCP","HETU_PLUGIN_NODE","ELECTRON_RUN_AS_NODE"])delete (env as Record<string,string|undefined>)[key];
  const app=await electron.launch({...(executable?{executablePath:executable,args:[]}:{args:[path.join(root,"apps/desktop")]}),env:{...env,...(!executable?{HETU_APP_SERVER:path.join(root,"target/debug/hetu-app-server"),HETU_CLI:path.join(root,"target/debug/hetu"),HETU_MCP:path.join(root,"target/debug/hetu-mcp")}: {})}});
  const output=path.join(root,"output/codex-terminal-recovery");await mkdir(output,{recursive:true});
  try{
    const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});
    await expect(page.getByRole("button",{name:"刷新创作库",exact:true})).toBeEnabled({timeout:30000});
    await page.getByLabel("更多操作",{exact:true}).click();
    await page.getByRole("button",{name:"打开终端工作区",exact:true}).click();
    await createTerminal(page);
    const get=()=>page.evaluate(()=>window.hetuDesktop.agentSession("get",{scope:"library"}));
    await expect.poll(async()=>{const s=await get();return s.terminal_connected&&s.terminal_replay?.includes("]7501;state=idle");},{timeout:45000}).toBe(true);
    const before=await get();
    // 只返回当前隔离应用后代的PID，不输出其他进程参数或凭据。
    const processes=()=>app.evaluate((_,thread)=>{
      const rows=process.getBuiltinModule("node:child_process").execFileSync("ps",["-axo","pid=,ppid=,args="],{encoding:"utf8"}).split("\n").flatMap(line=>{
        const match=line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);return match?[{pid:Number(match[1]),parent:Number(match[2]),command:match[3]}]:[];
      });
      const children=new Set([process.pid]);let changed=true;
      while(changed){changed=false;for(const row of rows)if(children.has(row.parent)&&!children.has(row.pid)){children.add(row.pid);changed=true;}}
      const byPid=new Map(rows.map(row=>[row.pid,row]));
      // 已安装CLI可能有Node启动器；只计入对应进程链末端的原生执行端。
      const leaves=(match:(row:typeof rows[number])=>boolean)=>{
        const matches=rows.filter(row=>children.has(row.pid)&&match(row));
        return matches.filter(row=>!matches.some(other=>{let parent=other.parent;while(parent&&parent!==row.pid)parent=byPid.get(parent)?.parent??0;return parent===row.pid;})).map(row=>row.pid);
      };
      return {terminals:leaves(row=>/\bresume\s+--remote\s/.test(row.command)&&row.command.includes(thread)),engines:leaves(row=>/\bapp-server\b/.test(row.command)&&/--listen\s/.test(row.command))};
    },before.thread_id!);
    const original=await processes();expect(original.terminals).toHaveLength(1);expect(original.engines).toHaveLength(1);
    await app.evaluate((_,pid)=>process.kill(pid,"SIGTERM"),original.terminals[0]);
    await expect.poll(async()=>(await get()).terminal_connected).toBe(false);
    await expect(page.getByRole("alert").filter({hasText:"终端客户端已退出"})).toBeVisible();
    expect((await processes()).engines).toEqual(original.engines);
    await expect(page.getByRole("button",{name:"重新连接",exact:true})).toBeEnabled();
    // 使用公开宿主请求制造同一时刻的两次启动；UI与机器调用共用这条路径。
    const resumed=await page.evaluate(()=>Promise.all([window.hetuDesktop.agentSession("start",{scope:"library"}),window.hetuDesktop.agentSession("start",{scope:"library"})]));
    expect(resumed[0].generation).toBe(resumed[1].generation);
    await expect.poll(async()=>{const s=await get();return s.terminal_connected&&s.terminal_replay?.includes("]7501;state=idle");},{timeout:45000}).toBe(true);
    const after=await get();expect(after.thread_id).toBe(before.thread_id);expect(after.generation).toBeGreaterThan(before.generation!);
    await expect(page.getByRole("alert").filter({hasText:"终端客户端已退出"})).toHaveCount(0);
    const current=await processes();expect(current.engines).toEqual(original.engines);expect(current.terminals).toHaveLength(1);expect(current.terminals[0]).not.toBe(original.terminals[0]);
    const stale=await page.evaluate(async before=>{
      const failures:string[]=[];
      for(const [method,input] of [["terminal_input",{data:"stale-input"}],["terminal_resize",{cols:88,rows:24}]] as const){
        try{await window.hetuDesktop.agentSession(method,{scope:"library",session_id:before.session_id,generation:before.generation,...input});}
        catch(error){failures.push((error as Error).message);}
      }return failures;
    },before);
    expect(stale).toHaveLength(2);
    await page.evaluate(()=>{window.hetuDesktop.onAgentSession(event=>{if(event.type==="terminal"&&event.data==="STALE-TERMINAL-MARKER")(window as any).__staleTerminalDelivered=true;});});
    await app.evaluate(({BrowserWindow},snapshot)=>BrowserWindow.getAllWindows()[0].webContents.send("desktop:agent-session",{type:"terminal",session_id:snapshot.session_id,generation:snapshot.generation,sequence:(snapshot.terminal_sequence??0)+1,data:"STALE-TERMINAL-MARKER"}),before);
    await expect.poll(()=>page.evaluate(()=>(window as any).__staleTerminalDelivered)).toBe(true);
    await expect(page.locator(".xterm-accessibility-tree")).not.toContainText("STALE-TERMINAL-MARKER");
    expect(after.messages).toHaveLength(0);
    // 再核对受管引擎本身退出后的确切线程恢复，不发起模型请求。
    await app.evaluate((_,pid)=>process.kill(pid,"SIGTERM"),current.engines[0]);
    await expect.poll(async()=>(await get()).state).toBe("disconnected");
    await expect.poll(async()=>(await get()).terminal_connected).toBe(false);
    const disconnected=await get();
    const disconnectedInput=await page.evaluate(async snapshot=>{try{await window.hetuDesktop.agentSession("terminal_input",{scope:"library",session_id:snapshot.session_id,generation:snapshot.generation,data:"offline-input"});return "accepted";}catch(error){return (error as Error).message;}},disconnected);
    expect(disconnectedInput).toContain("连接已中断");
    await page.getByRole("button",{name:"重新连接",exact:true}).click();
    await expect.poll(async()=>{const s=await get();return s.terminal_connected&&s.terminal_replay?.includes("]7501;state=idle");},{timeout:45000}).toBe(true);
    const engineRestored=await get(),restarted=await processes();
    expect(engineRestored.thread_id).toBe(before.thread_id);expect(engineRestored.generation).toBeGreaterThan(after.generation!);expect(engineRestored.messages).toHaveLength(0);
    expect(restarted.engines).toHaveLength(1);expect(restarted.engines[0]).not.toBe(original.engines[0]);expect(restarted.terminals).toHaveLength(1);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({path:path.join(output,"reconnected-terminal.png")});
    let nativeGeometry:Record<string,unknown>|undefined;
    if(process.platform==="darwin"&&process.env.HETU_CAPTURE_NATIVE_WINDOWS==="1"){
      // 让测试视口与当前屏幕内的真实窗口及Retina像素比例一致。
      const nativeWindow=await app.evaluate(({BrowserWindow,screen})=>{const view=BrowserWindow.getAllWindows()[0],display=screen.getDisplayMatching(view.getBounds());view.setBounds(display.workArea);return {content:view.getContentBounds(),scale:display.scaleFactor};});
      const cdp=await page.context().newCDPSession(page);await cdp.send("Emulation.setDeviceMetricsOverride",{width:nativeWindow.content.width,height:nativeWindow.content.height,deviceScaleFactor:nativeWindow.scale,mobile:false});
      await page.evaluate(()=>window.dispatchEvent(new Event("resize")));
      await expect.poll(()=>page.locator(".codex-terminal").evaluate(element=>{const host=element.getBoundingClientRect(),screen=element.querySelector(".xterm-screen")!.getBoundingClientRect();return host.bottom<=innerHeight+1&&screen.bottom<=host.bottom+1&&screen.right<=host.right+1;})).toBe(true);
      nativeGeometry=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,terminal:document.querySelector(".codex-terminal")!.getBoundingClientRect().toJSON(),screen:document.querySelector(".xterm-screen")!.getBoundingClientRect().toJSON()}));
      expect(nativeGeometry.width).toBe(nativeWindow.content.width);expect(nativeGeometry.height).toBe(nativeWindow.content.height);expect(nativeGeometry.dpr).toBe(nativeWindow.scale);
      nativeGeometry.window=nativeWindow;
      await expect.poll(()=>page.locator(".codex-terminal canvas").evaluateAll(elements=>elements.filter(e=>e.getBoundingClientRect().width>10).every(e=>Math.abs((e as HTMLCanvasElement).width-e.getBoundingClientRect().width*devicePixelRatio)<3))).toBe(true);
      const id=await app.evaluate(({BrowserWindow})=>{const view=BrowserWindow.getAllWindows()[0];view.focus();return view.getMediaSourceId().split(":")[1];});
      const captured=spawnSync("/usr/sbin/screencapture",["-x","-o","-l",id,path.join(output,"reconnected-native-window.png")],{encoding:"utf8"});
      expect(captured.status,captured.stderr).toBe(0);
    }
    await writeFile(path.join(output,"result.json"),JSON.stringify({packaged:!!executable,thread_id:after.thread_id,before_generation:before.generation,after_generation:after.generation,engine_restored_generation:engineRestored.generation,original,current,restarted,stale_rejections:stale.length,messages:engineRestored.messages.length,nativeGeometry},null,2)+"\n");
  }catch(error){const page=app.windows()[0];await page?.screenshot({path:path.join(output,"failure.png"),timeout:5000}).catch(()=>{});throw error;}
  finally{await app.close();}
});
