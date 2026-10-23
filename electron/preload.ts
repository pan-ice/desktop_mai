import { contextBridge, ipcRenderer } from "electron";
import type { ApiResult, DesktopApi, Snapshot } from "../shared/types";

async function invoke<T>(command: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(
    "mai:command",
    command,
    ...args,
  )) as ApiResult<T>;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const api: DesktopApi = {
  snapshot: () => invoke("snapshot"),
  subscribe: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, state: Snapshot) =>
      callback(state);
    ipcRenderer.on("mai:state", handler);
    return () => ipcRenderer.removeListener("mai:state", handler);
  },
  onNavigate: (callback) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      page: Parameters<typeof callback>[0],
    ) => callback(page);
    ipcRenderer.on("mai:page", handler);
    return () => ipcRenderer.removeListener("mai:page", handler);
  },
  onWindowHidden: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("mai:window-hidden", handler);
    return () => ipcRenderer.removeListener("mai:window-hidden", handler);
  },
  updateSettings: (patch) => invoke("updateSettings", patch),
  setCredential: (key, value) => invoke("setCredential", key, value),
  connect: () => invoke("connect"),
  exportAdapterConfig: () => invoke("exportAdapterConfig"),
  exportMessageAdapterConfig: () => invoke("exportMessageAdapterConfig"),
  importServerConnection: () => invoke("importServerConnection"),
  importServerCertificate: (serverUrl) =>
    invoke("importServerCertificate", serverUrl),
  removeServerCertificate: (serverUrl) =>
    invoke("removeServerCertificate", serverUrl),
  prepareLocalServer: () => invoke("prepareLocalServer"),
  beginQQLogin: (server, device) => invoke("beginQQLogin", server, device),
  pollQQLogin: () => invoke("pollQQLogin"),
  cancelQQLogin: () => invoke("cancelQQLogin"),
  serverAccounts: () => invoke("serverAccounts"),
  createServerAccount: (name) => invoke("createServerAccount", name),
  selectServerAccount: (id) => invoke("selectServerAccount", id),
  removeServerAccount: (id) => invoke("removeServerAccount", id),
  serverDevices: () => invoke("serverDevices"),
  revokeServerDevice: (id) => invoke("revokeServerDevice", id),
  loadEarlierHistory: () => invoke("loadEarlierHistory"),
  disconnect: () => invoke("disconnect"),
  send: (input) => invoke("send", input),
  clearHistory: () => invoke("clearHistory"),
  exportHistory: () => invoke("exportHistory"),
  importModel: (source) => invoke("importModel", source),
  importLive2DCore: () => invoke("importLive2DCore"),
  downloadLive2DCore: (runtime) => invoke("downloadLive2DCore", runtime),
  removeModel: (id) => invoke("removeModel", id),
  screenSources: () => invoke("screenSources"),
  captureScreen: (id) => invoke("captureScreen", id),
  transcribe: (data, mime) => invoke("transcribe", data, mime),
  synthesize: (text) => invoke("synthesize", text),
  importVoice: (audio) => invoke("importVoice", audio),
  cloneVoice: (input) => invoke("cloneVoice", input),
  queryVoice: (id) => invoke("queryVoice", id),
  setMood: (mood) => invoke("setMood", mood),
  voiceConversation: (active) => invoke("voiceConversation", active),
  setVoiceInput: (phase) => invoke("setVoiceInput", phase),
  reportPlayback: (report) => ipcRenderer.send("mai:playback-report", report),
  onPlayback: (callback) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      value: Parameters<typeof callback>[0],
    ) => callback(value);
    ipcRenderer.on("mai:playback", handler);
    return () => ipcRenderer.removeListener("mai:playback", handler);
  },
  stopPlayback: () => ipcRenderer.send("mai:stop-playback"),
  onStopPlayback: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, id: string | null) =>
      callback(id);
    ipcRenderer.on("mai:stop-playback", handler);
    return () => ipcRenderer.removeListener("mai:stop-playback", handler);
  },
  focus: (minutes) => invoke("focus", minutes),
  showPet: () => invoke("showPet"),
  showDashboard: (page) => invoke("showDashboard", page),
  hideWindow: () => invoke("hideWindow"),
  petDrag: (action) => ipcRenderer.send("mai:drag", action),
  openDataFolder: () => invoke("openDataFolder"),
  quit: () => invoke("quit"),
};
contextBridge.exposeInMainWorld("mai", api);
