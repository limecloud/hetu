import { contextBridge, ipcRenderer } from "electron";
const invoke =
  (name: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld(
  "hetuDesktop",
  Object.freeze({
    open: invoke("desktop:open"),
    state: invoke("desktop:state"),
    select: invoke("desktop:select"),
    read: invoke("desktop:read"),
    versions: invoke("desktop:versions"),
    migrations: invoke("desktop:migrations"),
    dirty: invoke("desktop:dirty"),
    buffer: invoke("desktop:buffer"),
    tasks: invoke("desktop:tasks"),
    author: invoke("desktop:author"),
    management: invoke("desktop:management"),
    settings: invoke("desktop:settings"),
    workAgent: invoke("desktop:work-agent"),
    models: invoke("desktop:models"),
    covers: invoke("desktop:covers"),
    novel: invoke("desktop:novel"),
    canon: invoke("desktop:canon"),
    zoom: invoke("desktop:zoom"),
    onSettingsRequested: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on("desktop:open-settings", handler);
      return () => ipcRenderer.removeListener("desktop:open-settings", handler);
    },
    onPreferences: (listener: (value: unknown) => void) => {
      const handler = (_event: unknown, value: unknown) => listener(value);
      ipcRenderer.on("desktop:preferences", handler);
      return () => ipcRenderer.removeListener("desktop:preferences", handler);
    },
    resources: invoke("desktop:resources"),
    media: invoke("desktop:media"),
    library: invoke("desktop:library"),
    connection: invoke("desktop:connection"),
    copy: invoke("desktop:copy"),
    handoff: invoke("desktop:handoff"),
    install: invoke("desktop:install"),
    toggle: invoke("desktop:toggle"),
    uninstall: invoke("desktop:uninstall"),
    bounds: invoke("desktop:surface-bounds"),
    closeSurface: invoke("desktop:close-surface"),
    view: invoke("desktop:view"),
    browser: invoke("desktop:browser"),
    fallback: invoke("desktop:fallback"),
  }),
);
