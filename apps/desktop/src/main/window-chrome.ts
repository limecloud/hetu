import type {BrowserWindow, BrowserWindowConstructorOptions} from "electron";

/** 系统按钮由原生窗口拥有，Web层只接收当前占位和缩放。 */
export const windowChromeOptions: BrowserWindowConstructorOptions = process.platform === "darwin"
  ? {titleBarStyle: "hiddenInset", trafficLightPosition: {x: 20, y: 20}}
  : {};

export function isWindowFullscreen(window: BrowserWindow) {
  return window.isFullScreen() || window.isSimpleFullScreen();
}
const titlebarHeights=new WeakMap<BrowserWindow,number>();
export function setWindowTitlebarHeight(window:BrowserWindow,height:36|52){titlebarHeights.set(window,height);updateWindowChrome(window);}
const fullscreenTransitions=new WeakMap<BrowserWindow,Promise<boolean>>();
/** 原生全屏在macOS异步完成；串行等待，避免同时进入两种全屏状态。 */
export async function setWindowFullscreen(window:BrowserWindow,enabled:boolean){
  const previous=fullscreenTransitions.get(window);
  const transition=(previous??Promise.resolve()).catch(()=>{}).then(async()=>{
    if(window.isDestroyed())throw new Error("窗口已关闭。");
    if(window.isSimpleFullScreen())window.setSimpleFullScreen(enabled);
    else if(window.isFullScreen()!==enabled){
      await new Promise<void>(resolve=>{
        const entered=()=>{if(enabled)done();},left=()=>{if(!enabled)done();};
        const done=()=>{clearTimeout(timer);window.removeListener("enter-full-screen",entered);window.removeListener("leave-full-screen",left);window.removeListener("closed",done);resolve();};
        const timer=setTimeout(()=>{
          // 仅无原生完成信号且状态仍未改变时，使用宿主支持的简单全屏。
          if(!window.isDestroyed()&&process.platform==="darwin"&&enabled&&!window.isFullScreen()){window.setFullScreen(false);window.setSimpleFullScreen(true);}
          done();
        },2000);
        window.once("enter-full-screen",entered);window.once("leave-full-screen",left);window.once("closed",done);window.setFullScreen(enabled);
        if(process.platform!=="darwin"&&isWindowFullscreen(window)===enabled)done();
      });
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    if(window.isDestroyed())throw new Error("窗口已关闭。");
    updateWindowChrome(window);
    if(isWindowFullscreen(window)!==enabled)throw new Error("窗口全屏切换未完成，请从显示菜单重新核对。");
    return enabled;
  });
  fullscreenTransitions.set(window,transition);
  try{return await transition;}finally{if(fullscreenTransitions.get(window)===transition)fullscreenTransitions.delete(window);}
}

export function updateWindowChrome(window: BrowserWindow, fullscreen = isWindowFullscreen(window)) {
  if (window.isDestroyed()) return;
  const inset = process.platform === "darwin" && !fullscreen;
  const scale = window.webContents.getZoomFactor();
  const height=titlebarHeights.get(window)??52;
  if (inset) window.setWindowButtonPosition({x: height===36?16:20, y: Math.round((height * scale - 14) / 2)});
  window.webContents.send("desktop:window-chrome", {inset, scale,fullscreen});
}

export function trackWindowChrome(window: BrowserWindow) {
  const update = () => updateWindowChrome(window);
  const settle = () => {
    update();
    // macOS may report the fullscreen transition before its simple-fullscreen
    // state has settled. Re-read after the native transition so the renderer
    // cannot remain in the old title-bar mode.
    setImmediate(update);
    setTimeout(update, 120).unref();
  };
  window.webContents.on("did-finish-load", update);
  window.on("resize", update);
  window.on("enter-full-screen", () => updateWindowChrome(window, true));
  window.on("leave-full-screen", settle);
  // Native fullscreen APIs can complete without emitting a transition event
  // on some macOS window configurations. Keep the renderer projection tied to
  // the actual BrowserWindow state until the window closes.
  const monitor = setInterval(update, 250);
  monitor.unref();
  window.once("closed", () => clearInterval(monitor));
}
