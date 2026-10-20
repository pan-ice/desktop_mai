import type {
  AuthorizedDevice,
  PetAccount,
  QQLoginChallenge,
} from "./accounts";
import type { MessagePart } from "./message-content";
import type {
  ClonedVoice,
  TtsProfile,
  TtsProvider,
  VoiceCloneInput,
  VoiceImportInput,
} from "./tts";

export type ConnectionPhase =
  "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
export type Mood = "idle" | "happy" | "thinking" | "speaking" | "sleeping";
export type ModelKind = "image" | "pngtuber" | "live2d" | "vrm" | "mmd";
export const CREDENTIAL_KEYS = [
  "adapterToken",
  "serverToken",
  "speechKey",
  "ttsOpenaiKey",
  "ttsSiliconflowKey",
  "ttsBailianKey",
  "ttsMinimaxKey",
  "ttsVolcengineKey",
  "ttsMimoKey",
] as const;
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number];
export type Page = "home" | "chat" | "models" | "senses" | "core" | "settings";

export interface Settings {
  nickname: string;
  userName: string;
  userId: string;
  connectionMode: "local" | "server";
  serverUrl: string;
  serverAccountId: string;
  adapterPort: number;
  adapterScope: string;
  platform: string;
  botId: string;
  dashboardUrl: string;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  petVisible: boolean;
  petPositionLocked: boolean;
  petScale: number;
  reducedMotion: boolean;
  autoConnect: boolean;
  launchAtLogin: boolean;
  voiceEnabled: boolean;
  ttsEngine: "system" | "api";
  ttsProvider: TtsProvider;
  ttsNativeOutput: boolean;
  ttsNaturalSpeech: boolean;
  ttsPreloadNext: boolean;
  ttsCloneFidelity: boolean;
  ttsProfiles: Partial<Record<TtsProvider, TtsProfile>>;
  systemVoice: string;
  speechBaseUrl: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  speechRate: number;
  speechVolume: number;
  vadSensitivity: number;
  vadSilenceMs: number;
  screenEnabled: boolean;
  screenSourceId: string;
  screenObservationEnabled: boolean;
  screenObservationSeconds: number;
  screenObservationPrompt: string;
  proactiveEnabled: boolean;
  proactiveMinutes: number;
  proactivePrompt: string;
  quietStart: number;
  quietEnd: number;
  activeModelId: string | null;
  corePath: string;
}

export interface ImportedModel {
  id: string;
  name: string;
  kind: ModelKind;
  entry: string;
  talkingEntry?: string;
  coreEntry?: string;
  addedAt: number;
  assetUrl: string;
  talkingUrl?: string;
  coreUrl?: string;
}

export interface Attachment {
  type: "image" | "audio";
  dataUrl: string;
  name?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
  source: "text" | "voice" | "screen" | "proactive" | "core";
  attachments?: Attachment[];
  parts?: MessagePart[];
  delivery?: "sent" | "failed" | "unknown";
}

export interface Activity {
  id: string;
  level: "info" | "error";
  text: string;
  timestamp: number;
}

export interface ServerCertificateInfo {
  host: string;
  subject: string;
  issuer: string;
  fingerprint256: string;
  validFrom: number;
  validTo: number;
  certificateCount: number;
  importedAt: number;
}

export interface Snapshot {
  settings: Settings;
  credentials: Record<CredentialKey, boolean>;
  connection: {
    phase: ConnectionPhase;
    detail: string;
    since: number;
    sessionId?: string;
    protocol?: number;
    userId?: string;
    capabilities?: string[];
    transport?: "gateway" | "legacy";
  };
  history: ChatMessage[];
  historySync: {
    enabled: boolean;
    loading: boolean;
    hasMore: boolean;
    before: number | null;
  };
  removedServerAccounts: string[];
  serverCertificates: ServerCertificateInfo[];
  models: ImportedModel[];
  clonedVoices: ClonedVoice[];
  live2dCoreReady: boolean;
  live2dCoreDownloading: boolean;
  live2dCoreError: string;
  activity: Activity[];
  mood: Mood;
  focusUntil: number | null;
  conversationActive: boolean;
  desktop: boolean;
  version: string;
}

export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
}
export interface SendInput {
  text: string;
  source?: ChatMessage["source"];
  image?: string;
}
export type ApiResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

export interface DesktopApi {
  snapshot(): Promise<Snapshot>;
  subscribe(callback: (state: Snapshot) => void): () => void;
  onNavigate(callback: (page: Page) => void): () => void;
  updateSettings(patch: Partial<Settings>): Promise<Snapshot>;
  setCredential(key: CredentialKey, value: string): Promise<void>;
  connect(): Promise<void>;
  exportAdapterConfig(): Promise<boolean>;
  exportMessageAdapterConfig(): Promise<boolean>;
  importServerConnection(): Promise<boolean>;
  importServerCertificate(serverUrl: string): Promise<boolean>;
  removeServerCertificate(serverUrl: string): Promise<void>;
  prepareLocalServer(): Promise<string | null>;
  beginQQLogin(
    serverUrl: string,
    deviceName: string,
  ): Promise<QQLoginChallenge>;
  pollQQLogin(): Promise<"pending" | "confirmed" | "expired">;
  cancelQQLogin(): Promise<void>;
  serverAccounts(): Promise<PetAccount[]>;
  createServerAccount(name: string): Promise<PetAccount>;
  selectServerAccount(id: string): Promise<void>;
  removeServerAccount(id: string): Promise<void>;
  serverDevices(): Promise<AuthorizedDevice[]>;
  revokeServerDevice(id: string): Promise<void>;
  loadEarlierHistory(): Promise<void>;
  disconnect(): Promise<void>;
  send(input: SendInput): Promise<void>;
  clearHistory(): Promise<void>;
  exportHistory(): Promise<boolean>;
  importModel(): Promise<void>;
  importLive2DCore(): Promise<boolean>;
  downloadLive2DCore(): Promise<void>;
  removeModel(id: string): Promise<void>;
  screenSources(): Promise<ScreenSource[]>;
  captureScreen(sourceId: string): Promise<string>;
  transcribe(data: ArrayBuffer, mime: string): Promise<string>;
  synthesize(text: string): Promise<string>;
  importVoice(input: VoiceImportInput): Promise<ClonedVoice>;
  cloneVoice(input: VoiceCloneInput): Promise<ClonedVoice>;
  queryVoice(id: string): Promise<ClonedVoice>;
  voiceConversation(active: boolean): Promise<void>;
  setMood(mood: Mood): Promise<void>;
  focus(minutes: number): Promise<void>;
  showPet(): Promise<void>;
  showDashboard(page?: Page): Promise<void>;
  hideWindow(): Promise<void>;
  petDrag(action: "start" | "move" | "end"): void;
  petInteractive(interactive: boolean): void;
  openDataFolder(): Promise<void>;
  quit(): Promise<void>;
}
