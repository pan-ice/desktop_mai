import { useSyncExternalStore } from "react";
import { emptySnapshot } from "../shared/defaults";
import type { DesktopApi, Page, Snapshot } from "../shared/types";

declare global {
  interface Window {
    mai?: DesktopApi;
  }
}

const unsupported = async (): Promise<never> => {
  throw new Error("此功能需要运行桌面应用，请使用 npm run dev 启动");
};

function previewApi(): DesktopApi {
  const local = emptySnapshot();
  try {
    const settings = localStorage.getItem("mai-preview-settings");
    if (settings) Object.assign(local.settings, JSON.parse(settings));
  } catch {
    /* 浏览器限制存储时仍可浏览界面。 */
  }
  const callbacks = new Set<(snapshot: Snapshot) => void>();
  const emit = () =>
    callbacks.forEach((callback) => callback(structuredClone(local)));
  return {
    snapshot: async () => structuredClone(local),
    subscribe: (callback) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    onNavigate: (callback) => {
      const handler = (event: Event) =>
        callback((event as CustomEvent<Page>).detail);
      window.addEventListener("mai:navigate", handler);
      return () => window.removeEventListener("mai:navigate", handler);
    },
    onWindowHidden: (callback) => {
      const handler = () => {
        if (document.hidden) callback();
      };
      document.addEventListener("visibilitychange", handler);
      return () => document.removeEventListener("visibilitychange", handler);
    },
    updateSettings: async (patch) => {
      Object.assign(local.settings, patch);
      localStorage.setItem(
        "mai-preview-settings",
        JSON.stringify(local.settings),
      );
      emit();
      return structuredClone(local);
    },
    setCredential: unsupported,
    connect: unsupported,
    exportAdapterConfig: unsupported,
    exportMessageAdapterConfig: unsupported,
    importServerConnection: unsupported,
    importServerCertificate: unsupported,
    removeServerCertificate: unsupported,
    prepareLocalServer: unsupported,
    beginQQLogin: unsupported,
    pollQQLogin: unsupported,
    cancelQQLogin: unsupported,
    serverAccounts: unsupported,
    createServerAccount: unsupported,
    selectServerAccount: unsupported,
    removeServerAccount: unsupported,
    serverDevices: unsupported,
    revokeServerDevice: unsupported,
    loadEarlierHistory: unsupported,
    disconnect: unsupported,
    send: unsupported,
    clearHistory: async () => {
      local.history = [];
      emit();
    },
    exportHistory: unsupported,
    importModel: unsupported,
    importLive2DCore: unsupported,
    downloadLive2DCore: unsupported,
    removeModel: unsupported,
    screenSources: unsupported,
    captureScreen: unsupported,
    transcribe: unsupported,
    synthesize: unsupported,
    importVoice: unsupported,
    cloneVoice: unsupported,
    queryVoice: unsupported,
    voiceConversation: unsupported,
    setVoiceInput: async (phase) => {
      local.voiceInput = phase;
      emit();
    },
    reportPlayback: () => {},
    onPlayback: () => () => {},
    stopPlayback: () => {},
    onStopPlayback: () => () => {},
    setMood: async (mood) => {
      local.mood = mood;
      emit();
    },
    focus: async (minutes) => {
      local.focusUntil = minutes ? Date.now() + minutes * 60000 : null;
      local.mood = minutes ? "sleeping" : "idle";
      emit();
    },
    showPet: unsupported,
    showDashboard: async (page?: Page) => {
      if (page)
        window.dispatchEvent(new CustomEvent("mai:navigate", { detail: page }));
    },
    hideWindow: unsupported,
    petDrag: () => {},
    openDataFolder: unsupported,
    quit: unsupported,
  };
}

export const api = window.mai ?? previewApi();
let current = emptySnapshot(Boolean(window.mai));
const subscribers = new Set<() => void>();
function accept(snapshot: Snapshot) {
  current = snapshot;
  subscribers.forEach((callback) => callback());
}
api.subscribe(accept);
void api
  .snapshot()
  .then(accept)
  .catch((error) => showToast(String(error), true));
export function useSnapshot() {
  return useSyncExternalStore(
    (callback) => {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    () => current,
  );
}

export function showToast(text: string, error = false) {
  window.dispatchEvent(
    new CustomEvent("mai:toast", { detail: { text, error } }),
  );
}
export async function perform(
  action: () => Promise<unknown>,
  success?: string,
): Promise<boolean> {
  try {
    await action();
    if (success) showToast(success);
    return true;
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true);
    return false;
  }
}
