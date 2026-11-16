import { contextBridge, ipcRenderer } from "electron";
const closeHandlers = new Set<() => void | Promise<void>>();
ipcRenderer.on("plugin:flush", async (_event, token: string) => {
  try {
    for (const handler of closeHandlers) await handler();
    ipcRenderer.send("plugin:flush-result", token, null);
  } catch {
    ipcRenderer.send("plugin:flush-result", token, "恢复稿未完成，请保留当前窗口后重试。");
  }
});
contextBridge.exposeInMainWorld(
  "hetu",
  Object.freeze({
    context: () => ipcRenderer.invoke("plugin:context"),
    buffer: (...args: unknown[]) =>
      ipcRenderer.invoke("plugin:buffer", ...args),
    onBeforeClose: (callback: () => void | Promise<void>) => {
      closeHandlers.add(callback);
      return () => closeHandlers.delete(callback);
    },
    request: (action: string, input: unknown) =>
      ipcRenderer.invoke("plugin:request", action, input),
    invoke: (action: string, input: unknown) =>
      ipcRenderer.invoke("plugin:invoke", action, input),
    host: (action: string, input: unknown) => ipcRenderer.invoke("plugin:host", action, input),
    onPreferences: (callback: (value: unknown) => void) => {
      const listener = (_event: unknown, value: unknown) => callback(value);
      ipcRenderer.on("plugin:preferences", listener);
      return () => ipcRenderer.removeListener("plugin:preferences", listener);
    },
  }),
);
