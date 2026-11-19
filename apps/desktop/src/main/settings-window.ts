import { BrowserWindow, type IpcMainInvokeEvent } from "electron";

/** 设置拥有独立窗口；精确核对窗口、主frame和URL，不扩大工作台作者通道。 */
export class SettingsWindow {
  #window?: BrowserWindow;
  readonly url: string;
  constructor(private preload: string, appUrl: string) {
    this.url = appUrl + "?view=settings";
  }
  accepts(event: IpcMainInvokeEvent, channel: string) {
    return ["desktop:settings", "desktop:settings-agent", "desktop:settings-window", "desktop:install-connection", "desktop:install-suite", "desktop:models", "desktop:copy"].includes(channel)
      && this.#window?.webContents === event.sender
      && event.senderFrame === event.sender.mainFrame
      && event.senderFrame?.url === this.url;
  }
  async open(parent: BrowserWindow) {
    if (this.#window && !this.#window.isDestroyed()) {
      if (this.#window.isMinimized()) this.#window.restore();
      this.#window.show(); this.#window.focus(); return;
    }
    const view = new BrowserWindow({
      width: 660, height: 588, useContentSize: true, minWidth: 520, minHeight: 460,
      title: "设置", parent, show: false, minimizable: false, maximizable: false, fullscreenable: false,
      webPreferences: { preload: this.preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
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
