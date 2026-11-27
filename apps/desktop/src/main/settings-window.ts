import { BrowserWindow, screen, type IpcMainInvokeEvent } from "electron";
import {windowChromeOptions, trackWindowChrome} from "./window-chrome.ts";

/** 设置拥有独立窗口；精确核对窗口、主frame和URL，不扩大工作台作者通道。 */
export class SettingsWindow {
  #window?: BrowserWindow;
  readonly url: string;
  constructor(private preload: string, appUrl: string) {
    const url = new URL(appUrl); url.hostname = "settings"; url.search = "?view=settings";
    this.url = url.toString();
  }
  accepts(event: IpcMainInvokeEvent, channel: string) {
    return ["desktop:settings", "desktop:settings-agent", "desktop:settings-window", "desktop:install-connection", "desktop:install-suite", "desktop:models", "desktop:copy", "desktop:fonts", "desktop:interface-scale"].includes(channel)
      && this.#window?.webContents === event.sender
      && event.senderFrame === event.sender.mainFrame
      && event.senderFrame?.url === this.url;
  }
  async open(parent: BrowserWindow) {
    if (this.#window && !this.#window.isDestroyed()) {
      if (this.#window.isMinimized()) this.#window.restore();
      this.#window.show(); this.#window.focus(); return;
    }
    const bounds = parent.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
    const view = new BrowserWindow({
      ...windowChromeOptions,
      width, height,
      x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
      minWidth: Math.min(520, area.width), minHeight: Math.min(460, area.height),
      title: "设置", parent, show: false, minimizable: false, maximizable: true, fullscreenable: true,
      webPreferences: { preload: this.preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    trackWindowChrome(view);
    this.#window = view;
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", event => event.preventDefault());
    view.webContents.on("will-redirect", event => event.preventDefault());
    view.on("closed", () => { if (this.#window === view) this.#window = undefined; });
    await view.loadURL(this.url);
    if (!view.isDestroyed()) view.show();
  }
  preferences(value: unknown) { this.#window?.webContents.send("desktop:preferences", value); }
  close() { this.#window?.close(); }
  get window() { return this.#window; }
}
