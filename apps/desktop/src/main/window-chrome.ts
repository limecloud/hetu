import type {BrowserWindow, BrowserWindowConstructorOptions} from "electron";

/** 系统按钮由原生窗口拥有，Web层只接收当前占位和缩放。 */
export const windowChromeOptions: BrowserWindowConstructorOptions = process.platform === "darwin"
  ? {titleBarStyle: "hiddenInset", trafficLightPosition: {x: 20, y: 20}}
  : {};

export function updateWindowChrome(window: BrowserWindow) {
  if (window.isDestroyed()) return;
  const inset = process.platform === "darwin" && !window.isFullScreen();
  const scale = window.webContents.getZoomFactor();
  if (inset) window.setWindowButtonPosition({x: 20, y: Math.round((52 * scale - 14) / 2)});
  window.webContents.send("desktop:window-chrome", {inset, scale});
}

export function trackWindowChrome(window: BrowserWindow) {
  const update = () => updateWindowChrome(window);
  window.webContents.on("did-finish-load", update);
  window.on("enter-full-screen", update);
  window.on("leave-full-screen", update);
}
