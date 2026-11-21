import { contextBridge, ipcRenderer } from "electron";
const invoke =
  (name: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(name, ...args).catch((error: Error) => {
      const message = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
      throw new Error(message);
    });
contextBridge.exposeInMainWorld(
  "hetuDesktop",
  Object.freeze({
    windowControls: Object.freeze({zoom: true, interfaceScale: true, titlebarInset: process.platform === "darwin"}),
    onWindowChrome: (listener: (value: {inset: boolean; scale: number}) => void) => {
      const handler = (_event: unknown, value: {inset: boolean; scale: number}) => listener(value);
      ipcRenderer.on("desktop:window-chrome", handler);
      return () => ipcRenderer.removeListener("desktop:window-chrome", handler);
    },
    open: invoke("desktop:open"),
    state: invoke("desktop:state"),
    select: invoke("desktop:select"),
    read: invoke("desktop:read"),
    versions: invoke("desktop:versions"),
    migrations: invoke("desktop:migrations"),
    dirty: invoke("desktop:dirty"),
    buffer: invoke("desktop:buffer"),
    execution: invoke("desktop:execution"),
    tasks: invoke("desktop:tasks"),
    author: invoke("desktop:author"),
    management: invoke("desktop:management"),
    settings: invoke("desktop:settings"),
    readingState: invoke("desktop:reading-state"),
    fonts: invoke("desktop:fonts"),
    interfaceScale: invoke("desktop:interface-scale"),
    onInterfaceScale: (listener: (value: number) => void) => {
      const handler = (_event: unknown, value: number) => listener(value);
      ipcRenderer.on("desktop:interface-scale", handler);
      return () => ipcRenderer.removeListener("desktop:interface-scale", handler);
    },
    settingsWindow: invoke("desktop:settings-window"),
    settingsAgent: invoke("desktop:settings-agent"),
    workAgent: invoke("desktop:work-agent"),
    models: invoke("desktop:models"),
    covers: invoke("desktop:covers"),
    novel: invoke("desktop:novel"),
    canon: invoke("desktop:canon"),
    zoom: invoke("desktop:zoom"),
    onPreferences: (listener: (value: unknown) => void) => {
      const handler = (_event: unknown, value: unknown) => listener(value);
      ipcRenderer.on("desktop:preferences", handler);
      return () => ipcRenderer.removeListener("desktop:preferences", handler);
    },
    onOpenDocument: (listener: (value: unknown) => void) => {
      const handler = (_event: unknown, value: unknown) => listener(value);
      ipcRenderer.on("desktop:open-document", handler);
      return () => ipcRenderer.removeListener("desktop:open-document", handler);
    },
    onPluginsChanged: (listener: (value: unknown) => void) => {
      const handler = (_event: unknown, value: unknown) => listener(value);
      ipcRenderer.on("desktop:plugins-changed", handler);
      return () => ipcRenderer.removeListener("desktop:plugins-changed", handler);
    },
    onClosePlugin: (listener: (value: unknown) => void) => {
      const handler = (_event: unknown, value: unknown) => listener(value);
      ipcRenderer.on("desktop:close-plugin", handler);
      return () => ipcRenderer.removeListener("desktop:close-plugin", handler);
    },
    onOpenWork: (listener: (value: unknown) => void) => {
      const handler = (_event: unknown, value: unknown) => listener(value);
      ipcRenderer.on("desktop:open-work", handler);
      return () => ipcRenderer.removeListener("desktop:open-work", handler);
    },
    resources: invoke("desktop:resources"),
    media: invoke("desktop:media"),
    video: invoke("desktop:video"),
    outlines: invoke("desktop:outlines"),
    library: invoke("desktop:library"),
    connection: invoke("desktop:connection"),
    installConnection: invoke("desktop:install-connection"),
    installSuite: invoke("desktop:install-suite"),
    copy: invoke("desktop:copy"),
    paste: invoke("desktop:paste"),
    handoff: invoke("desktop:handoff"),
    install: invoke("desktop:install"),
    toggle: invoke("desktop:toggle"),
    uninstall: invoke("desktop:uninstall"),
    bounds: invoke("desktop:surface-bounds"),
    closeSurface: invoke("desktop:close-surface"),
    view: invoke("desktop:view"),
    fallback: invoke("desktop:fallback"),
  }),
);
