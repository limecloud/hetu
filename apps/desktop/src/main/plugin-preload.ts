import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld(
  "hetu",
  Object.freeze({
    context: () => ipcRenderer.invoke("plugin:context"),
    buffer: (...args: unknown[]) =>
      ipcRenderer.invoke("plugin:buffer", ...args),
    request: (action: string, input: unknown) =>
      ipcRenderer.invoke("plugin:request", action, input),
    invoke: (action: string, input: unknown) =>
      ipcRenderer.invoke("plugin:invoke", action, input),
  }),
);
