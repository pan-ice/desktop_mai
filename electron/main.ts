import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { DeliveryUnknownError, MaiBotBridge } from "./bridge";
import { AccountClient, type LoginProof } from "./accounts";
import { LocalServer } from "./local-server";
import {
  ServerCertificateStore,
  type CertificateAuthorityProvider,
} from "./server-certificates";
import { adapterConfig, messageAdapterConfig, type Reply } from "./protocol";
import { StateStore } from "./store";
import { developmentRendererUrl } from "./renderer-source";
import { registerRecoveryShortcut } from "./recovery-shortcut";
import {
  inlineAttachment,
  mediaResponse,
  pruneMedia,
  removeHistoryMedia,
  saveAttachment,
} from "./media";
import {
  containedFile,
  importModelFile,
  resolveModelEntry,
  withModelUrls,
} from "./models";
import {
  findLive2DCore,
  downloadLive2DCore,
  installLive2DCore,
  live2dCoreUrl,
  type Live2DCore,
} from "./live2d-core";
import {
  LIVE2D_RUNTIME_FILES,
  live2dRuntimeForEntry,
  type Live2DRuntime,
} from "../shared/live2d";
import { inQuietHours, shouldReachOut } from "./companion";
import { synthesizeAudio, transcribeAudio } from "./speech";
import { TtsScheduler } from "./tts-scheduler";
import { TtsHttpError } from "./tts-errors";
import {
  createClonedVoice,
  createImportedVoice,
  queryClonedVoice,
} from "./tts";
import {
  ttsProfile,
  ttsProviders,
  voiceCloneInputSchema,
  voiceImportInputSchema,
  type ClonedVoice,
} from "../shared/tts";
import { CREDENTIAL_KEYS } from "../shared/types";
import { isModelGuideUrl } from "../shared/model-guidance";
import {
  idlePlayback,
  playbackReportSchema,
  type PlaybackState,
} from "../shared/playback";
import { REPLY_WAIT_MS } from "../shared/interaction";
import {
  fitPetPosition,
  PET_CHARACTER,
  PET_SURFACE,
} from "../shared/pet-layout";
import {
  sendSchema,
  isLocalServerUrl,
  serverConnectionSchema,
  serverUrlSchema,
  settingsPatchSchema,
} from "../shared/schemas";
import type {
  ApiResult,
  ChatMessage,
  CredentialKey,
  Mood,
  Page,
  SendInput,
  Settings,
  Snapshot,
} from "../shared/types";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
if (process.env.MAI_USER_DATA)
  app.setPath("userData", process.env.MAI_USER_DATA);
app.setName("Mai Desktop Pet");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "mai-asset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: "mai-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
if (!app.requestSingleInstanceLock()) app.quit();

let serverCertificates: ServerCertificateStore | undefined;
const certificateAuthority: CertificateAuthorityProvider = (url) =>
  serverCertificates?.authority(url);
const bridge = new MaiBotBridge(certificateAuthority);
const accountClient = new AccountClient(certificateAuthority);
const localServer = new LocalServer(process.env.MAI_PYTHON);
const ttsScheduler = new TtsScheduler();
let qqLogin: { server: string; proof: LoginProof } | null = null;
let historyEpoch = 0;
// Reconnecting restarts history sync, while accepted replies retain delivery
// eligibility until the conversation or the user's connection intent changes.
let replyDeliveryEpoch = 0;
let repliesBeforeConnection = new Set<string>();
const pendingReplyDeliveries = new Map<
  string,
  {
    receivedAt: number;
    history: ChatMessage[];
    scope: string;
    epoch: number;
  }
>();
let store: StateStore;
let recoveryShortcut: string | null = null;
const live2dCores: Partial<Record<Live2DRuntime, Live2DCore>> = {};
const live2dCoreDownloads: Partial<Record<Live2DRuntime, Promise<Live2DCore>>> =
  {};
let live2dCoreError = "";
let live2dCoreErrorRuntime: Live2DRuntime = "modern";
let dashboard: BrowserWindow | null = null;
let pet: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let cleanupDone = false;
let lastInteraction = Date.now();
let moodTimer: ReturnType<typeof setTimeout> | null = null;
let replyTimer: ReturnType<typeof setTimeout> | undefined;
let pendingRequest: string | null = null;
let playbackOwner: number | null = null;
let voiceInputOwner: number | null = null;
let scheduler: ReturnType<typeof setInterval> | null = null;
let drag: { cursor: Electron.Point; bounds: Electron.Rectangle } | null = null;
let replyQueue: Promise<void> = Promise.resolve();
let lastObservation = 0;
let lastScreenHash = "";
let observing = false;

function replyDeliveryScope() {
  const settings = store.state.settings;
  return JSON.stringify([
    settings.connectionMode,
    settings.serverUrl,
    settings.serverAccountId,
    settings.adapterPort,
    settings.adapterScope,
    settings.platform,
    settings.botId,
    settings.userId,
    settings.userName,
  ]);
}

function invalidateReplyDeliveries() {
  ++replyDeliveryEpoch;
  pendingReplyDeliveries.clear();
}

function flushReplyDeliveries() {
  if (bridge.phase !== "connected") return;
  const scope = replyDeliveryScope();
  for (const [id, delivery] of pendingReplyDeliveries) {
    pendingReplyDeliveries.delete(id);
    if (
      delivery.epoch !== replyDeliveryEpoch ||
      delivery.scope !== scope ||
      delivery.history !== store.state.history ||
      !delivery.history.some(
        (message) => message.id === id && message.role === "assistant",
      ) ||
      store.state.liveReplies.some((message) => message.id === id)
    )
      continue;
    store.state.liveReplies = [
      ...store.state.liveReplies,
      { id, receivedAt: delivery.receivedAt },
    ].slice(-1000);
    lastInteraction = Math.max(lastInteraction, delivery.receivedAt);
    clearReplyStatus();
  }
}

async function observeScreen(now: number) {
  const settings = store.state.settings;
  const canShare = () =>
    !quitting &&
    store.state.settings === settings &&
    settings.screenEnabled &&
    settings.screenObservationEnabled &&
    settings.petVisible &&
    bridge.phase === "connected" &&
    !store.state.focusUntil &&
    store.state.replyStatus === "idle" &&
    !["recording", "transcribing"].includes(store.state.voiceInput) &&
    store.state.playback.phase === "idle" &&
    !["thinking", "speaking"].includes(store.state.mood) &&
    !inQuietHours(
      new Date().getHours(),
      settings.quietStart,
      settings.quietEnd,
    );
  if (
    observing ||
    !canShare() ||
    now - lastObservation < settings.screenObservationSeconds * 1000
  )
    return;
  lastObservation = now;
  observing = true;
  try {
    if (!settings.screenSourceId)
      throw new Error("请先选择自动感知的屏幕或窗口");
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 1280, height: 800 },
    });
    if (!canShare()) return;
    const source = sources.find((item) => item.id === settings.screenSourceId);
    if (!source || source.thumbnail.isEmpty())
      throw new Error("自动感知的窗口已关闭，请重新选择");
    const bytes = source.thumbnail.toJPEG(72);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (lastScreenHash === hash) return;
    // 捕获和媒体写入都会等待；一直绑定开始时的设置，发送前再次核对权限与目标。
    if (
      !(await send(
        {
          text: settings.screenObservationPrompt,
          image: `data:image/jpeg;base64,${bytes.toString("base64")}`,
          source: "screen",
        },
        canShare,
      ))
    )
      return;
    if (store.state.settings === settings) lastScreenHash = hash;
    activity("已分享一帧屏幕给 MaiBot");
  } catch (error) {
    if (!canShare()) return;
    await updateSettings({ screenObservationEnabled: false });
    activity(
      `自动屏幕感知已暂停：${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  } finally {
    observing = false;
  }
}

function snapshot(): Snapshot {
  return structuredClone({
    ...store.state,
    recoveryShortcut,
    botName: bridge.botName,
    live2dCoreReady: Boolean(live2dCores.modern),
    live2dLegacyReady: Boolean(live2dCores.legacy),
    live2dCoreDownloading: Object.values(live2dCoreDownloads).some(Boolean),
    live2dCoreError,
    live2dCoreErrorRuntime,
    models: store.state.models.map((model) => {
      if (model.kind !== "live2d") return model;
      const core = live2dCores[live2dRuntimeForEntry(model.entry)];
      return { ...model, coreUrl: core ? live2dCoreUrl(core) : undefined };
    }),
    removedServerAccounts: store.removedAccounts(
      store.state.settings.serverUrl,
    ),
    serverCertificates: serverCertificates?.list() ?? [],
  });
}
function broadcast() {
  const state = snapshot();
  for (const window of [dashboard, pet])
    if (window && !window.isDestroyed())
      window.webContents.send("mai:state", state);
}

function downloadCore(runtime: Live2DRuntime = "modern"): Promise<Live2DCore> {
  const pending = live2dCoreDownloads[runtime];
  if (pending) return pending;
  live2dCoreError = "";
  live2dCoreDownloads[runtime] = (async () => {
    try {
      const core = await downloadLive2DCore(
        join(store.directory, "models"),
        (url, options) => net.fetch(url, options),
        runtime,
      );
      live2dCores[runtime] = core;
      activity(
        runtime === "modern"
          ? "已从 Live2D 官方下载运行库，之后可离线复用"
          : "Cubism 2 兼容运行库已下载并通过归档校验，之后可离线复用",
      );
      return core;
    } catch (error) {
      live2dCoreError = error instanceof Error ? error.message : String(error);
      live2dCoreErrorRuntime = runtime;
      throw error;
    } finally {
      delete live2dCoreDownloads[runtime];
      broadcast();
    }
  })();
  broadcast();
  return live2dCoreDownloads[runtime]!;
}
function activity(text: string, level: "info" | "error" = "info") {
  store.state.activity = [
    { id: randomUUID(), text, level, timestamp: Date.now() },
    ...store.state.activity,
  ].slice(0, 60);
  broadcast();
}
function persist() {
  void store
    .save()
    .catch((error) => activity(`保存失败：${String(error)}`, "error"));
}
function credential(key: CredentialKey) {
  const value = store.encrypted[key];
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("系统密钥存储不可用，无法读取令牌");
  return safeStorage.decryptString(Buffer.from(value, "base64"));
}
function ttsCredential(settings = store.state.settings) {
  const key = credential(ttsProviders[settings.ttsProvider].key);
  if (key) return key;
  // 旧版共用语音 Key 仅在原服务地址上继续使用，不能随新服务商配置外发。
  if (
    settings.ttsProvider === "openai" &&
    ttsProfile(settings).baseUrl === settings.speechBaseUrl
  )
    return credential("speechKey");
  return "";
}

function synthesisConfiguration(settings: Settings) {
  return JSON.stringify([
    settings.ttsEngine,
    settings.ttsProvider,
    ttsProfile(settings),
    settings.ttsNativeOutput,
    settings.ttsNaturalSpeech,
    settings.ttsCloneFidelity,
    settings.speechRate,
  ]);
}
let cloningVoice = false;
let voiceSelectionEpoch = 0;
let voiceStatusTimer: ReturnType<typeof setTimeout> | undefined;
const voiceStatusAbort = new AbortController();
const voiceQueries = new Map<string, Promise<ClonedVoice>>();
const voiceStatusFailures = new Map<string, number>();

function cancelVoiceAutoUse() {
  ++voiceSelectionEpoch;
  for (const voice of store.state.clonedVoices)
    if (voice.autoUse) voice.autoUse = false;
}

function applyImportedVoice(voice: ClonedVoice) {
  cancelVoiceAutoUse();
  store.state.settings = {
    ...store.state.settings,
    ttsEngine: "api",
    ttsProvider: voice.provider,
    ttsProfiles: {
      ...store.state.settings.ttsProfiles,
      [voice.provider]: voice.profile,
    },
    voiceEnabled: store.state.credentials[ttsProviders[voice.provider].key],
  };
}

async function refreshVoice(id: string): Promise<ClonedVoice> {
  const existing = voiceQueries.get(id);
  if (existing) return existing;
  const task = (async () => {
    const previous = store.state.clonedVoices.find((voice) => voice.id === id);
    if (!previous) throw new Error("找不到该复刻音色");
    const value = await queryClonedVoice(
      previous,
      credential(ttsProviders[previous.provider].key),
      voiceStatusAbort.signal,
    );
    const index = store.state.clonedVoices.findIndex(
      (voice) => voice.id === id,
    );
    const current = store.state.clonedVoices[index];
    if (quitting || !current || current.createdAt !== previous.createdAt)
      return current || value;
    const voice = {
      ...current,
      status: value.status,
      statusMessage: undefined,
    };
    store.state.clonedVoices[index] = voice;
    voiceStatusFailures.delete(id);
    if (voice.autoUse && voice.status === "ready") applyImportedVoice(voice);
    if (voice.status === "failed") voice.autoUse = false;
    await store.save();
    broadcast();
    return voice;
  })();
  voiceQueries.set(id, task);
  try {
    return await task;
  } finally {
    voiceQueries.delete(id);
  }
}

function scheduleVoiceStatus(delay = 3000) {
  if (
    quitting ||
    voiceStatusTimer ||
    !store.state.clonedVoices.some(
      (voice) => voice.autoUse !== undefined && voice.status === "pending",
    )
  )
    return;
  voiceStatusTimer = setTimeout(() => {
    voiceStatusTimer = undefined;
    void (async () => {
      let nextDelay = 3000;
      for (const pending of store.state.clonedVoices.filter(
        (voice) => voice.autoUse !== undefined && voice.status === "pending",
      )) {
        try {
          await refreshVoice(pending.id);
        } catch {
          if (quitting) return;
          const voice = store.state.clonedVoices.find(
            (value) => value.id === pending.id,
          );
          if (
            !voice ||
            voice.autoUse === undefined ||
            voice.status !== "pending"
          )
            continue;
          const failures = Math.min(
            (voiceStatusFailures.get(voice.id) || 0) + 1,
            5,
          );
          voiceStatusFailures.set(voice.id, failures);
          nextDelay = Math.max(
            nextDelay,
            Math.min(3000 * 2 ** failures, 60000),
          );
          voice.statusMessage = "暂时无法查询进度，正在自动重试。";
          await store.save();
          broadcast();
        }
      }
      scheduleVoiceStatus(nextDelay);
    })().catch(() => scheduleVoiceStatus(30000));
  }, delay);
}
function setMood(mood: Mood, resetMs?: number) {
  if (moodTimer) clearTimeout(moodTimer);
  moodTimer = null;
  store.state.mood =
    store.state.focusUntil && mood === "idle" ? "sleeping" : mood;
  if (resetMs) moodTimer = setTimeout(() => setMood("idle"), resetMs);
  broadcast();
}

function clearReplyStatus() {
  clearTimeout(replyTimer);
  replyTimer = undefined;
  pendingRequest = null;
  store.state.replyStatus = "idle";
}

function publishPlayback(value: PlaybackState) {
  const changed =
    store.state.playback.phase !== value.phase ||
    store.state.playback.id !== value.id;
  store.state.playback = value;
  for (const window of [dashboard, pet])
    if (window && !window.isDestroyed())
      window.webContents.send("mai:playback", value);
  if (changed) {
    if (value.phase === "playing") setMood("speaking");
    else if (store.state.mood === "speaking") setMood("idle");
    else broadcast();
  }
}

function stopPlayback() {
  const id = store.state.playback.id;
  playbackOwner = null;
  for (const window of [dashboard, pet])
    if (window && !window.isDestroyed()) {
      ttsScheduler.cancelOwner(window.webContents.id);
      window.webContents.send("mai:stop-playback", id);
    }
  publishPlayback({ ...idlePlayback });
}

function trusted(sender: Electron.WebContents) {
  return [dashboard?.webContents.id, pet?.webContents.id].includes(sender.id);
}
function loadWindow(window: BrowserWindow, view: string) {
  window.on("hide", () => {
    window.webContents.send("mai:window-hidden");
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isModelGuideUrl(url))
      void shell.openExternal(url).catch(() => {
        activity("无法打开官方计费说明，请检查系统默认浏览器。", "error");
      });
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const resetActivity = () => {
    ttsScheduler.cancelOwner(window.webContents.id);
    if (playbackOwner === window.webContents.id) stopPlayback();
    if (voiceInputOwner === window.webContents.id) {
      voiceInputOwner = null;
      store.state.voiceInput = "idle";
      store.state.conversationActive = false;
      broadcast();
    }
  };
  window.webContents.on("did-start-loading", resetActivity);
  window.webContents.on("render-process-gone", resetActivity);
  const synthesisOwner = window.webContents.id;
  window.webContents.once("destroyed", () =>
    ttsScheduler.cancelOwner(synthesisOwner),
  );
  const origin = developmentRendererUrl(
    app.isPackaged,
    process.env.ELECTRON_RENDERER_URL,
  );
  const loading = origin
    ? window.loadURL(`${origin}/?view=${view}`)
    : window.loadFile(join(here, "../renderer/index.html"), {
        query: { view },
      });
  return loading.catch((error) => {
    throw new Error(
      `无法加载${view === "dashboard" ? "控制面板" : "桌宠"}页面。${origin ? "请重新运行 npm run dev。" : app.isPackaged ? "请重新解压完整的正式发行包。" : "请运行 npm start 重新构建启动。"} ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function createDashboard() {
  dashboard = new BrowserWindow({
    width: 1190,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    show: false,
    title: "Mai · 桌面伙伴",
    icon: join(root, "resources/icon.png"),
    backgroundColor: "#f7f5f0",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  dashboard.once("ready-to-show", () => dashboard?.show());
  dashboard.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      dashboard?.hide();
    }
  });
  return loadWindow(dashboard, "dashboard");
}

function fitPet(x: number, y: number, cursor?: Electron.Point) {
  if (!pet) return;
  const scale = store.state.settings.petScale;
  const area = screen.getDisplayNearestPoint(
    cursor ?? {
      x: Math.round(x + (PET_CHARACTER.left + PET_CHARACTER.width / 2) * scale),
      y: Math.round(y + (PET_CHARACTER.top + PET_CHARACTER.height / 2) * scale),
    },
  ).workArea;
  const position = fitPetPosition({ x, y }, area, scale);
  // setPosition 会反复读取并换算旧尺寸，在 Windows 分数 DPI 下累积取整误差。
  pet.setBounds({
    ...position,
    width: Math.round(PET_SURFACE.width * scale),
    height: Math.round(PET_SURFACE.height * scale),
  });
}

function createPet() {
  const area = screen.getPrimaryDisplay().workArea;
  const scale = store.state.settings.petScale;
  // 启动时的原生 move 事件可能先写回默认位置，提前保留用户上次的位置。
  const savedPosition = store.petPosition;
  pet = new BrowserWindow({
    width: PET_SURFACE.width,
    height: PET_SURFACE.height,
    x: Math.round(area.x + area.width - PET_SURFACE.width * scale - 20),
    y: Math.round(area.y + area.height - PET_SURFACE.height * scale - 10),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: store.state.settings.alwaysOnTop,
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  pet.once("ready-to-show", () => {
    applyPetSettings();
    if (savedPosition) fitPet(savedPosition.x, savedPosition.y);
  });
  pet.once("show", () => {
    // Windows 首次显示的原生初始化可能覆盖同步设置的置顶，等本轮显示完成后再恢复。
    setImmediate(() => {
      if (!pet || pet.isDestroyed() || !pet.isVisible()) return;
      pet.setAlwaysOnTop(store.state.settings.alwaysOnTop, "floating");
    });
  });
  pet.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      void updateSettings({ petVisible: false });
    }
  });
  pet.on("move", () => {
    if (!pet) return;
    const [x, y] = pet.getPosition();
    store.petPosition = { x, y };
  });
  return loadWindow(pet, "pet");
}

function applyPetSettings() {
  if (!pet) return;
  const settings = store.state.settings;
  const previous = pet.getBounds();
  // Windows 会把不可拉伸窗口的当前尺寸作为最小值，缩小前清除旧约束。
  pet.setMinimumSize(0, 0);
  fitPet(previous.x, previous.y);
  pet.setIgnoreMouseEvents(settings.clickThrough);
  if (settings.petVisible) pet.showInactive();
  else pet.hide();
  // Windows 首次显示前设置置顶可能不生效，显示后再应用原生层级。
  pet.setAlwaysOnTop(settings.alwaysOnTop, "floating");
}

async function restorePetInteraction() {
  store.state.settings = {
    ...store.state.settings,
    petVisible: true,
    clickThrough: false,
  };
  drag = null;
  // 恢复输入不能被写盘队列或保存失败阻塞。
  if (pet && !pet.isDestroyed()) pet.setIgnoreMouseEvents(false);
  applyPetSettings();
  broadcast();
  try {
    await store.save();
  } catch {
    activity("已恢复鼠标交互，但设置未能保存，请检查数据目录后重试。", "error");
  }
}

async function updateSettings(patch: Partial<Settings>) {
  const parsed = settingsPatchSchema.parse(patch);
  if (
    parsed.activeModelId &&
    !store.state.models.some((model) => model.id === parsed.activeModelId)
  )
    throw new Error("所选角色不存在");
  const previous = store.state.settings;
  if (
    parsed.nickname !== undefined &&
    parsed.nickname !== previous.nickname &&
    parsed.followBotName === undefined
  )
    parsed.followBotName = false;
  if (
    "ttsEngine" in parsed ||
    "ttsProvider" in parsed ||
    "ttsProfiles" in parsed ||
    parsed.voiceEnabled === false
  )
    cancelVoiceAutoUse();
  if (
    parsed.screenObservationEnabled &&
    !(parsed.screenSourceId || previous.screenSourceId)
  )
    throw new Error("请先在「一起看屏幕」选择一个屏幕或窗口");
  const connectionChanged = (
    [
      "adapterPort",
      "connectionMode",
      "serverUrl",
      "serverAccountId",
      "adapterScope",
      "platform",
      "botId",
      "userId",
      "userName",
    ] as const
  ).some((key) => key in parsed && parsed[key] !== previous[key]);
  if (connectionChanged) invalidateReplyDeliveries();
  if (connectionChanged && bridge.phase !== "disconnected") {
    await bridge.disconnect();
    activity("连接配置已更新，请重新连接 MaiBot");
  }
  store.state.settings = { ...store.state.settings, ...parsed };
  if (parsed.petPositionLocked === true) drag = null;
  if (connectionChanged)
    await localServer.stopUnless(
      store.state.settings.connectionMode === "server"
        ? store.state.settings.serverUrl
        : "",
    );
  if (
    parsed.serverUrl !== undefined &&
    parsed.serverUrl !== previous.serverUrl
  ) {
    store.state.settings.serverAccountId = "";
    delete store.encrypted.serverToken;
    store.state.credentials.serverToken = false;
  }
  if (parsed.screenEnabled === false)
    store.state.settings.screenObservationEnabled = false;
  if ("screenSourceId" in parsed || parsed.screenObservationEnabled === true) {
    lastScreenHash = "";
    lastObservation = Date.now();
  }
  if (parsed.petVisible === false) {
    store.state.conversationActive = false;
    store.state.voiceInput = "idle";
    voiceInputOwner = null;
    stopPlayback();
  }
  await store.save();
  applyPetSettings();
  if ("petPositionLocked" in parsed) updateTrayMenu();
  if (app.isPackaged && "launchAtLogin" in parsed) applyLoginSettings();
  broadcast();
  return snapshot();
}

function applyLoginSettings() {
  app.setLoginItemSettings({
    openAtLogin: store.state.settings.launchAtLogin,
    // portable 的 process.execPath 位于退出后会被删除的临时解压目录。
    path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
    args: [],
  });
}

async function send(input: SendInput, canSend?: () => boolean) {
  if (canSend && !canSend()) return false;
  const value = sendSchema.parse(input);
  if (bridge.phase !== "connected")
    throw new Error("请先在「连接与账号」选择并连接桌宠");
  if (value.image && !store.state.settings.screenEnabled)
    throw new Error("请先启用屏幕感知");
  const connection = store.state.connection;
  const message: ChatMessage = {
    id: randomUUID(),
    role: "user",
    text: value.text,
    source: value.source || "text",
    timestamp: Date.now(),
    attachments: value.image
      ? [
          await saveAttachment(store.directory, {
            type: "image",
            dataUrl: value.image,
            name: "屏幕截图",
          }),
        ]
      : undefined,
  };
  if (store.state.connection !== connection) {
    await removeHistoryMedia(store.directory, [message]);
    throw new Error("聊天会话已变更，请重新发送");
  }
  if (canSend && !canSend()) {
    await removeHistoryMedia(store.directory, [message]);
    return false;
  }
  store.state.history.push(message);
  if (store.state.history.length > 1000)
    store.state.history.splice(0, store.state.history.length - 1000);
  lastInteraction = Date.now();
  // 发送成功只说明投递状态；MaiBot 可以选择沉默，客户端不推断生成状态。
  clearReplyStatus();
  pendingRequest = message.id;
  store.state.replyStatus = "sending";
  if (value.source !== "screen") stopPlayback();
  broadcast();
  try {
    if (value.source === "proactive")
      await bridge.proactive(value.text, message.id);
    else await bridge.send(value.text, value.image, message.id, value.source);
    message.delivery = "sent";
    if (pendingRequest === message.id) {
      store.state.replyStatus = "waiting";
      replyTimer = setTimeout(() => {
        if (pendingRequest !== message.id) return;
        clearReplyStatus();
        broadcast();
      }, REPLY_WAIT_MS);
    }
    await store.save();
    broadcast();
    return true;
  } catch (error) {
    message.delivery =
      error instanceof DeliveryUnknownError ? "unknown" : "failed";
    if (pendingRequest === message.id) clearReplyStatus();
    persist();
    throw error;
  }
}

function createTray() {
  // 原创简笔猫图标，应用本身不附带任何角色模型。
  const iconPath = join(root, "resources/tray.png");
  const icon = nativeImage
    .createFromPath(iconPath)
    .resize({ width: 20, height: 20 });
  tray = new Tray(
    icon.isEmpty()
      ? nativeImage.createFromDataURL(
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        )
      : icon,
  );
  tray.setToolTip("Mai · 桌面伙伴");
  updateTrayMenu();
  tray.on("double-click", () => dashboard?.show());
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开陪伴空间", click: () => dashboard?.show() },
      {
        label: recoveryShortcut
          ? `召回桌宠（${recoveryShortcut}）`
          : "召回桌宠",
        click: () => {
          void restorePetInteraction();
          pet?.show();
          if (pet) {
            const a = screen.getPrimaryDisplay().workArea;
            const scale = store.state.settings.petScale;
            fitPet(
              a.x + a.width - PET_SURFACE.width * scale - 20,
              a.y + a.height - PET_SURFACE.height * scale - 10,
            );
          }
        },
      },
      {
        label: "锁定桌宠位置",
        type: "checkbox",
        checked: store.state.settings.petPositionLocked,
        click: (item) => {
          void updateSettings({ petPositionLocked: item.checked });
        },
      },
      {
        label: "暂停 / 恢复鼠标穿透",
        click: () => {
          void updateSettings({
            clickThrough: !store.state.settings.clickThrough,
          });
        },
      },
      { type: "separator" },
      { label: "退出 Mai", click: () => app.quit() },
    ]),
  );
}

async function ensureAdapterToken() {
  if (credential("adapterToken")) return;
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("系统加密不可用，无法保存插件令牌");
  store.encrypted.adapterToken = safeStorage
    .encryptString(randomBytes(32).toString("base64url"))
    .toString("base64");
  store.state.credentials.adapterToken = true;
  await store.save();
  broadcast();
}

let localAdapterOpening: { key: string; promise: Promise<void> } | undefined;
let localAdapterReadyKey: string | undefined;

function localAdapterKey(settings: Settings, token: string) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        settings.connectionMode,
        settings.adapterPort,
        settings.adapterScope,
        settings.platform,
        settings.botId,
        settings.userId,
        settings.userName,
        token,
      ]),
    )
    .digest("hex");
}

async function connectLocalAdapter() {
  await ensureAdapterToken();
  const settings = store.state.settings;
  if (settings.connectionMode !== "local")
    throw new Error("接入配置已变更，请重试");
  const token = credential("adapterToken");
  const key = localAdapterKey(settings, token);
  const currentKey = () =>
    localAdapterKey(store.state.settings, credential("adapterToken"));
  const changed = () =>
    new Error("本机接入已取消或配置已变更，请重新开启后导出");
  if (localAdapterOpening?.key === key) return localAdapterOpening.promise;
  store.selectHistory("local");
  if (
    bridge.localPort === settings.adapterPort &&
    localAdapterReadyKey === key &&
    ["connecting", "connected", "reconnecting"].includes(bridge.phase)
  ) {
    await store.flush();
    if (!bridge.localPort || currentKey() !== key) throw changed();
    return;
  }
  const operation = { key, promise: Promise.resolve() };
  localAdapterReadyKey = undefined;
  const discard = async (port: number | undefined) => {
    if (
      port &&
      localAdapterOpening === operation &&
      bridge.localPort === port
    ) {
      localAdapterReadyKey = undefined;
      await bridge.disconnect();
    }
    throw changed();
  };
  operation.promise = (async () => {
    await bridge.connect({ ...settings }, token);
    const port = bridge.localPort;
    if (!port || currentKey() !== key || localAdapterOpening !== operation)
      return discard(port);
    let savedKey = key;
    if (settings.adapterPort === 0) {
      // 先真正绑定并保持监听，再保存实际端口；不经过会断开监听的 updateSettings。
      store.state.settings = { ...store.state.settings, adapterPort: port };
      savedKey = currentKey();
      operation.key = savedKey;
      try {
        await store.save();
      } catch {
        if (localAdapterOpening === operation && currentKey() === savedKey) {
          store.state.settings = { ...store.state.settings, adapterPort: 0 };
          await bridge.disconnect();
          await store.save().catch(() => {});
          broadcast();
        }
        throw new Error("自动分配的端口未能保存，请检查数据目录后重试");
      }
    } else {
      await store.flush();
    }
    if (
      bridge.localPort !== port ||
      currentKey() !== savedKey ||
      localAdapterOpening !== operation
    )
      return discard(port);
    localAdapterReadyKey = savedKey;
    broadcast();
  })().finally(() => {
    if (localAdapterOpening === operation) localAdapterOpening = undefined;
  });
  localAdapterOpening = operation;
  return operation.promise;
}

async function connectAdapter() {
  if (store.state.settings.connectionMode === "local")
    return connectLocalAdapter();
  if (store.state.settings.connectionMode === "server") {
    if (!credential("serverToken"))
      throw new Error(
        "请先通过 QQ 登录并选择桌宠账号，或导入管理员提供的服务器凭证",
      );
    store.selectHistory("server:pending");
    if (store.state.settings.serverAccountId)
      await ensureLocalServer(store.state.settings.serverUrl);
  }
  await bridge.connect(
    store.state.settings,
    credential(
      store.state.settings.connectionMode === "server"
        ? "serverToken"
        : "adapterToken",
    ),
  );
}

async function ensureLocalServer(serverUrl: string): Promise<string> {
  if (!isLocalServerUrl(serverUrl)) return serverUrl;
  const result = await localServer.ensure(
    store.state.settings.corePath,
    serverUrl,
  );
  if (result.adapterChanged)
    activity("本机连接已自动准备，运行中的 MaiBot 请重载一次桌宠插件");
  return result.serverUrl;
}

function remoteAccount() {
  const settings = store.state.settings;
  const token = credential("serverToken");
  if (settings.connectionMode !== "server" || !settings.serverUrl || !token)
    throw new Error("请先通过 QQ 登录桌宠服务器");
  return {
    server: settings.serverUrl,
    token,
    accountId: settings.serverAccountId,
  };
}

async function mergeCloudMessages(
  messages: ChatMessage[],
  history: ChatMessage[],
  epoch: number,
) {
  for (const message of messages) {
    if (history !== store.state.history || epoch !== historyEpoch) return;
    const existing = history.find(
      (item) => item.id === message.id && item.role === message.role,
    );
    if (existing) {
      existing.timestamp = message.timestamp;
      existing.source = message.source;
      if (message.delivery) existing.delivery = message.delivery;
      continue;
    }
    const attachments = [];
    for (const attachment of message.attachments || [])
      attachments.push(await saveAttachment(store.directory, attachment));
    if (history !== store.state.history || epoch !== historyEpoch) {
      await removeHistoryMedia(store.directory, [{ ...message, attachments }]);
      return;
    }
    history.push({
      ...message,
      attachments: attachments.length ? attachments : undefined,
    });
  }
  history.sort((left, right) => left.timestamp - right.timestamp);
  await store.save();
  broadcast();
}

async function syncCloudHistory(earlier = false) {
  const { server, token, accountId } = remoteAccount();
  if (!accountId) throw new Error("请选择一个桌宠账号");
  if (store.state.historySync.loading) return;
  const history = store.state.history;
  const epoch = historyEpoch;
  const original = new Set(earlier ? [] : history);
  const before = earlier ? store.state.historySync.before : null;
  store.state.historySync = {
    ...store.state.historySync,
    enabled: true,
    loading: true,
  };
  broadcast();
  try {
    const page = await accountClient.history(
      server,
      token,
      accountId,
      before || undefined,
    );
    replyQueue = replyQueue
      .catch(() => {})
      .then(async () => {
        if (history !== store.state.history || epoch !== historyEpoch) return;
        // 初次同步以服务端为准，避免恢复其他设备已清空的旧本机缓存。
        if (!earlier) {
          const keep = history.filter((message) => !original.has(message));
          history.splice(0, history.length, ...keep);
        }
        await mergeCloudMessages(page.messages, history, epoch);
        if (history === store.state.history && epoch === historyEpoch)
          store.state.historySync = {
            enabled: true,
            loading: false,
            before: page.before,
            hasMore: page.hasMore,
          };
      });
    await replyQueue;
  } finally {
    if (history === store.state.history && epoch === historyEpoch) {
      store.state.historySync.loading = false;
      broadcast();
    }
  }
}

async function commands(
  window: BrowserWindow | null,
  command: string,
  args: unknown[],
): Promise<unknown> {
  switch (command) {
    case "snapshot":
      return snapshot();
    case "updateSettings":
      return updateSettings(settingsPatchSchema.parse(args[0]));
    case "setCredential": {
      const key = z.enum(CREDENTIAL_KEYS).parse(args[0]);
      const value = z.string().max(4096).parse(args[1]);
      if (
        (key === "adapterToken" || key === "serverToken") &&
        value &&
        !/^[A-Za-z0-9_\-]{32,256}$/.test(value)
      )
        throw new Error("独立令牌需为 32 至 256 位字母、数字、下划线或横线");
      if (value && !safeStorage.isEncryptionAvailable())
        throw new Error("系统加密不可用，无法保存 API Key");
      if (value)
        store.encrypted[key] = safeStorage
          .encryptString(value)
          .toString("base64");
      else delete store.encrypted[key];
      store.state.credentials[key] = Boolean(value);
      if (key === "adapterToken" || key === "serverToken") {
        invalidateReplyDeliveries();
        await bridge.disconnect();
      }
      await store.save();
      broadcast();
      return;
    }
    case "connect":
      return connectAdapter();
    case "prepareLocalServer": {
      const previous = new URL(
        store.state.settings.serverUrl || "ws://127.0.0.1:18766/desktop",
      );
      const port =
        ["127.0.0.1", "localhost", "[::1]"].includes(previous.hostname) &&
        previous.port
          ? previous.port
          : "18766";
      const serverUrl = `ws://127.0.0.1:${port}/desktop`;
      let corePath = store.state.settings.corePath;
      try {
        await access(
          join(corePath, "plugins/desktop_pet_adapter/tools/server.py"),
        );
      } catch {
        const selected = await dialog.showOpenDialog({
          title: "选择用于本机测试的 MaiBot 目录",
          properties: ["openDirectory"],
        });
        if (selected.canceled || !selected.filePaths[0]) return null;
        corePath = selected.filePaths[0];
        await access(
          join(corePath, "plugins/desktop_pet_adapter/tools/server.py"),
        );
      }
      await updateSettings({ corePath });
      await updateSettings({ connectionMode: "server", serverUrl });
      return ensureLocalServer(serverUrl);
    }
    case "beginQQLogin": {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("系统加密不可用，无法保存设备凭证");
      const server = await ensureLocalServer(
        serverConnectionSchema.shape.serverUrl.parse(args[0]),
      );
      const name = z.string().trim().min(1).max(40).parse(args[1]);
      if (qqLogin) {
        const previous = qqLogin;
        qqLogin = null;
        await accountClient
          .cancel(previous.server, previous.proof)
          .catch(() => {});
      }
      const proof = await accountClient.begin(server, name);
      qqLogin = { server, proof };
      return { code: proof.code, expiresAt: proof.expiresAt };
    }
    case "pollQQLogin": {
      const login = qqLogin;
      if (!login) return "expired";
      const result = await accountClient.poll(login.server, login.proof);
      if (qqLogin !== login) return "expired";
      if (result.status === "confirmed") {
        if (!safeStorage.isEncryptionAvailable())
          throw new Error("系统加密不可用，无法保存设备凭证");
        invalidateReplyDeliveries();
        await bridge.disconnect();
        await replyQueue;
        await updateSettings({
          connectionMode: "server",
          serverUrl: login.server,
          serverAccountId: "",
        });
        store.selectHistory("server:pending");
        store.encrypted.serverToken = safeStorage
          .encryptString(result.token)
          .toString("base64");
        store.state.credentials.serverToken = true;
        qqLogin = null;
        await store.save();
        broadcast();
      } else if (result.status === "expired") qqLogin = null;
      return result.status;
    }
    case "cancelQQLogin": {
      const login = qqLogin;
      qqLogin = null;
      if (login) await accountClient.cancel(login.server, login.proof);
      return;
    }
    case "serverAccounts": {
      const { server, token } = remoteAccount();
      await ensureLocalServer(server);
      return (await accountClient.accounts(server, token)).accounts;
    }
    case "createServerAccount": {
      const { server, token } = remoteAccount();
      return accountClient.create(
        server,
        token,
        z.string().trim().min(1).max(40).parse(args[0]),
      );
    }
    case "selectServerAccount": {
      const id = z
        .string()
        .regex(/^pet_[a-f0-9]{32}$/)
        .parse(args[0]);
      const { server, token } = remoteAccount();
      const owned = (await accountClient.accounts(server, token)).accounts;
      const selected = owned.find((account) => account.id === id);
      if (!selected) throw new Error("该桌宠账号不存在或未获得授权");
      invalidateReplyDeliveries();
      await bridge.disconnect();
      await replyQueue;
      ++historyEpoch;
      store.restoreServerAccount(server, id);
      await updateSettings({ serverAccountId: id });
      await connectAdapter();
      return;
    }
    case "removeServerAccount": {
      const id = z
        .string()
        .regex(/^pet_[a-f0-9]{32}$/)
        .parse(args[0]);
      const { serverUrl, connectionMode } = store.state.settings;
      if (connectionMode !== "server" || !serverUrl)
        throw new Error("请先选择桌宠服务器");
      if (store.state.settings.serverAccountId === id) {
        invalidateReplyDeliveries();
        await bridge.disconnect();
        await replyQueue;
        // 只取消本机选择；聊天缓存归档保留，服务器账号、历史和设备授权保持有效。
        if (
          store.state.settings.serverUrl === serverUrl &&
          store.state.settings.serverAccountId === id
        ) {
          ++historyEpoch;
          store.selectHistory("server:pending");
          store.state.settings.serverAccountId = "";
          store.state.connection = {
            phase: "disconnected",
            detail: "已从本机移除桌宠，请选择其他桌宠或添加已有桌宠",
            since: Date.now(),
          };
          store.state.historySync = {
            enabled: false,
            loading: false,
            before: null,
            hasMore: false,
          };
        }
      }
      store.removeServerAccount(serverUrl, id);
      await store.save();
      broadcast();
      return;
    }
    case "serverDevices": {
      const { server, token } = remoteAccount();
      await ensureLocalServer(server);
      return (await accountClient.devices(server, token)).devices;
    }
    case "revokeServerDevice": {
      const { server, token } = remoteAccount();
      const id = z.string().min(16).max(100).parse(args[0]);
      const current = (await accountClient.devices(server, token)).devices.find(
        (device) => device.id === id,
      );
      await accountClient.revoke(server, token, id);
      if (current?.current) {
        invalidateReplyDeliveries();
        await bridge.disconnect();
        await replyQueue;
        ++historyEpoch;
        store.selectHistory("server:pending");
        store.state.settings.serverAccountId = "";
        delete store.encrypted.serverToken;
        store.state.credentials.serverToken = false;
        await store.save();
        broadcast();
      }
      return;
    }
    case "loadEarlierHistory":
      return syncCloudHistory(true);
    case "exportMessageAdapterConfig":
    case "exportAdapterConfig": {
      const standalone = command === "exportMessageAdapterConfig";
      if (store.state.settings.connectionMode === "server")
        throw new Error("服务器插件由管理员配置；请导入个人服务器凭证后连接");
      await ensureAdapterToken();
      const result = await dialog.showSaveDialog(dashboard!, {
        title: standalone
          ? "导出独立适配器配置（包含桌宠连接令牌）"
          : "导出桌宠适配器配置（包含独立连接令牌）",
        defaultPath: "config.toml",
        filters: [
          {
            name: standalone ? "独立适配器配置" : "插件配置",
            extensions: ["toml"],
          },
        ],
      });
      if (result.canceled || !result.filePath) return false;
      // 自动端口必须已真实绑定且落盘；重复导出复用当前监听，不打断适配器。
      await connectLocalAdapter();
      if (
        store.state.settings.connectionMode !== "local" ||
        bridge.localPort !== store.state.settings.adapterPort ||
        localAdapterReadyKey !==
          localAdapterKey(store.state.settings, credential("adapterToken"))
      )
        throw new Error("接入配置已变更，请重新导出适配器配置");
      await writeFile(
        result.filePath,
        (standalone ? messageAdapterConfig : adapterConfig)(
          store.state.settings,
          credential("adapterToken"),
        ),
        "utf8",
      );
      activity(
        standalone
          ? "独立适配器配置已导出，请填写 MaiBot 消息服务地址与令牌，再启动适配器"
          : "适配器配置已导出，请放入插件目录并妥善保存连接令牌",
      );
      return true;
    }
    case "importServerConnection": {
      const result = await dialog.showOpenDialog(dashboard!, {
        title: "导入管理员提供的桌宠服务器凭证",
        properties: ["openFile"],
        filters: [{ name: "桌宠服务器凭证", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePaths[0]) return false;
      const path = result.filePaths[0];
      if ((await stat(path)).size > 16384)
        throw new Error("服务器凭证文件过大");
      let content: unknown;
      try {
        content = JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw new Error("服务器凭证文件格式不正确，请向管理员重新获取");
      }
      const parsed = serverConnectionSchema.safeParse(content);
      if (!parsed.success)
        throw new Error("服务器凭证文件格式不正确，请向管理员重新获取");
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("系统加密不可用，无法保存接入凭证");
      invalidateReplyDeliveries();
      await bridge.disconnect();
      await replyQueue;
      store.selectHistory("server:pending");
      store.encrypted.serverToken = safeStorage
        .encryptString(parsed.data.token)
        .toString("base64");
      store.state.credentials.serverToken = true;
      await updateSettings({
        connectionMode: "server",
        serverUrl: parsed.data.serverUrl,
        serverAccountId: "",
      });
      // 切换服务器时 updateSettings 会清除原凭证，随后保存本次导入的凭证。
      store.encrypted.serverToken = safeStorage
        .encryptString(parsed.data.token)
        .toString("base64");
      store.state.credentials.serverToken = true;
      await store.save();
      broadcast();
      activity("服务器凭证已导入，点击连接服务器即可接入");
      return true;
    }
    case "importServerCertificate": {
      const serverUrl = serverUrlSchema.parse(args[0]);
      if (new URL(serverUrl).protocol !== "wss:")
        throw new Error("自定义证书仅用于 wss:// 服务器地址");
      const result = await dialog.showOpenDialog(dashboard!, {
        title: "导入 WSS 服务器的 CA 或自签名证书",
        properties: ["openFile"],
        filters: [
          { name: "X.509 证书", extensions: ["pem", "crt", "cer", "der"] },
        ],
      });
      if (result.canceled || !result.filePaths[0]) return false;
      const certificate = await serverCertificates!.importFile(
        serverUrl,
        result.filePaths[0],
      );
      accountClient.close();
      invalidateReplyDeliveries();
      await bridge.disconnect();
      broadcast();
      activity(
        `已为 ${certificate.host} 导入 ${certificate.certificateCount} 张证书，后续仍会校验证书有效期和服务器主机名`,
      );
      return true;
    }
    case "removeServerCertificate": {
      const serverUrl = serverUrlSchema.parse(args[0]);
      if (await serverCertificates!.remove(serverUrl)) {
        accountClient.close();
        invalidateReplyDeliveries();
        await bridge.disconnect();
        broadcast();
        activity(`已移除 ${new URL(serverUrl).hostname} 的自定义 WSS 证书`);
      }
      return;
    }
    case "disconnect":
      invalidateReplyDeliveries();
      return bridge.disconnect();
    case "send":
      return send(sendSchema.parse(args[0]));
    case "clearHistory": {
      const currentHistory = store.state.history;
      invalidateReplyDeliveries();
      if (
        store.state.settings.connectionMode === "server" &&
        store.state.settings.serverAccountId
      ) {
        const { server, token, accountId } = remoteAccount();
        await accountClient.clearHistory(server, token, accountId);
      }
      await replyQueue;
      if (currentHistory !== store.state.history) return;
      ++historyEpoch;
      const removed = store.state.history;
      store.state.history = [];
      store.state.liveReplies = [];
      await store.save();
      await removeHistoryMedia(store.directory, removed);
      broadcast();
      return;
    }
    case "exportHistory": {
      const result = await dialog.showSaveDialog({
        title: "导出聊天记录",
        defaultPath: `Mai-聊天记录-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) return false;
      const exported: ChatMessage[] = [];
      for (const message of store.state.history) {
        const attachments = [];
        for (const attachment of message.attachments || [])
          attachments.push(await inlineAttachment(store.directory, attachment));
        exported.push({
          ...message,
          attachments: attachments.length ? attachments : undefined,
        });
      }
      await writeFile(
        result.filePath,
        JSON.stringify(exported, null, 2),
        "utf8",
      );
      return true;
    }
    case "downloadLive2DCore": {
      await downloadCore(
        z.enum(["modern", "legacy"]).default("modern").parse(args[0]),
      );
      return;
    }
    case "importLive2DCore": {
      const selected = await dialog.showOpenDialog({
        title: "设置 Live2D 运行库（只需一次，可供其他模型复用）",
        properties: ["openFile"],
        filters: [{ name: "Cubism Core", extensions: ["js"] }],
      });
      if (selected.canceled) return false;
      const core = await installLive2DCore(
        join(store.directory, "models"),
        selected.filePaths[0],
      );
      live2dCores[core.runtime] = core;
      live2dCoreError = "";
      activity("Live2D 运行库已保存，导入其他模型时会自动复用");
      return true;
    }
    case "importModel": {
      const source = z.enum(["file", "folder"]).default("file").parse(args[0]);
      const selected = await dialog.showOpenDialog({
        title:
          source === "folder"
            ? "选择完整的 Live2D 模型文件夹"
            : "导入角色模型或图片",
        properties: [source === "folder" ? "openDirectory" : "openFile"],
        filters: [
          {
            name: "角色模型",
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "gif",
              "webp",
              "json",
              "vrm",
              "glb",
              "pmx",
              "pmd",
            ],
          },
        ],
      });
      if (selected.canceled) return;
      const file = await resolveModelEntry(selected.filePaths[0]);
      const modelsRoot = join(store.directory, "models");
      let coreFile: string | undefined;
      const runtime = live2dRuntimeForEntry(file);
      if (/\.model3?\.json$/i.test(file)) {
        coreFile = (await findLive2DCore(modelsRoot, runtime))?.file;
        if (!coreFile) {
          coreFile = (await downloadCore(runtime)).file;
        }
      }
      const model = await importModelFile(file, modelsRoot, coreFile);
      if (model.kind === "live2d")
        live2dCores[runtime] = await findLive2DCore(modelsRoot, runtime);
      store.state.models.push(model);
      await updateSettings({ activeModelId: model.id });
      activity(`已导入角色：${model.name}`);
      return;
    }
    case "removeModel": {
      const id = z.string().uuid().parse(args[0]);
      if (!store.state.models.some((model) => model.id === id))
        throw new Error("角色不存在");
      if (store.state.settings.activeModelId === id)
        store.state.settings.activeModelId = null;
      store.state.models = store.state.models.filter(
        (model) => model.id !== id,
      );
      await store.save();
      broadcast();
      await rm(join(store.directory, "models", id), {
        recursive: true,
        force: true,
      });
      return;
    }
    case "screenSources": {
      if (!store.state.settings.screenEnabled)
        throw new Error("请先开启屏幕感知");
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      });
      return sources
        .filter((source) => !source.name.includes("Mai ·"))
        .map((source) => ({
          id: source.id,
          name: source.name,
          thumbnail: source.thumbnail.toDataURL(),
        }));
    }
    case "captureScreen": {
      if (!store.state.settings.screenEnabled)
        throw new Error("屏幕感知未开启");
      const id = z.string().max(200).parse(args[0]);
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 1600, height: 1000 },
      });
      const source = sources.find((item) => item.id === id);
      if (!source || source.thumbnail.isEmpty())
        throw new Error("所选窗口已关闭或无法捕获，请重新选择");
      return `data:image/jpeg;base64,${source.thumbnail.toJPEG(80).toString("base64")}`;
    }
    case "transcribe": {
      if (!(args[0] instanceof ArrayBuffer))
        throw new Error("录音数据格式无效");
      return transcribeAudio(
        store.state.settings,
        credential("speechKey"),
        args[0],
        z.string().max(120).parse(args[1]),
      );
    }
    case "synthesize": {
      if (!window || window.isDestroyed())
        throw new DOMException("语音合成已取消", "AbortError");
      const selected = structuredClone(store.state.settings);
      const cloned = store.state.clonedVoices.find(
        (voice) =>
          voice.provider === selected.ttsProvider &&
          voice.voiceId === ttsProfile(selected).voice &&
          voice.profile.baseUrl === ttsProfile(selected).baseUrl,
      );
      if (
        cloned &&
        (cloned.status !== "ready" ||
          cloned.profile.model !== ttsProfile(selected).model)
      )
        throw new Error(
          "当前复刻音色尚未就绪或模型不匹配，请查询状态或重新选择音色",
        );
      const text = z.string().min(1).max(12000).parse(args[0]);
      const options = z
        .object({
          id: z.string().uuid(),
          priority: z.enum(["foreground", "prefetch"]),
        })
        .strict()
        .optional()
        .parse(args[1]);
      const key = ttsCredential(selected);
      const configuration = synthesisConfiguration(selected);
      const profile = ttsProfile(selected);
      return ttsScheduler.schedule({
        lane: JSON.stringify([
          selected.ttsProvider,
          new URL(profile.baseUrl).origin,
          profile.model,
        ]),
        owner: window.webContents.id,
        id: options?.id ?? randomUUID(),
        priority: options?.priority ?? "foreground",
        concurrency: selected.ttsProvider === "mimo" ? 1 : 2,
        minIntervalMs: selected.ttsProvider === "mimo" ? 700 : 0,
        run: (signal) => {
          signal.throwIfAborted();
          if (
            configuration !== synthesisConfiguration(store.state.settings) ||
            key !== ttsCredential()
          )
            throw new DOMException("语音合成已取消", "AbortError");
          return synthesizeAudio(selected, key, text, store.directory, signal);
        },
      });
    }
    case "importVoice":
    case "cloneVoice": {
      if (cloningVoice) throw new Error("已有音色正在提交复刻，请稍候");
      cloningVoice = true;
      try {
        const importing = command === "importVoice";
        const selectionEpoch = voiceSelectionEpoch;
        const settings = structuredClone(store.state.settings);
        const importedInput = importing
          ? voiceImportInputSchema.parse(args[0])
          : undefined;
        if (importedInput) settings.ttsProvider = importedInput.provider;
        if (store.state.clonedVoices.length >= 100)
          throw new Error("已保存 100 个复刻音色，请使用已有音色");
        const voice = importedInput
          ? await createImportedVoice(
              settings,
              ttsCredential(settings),
              importedInput,
              store.directory,
            )
          : await createClonedVoice(
              settings,
              ttsCredential(settings),
              voiceCloneInputSchema.parse(args[0]),
              store.directory,
            );
        if (importing) voice.autoUse = false;
        const previous = store.state.clonedVoices.findIndex(
          (saved) =>
            saved.provider === voice.provider &&
            saved.voiceId === voice.voiceId &&
            saved.profile.baseUrl === voice.profile.baseUrl,
        );
        if (previous < 0) store.state.clonedVoices.push(voice);
        else {
          voice.id = store.state.clonedVoices[previous].id;
          store.state.clonedVoices[previous] = voice;
        }
        if (importing && selectionEpoch === voiceSelectionEpoch) {
          cancelVoiceAutoUse();
          if (voice.status === "ready") applyImportedVoice(voice);
          else if (voice.status === "pending") voice.autoUse = true;
        }
        await store.save();
        broadcast();
        scheduleVoiceStatus();
        return voice;
      } finally {
        cloningVoice = false;
      }
    }
    case "queryVoice": {
      const id = z.string().uuid().parse(args[0]);
      return refreshVoice(id);
    }
    case "voiceConversation": {
      const active = z.boolean().parse(args[0]);
      if (active && bridge.phase !== "connected")
        throw new Error("请先连接 MaiBot，再开启连续语音");
      if (active && store.state.focusUntil)
        throw new Error("请先结束专注模式，再开启连续语音");
      if (active && !store.state.settings.petVisible)
        await updateSettings({ petVisible: true });
      store.state.conversationActive = active;
      if (!active) {
        store.state.voiceInput = "idle";
        voiceInputOwner = null;
      }
      broadcast();
      return;
    }
    case "setVoiceInput": {
      const phase = z
        .enum(["idle", "listening", "recording", "transcribing"])
        .parse(args[0]);
      if (
        !window ||
        (phase === "idle" && voiceInputOwner !== window.webContents.id)
      )
        return;
      if (phase === "listening" && !store.state.conversationActive) return;
      voiceInputOwner = phase === "idle" ? null : window.webContents.id;
      if (store.state.voiceInput !== phase) {
        store.state.voiceInput = phase;
        broadcast();
      }
      return;
    }
    case "setMood":
      setMood(
        z
          .enum(["idle", "happy", "thinking", "speaking", "sleeping"])
          .parse(args[0]),
        args[0] === "happy" ? 6000 : undefined,
      );
      return;
    case "focus": {
      const minutes = z.number().min(0).max(180).parse(args[0]);
      store.state.focusUntil = minutes ? Date.now() + minutes * 60000 : null;
      if (minutes) store.state.conversationActive = false;
      if (minutes) {
        store.state.voiceInput = "idle";
        voiceInputOwner = null;
        stopPlayback();
      }
      setMood(minutes ? "sleeping" : "idle");
      activity(minutes ? `开始 ${minutes} 分钟专注陪伴` : "专注已结束");
      return;
    }
    case "showPet":
      await restorePetInteraction();
      return;
    case "showDashboard": {
      const page = z
        .enum(["home", "chat", "models", "senses", "core", "settings"])
        .optional()
        .parse(args[0]);
      dashboard?.show();
      if (page) dashboard?.webContents.send("mai:page", page);
      return;
    }
    case "hideWindow":
      window?.hide();
      return;
    case "openDataFolder":
      await shell.openPath(store.directory);
      return;
    case "quit":
      app.quit();
      return;
    default:
      throw new Error("未知操作");
  }
}

app.on("second-instance", () => {
  dashboard?.show();
  dashboard?.focus();
});
app.on("window-all-closed", () => {
  /* 托盘负责桌宠生命周期。 */
});
app.on("activate", () => dashboard?.show());
app.on("before-quit", (event) => {
  if (cleanupDone) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  ttsScheduler.dispose();
  if (scheduler) clearInterval(scheduler);
  if (voiceStatusTimer) clearTimeout(voiceStatusTimer);
  voiceStatusAbort.abort();
  if (moodTimer) clearTimeout(moodTimer);
  clearTimeout(replyTimer);
  qqLogin = null;
  accountClient.close();
  const disconnected = bridge.disconnect(false);
  globalShortcut.unregisterAll();
  tray?.destroy();
  void (async () => {
    try {
      await disconnected;
      await localServer.stop();
      await replyQueue;
      if (store) await store.flush();
    } finally {
      cleanupDone = true;
      app.quit();
    }
  })();
});

void app
  .whenReady()
  .then(async () => {
    store = new StateStore(app.getPath("userData"));
    await store.load();
    store.state.version = app.getVersion();
    if (app.isPackaged && store.state.settings.launchAtLogin) {
      try {
        // 修复旧便携版本留下的临时程序路径，并跟随启动器的新位置。
        applyLoginSettings();
      } catch {
        activity("开机启动设置未能更新，请在偏好设置中重新开启", "error");
      }
    }
    serverCertificates = new ServerCertificateStore(store.directory);
    try {
      await serverCertificates.load();
    } catch (error) {
      // 可选证书存储损坏时保持 TLS 默认拒绝，不让它阻止用户启动后重新导入。
      activity(error instanceof Error ? error.message : String(error), "error");
    }
    await pruneMedia(store.directory, store.allHistory());
    for (const runtime of ["modern", "legacy"] as const)
      live2dCores[runtime] = await findLive2DCore(
        join(store.directory, "models"),
        runtime,
      );
    store.state.models = store.state.models.map(withModelUrls);
    if (!store.state.settings.corePath && !app.isPackaged)
      store.state.settings.corePath = join(root, "MaiBot");
    protocol.handle("mai-asset", async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname === "runtime") {
          const runtime = (
            Object.keys(LIVE2D_RUNTIME_FILES) as Live2DRuntime[]
          ).find((key) => url.pathname === `/${LIVE2D_RUNTIME_FILES[key]}`);
          const core = runtime && live2dCores[runtime];
          if (!core || url.searchParams.get("v") !== core.revision)
            return new Response("Not found", { status: 404 });
          return net.fetch(pathToFileURL(core.file).toString());
        }
        const [id, ...parts] = url.pathname
          .slice(1)
          .split("/")
          .map(decodeURIComponent);
        if (
          url.hostname !== "model" ||
          !store.state.models.some((model) => model.id === id)
        )
          return new Response("Not found", { status: 404 });
        const file = await containedFile(
          join(store.directory, "models", id),
          parts.join("/"),
        );
        return net.fetch(pathToFileURL(file).toString());
      } catch {
        return new Response("Invalid asset", { status: 404 });
      }
    });
    protocol.handle("mai-media", (request) =>
      mediaResponse(store.directory, request),
    );
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback) =>
        callback(trusted(contents) && permission === "media"),
    );
    session.defaultSession.setPermissionCheckHandler((contents, permission) =>
      Boolean(contents && trusted(contents) && permission === "media"),
    );
    ipcMain.handle(
      "mai:command",
      async (
        event,
        command: string,
        ...args: unknown[]
      ): Promise<ApiResult<unknown>> => {
        if (
          !trusted(event.sender) ||
          event.senderFrame !== event.sender.mainFrame
        )
          return { ok: false, error: "操作来源无效" };
        try {
          return {
            ok: true,
            value: await commands(
              BrowserWindow.fromWebContents(event.sender),
              command,
              args,
            ),
          };
        } catch (error) {
          const message =
            error instanceof z.ZodError
              ? `设置无效：${error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("；")}`
              : error instanceof Error
                ? error.message
                : String(error);
          const errorKind: "cancelled" | "tts_final" | undefined =
            command === "synthesize" &&
            error instanceof Error &&
            error.name === "AbortError"
              ? "cancelled"
              : command === "synthesize" &&
                  error instanceof TtsHttpError &&
                  [401, 402, 403, 429].includes(error.status)
                ? "tts_final"
                : undefined;
          if (errorKind !== "cancelled") activity(message, "error");
          return { ok: false, error: message, errorKind };
        }
      },
    );
    ipcMain.on("mai:cancel-synthesis", (event, raw: unknown) => {
      if (
        !trusted(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        return;
      const id = z.string().uuid().safeParse(raw);
      if (id.success) ttsScheduler.cancel(event.sender.id, id.data);
    });
    ipcMain.on("mai:drag", (event, action: unknown) => {
      if (event.sender.id !== pet?.webContents.id || !pet) return;
      if (store.state.settings.petPositionLocked) {
        drag = null;
        return;
      }
      if (action === "start")
        drag = {
          cursor: screen.getCursorScreenPoint(),
          bounds: pet.getBounds(),
        };
      else if (action === "move" && drag) {
        const point = screen.getCursorScreenPoint();
        fitPet(
          drag.bounds.x + point.x - drag.cursor.x,
          drag.bounds.y + point.y - drag.cursor.y,
          point,
        );
      } else if (action === "end") {
        drag = null;
        persist();
      }
    });
    ipcMain.on("mai:playback-report", (event, raw: unknown) => {
      if (!trusted(event.sender)) return;
      const parsed = playbackReportSchema.safeParse(raw);
      if (!parsed.success) return;
      const report = parsed.data;
      if (report.type === "start") {
        if (playbackOwner !== null && store.state.playback.id) {
          if (playbackOwner !== event.sender.id)
            ttsScheduler.cancelOwner(playbackOwner);
          [dashboard, pet]
            .find((window) => window?.webContents.id === playbackOwner)
            ?.webContents.send("mai:stop-playback", store.state.playback.id);
        }
        playbackOwner = event.sender.id;
        publishPlayback({ id: report.id, phase: "preparing", mouth: 0 });
      } else if (
        playbackOwner === event.sender.id &&
        store.state.playback.id === report.id
      ) {
        if (report.type === "end") {
          playbackOwner = null;
          publishPlayback({ ...idlePlayback });
        } else
          publishPlayback({
            id: report.id,
            phase: "playing",
            mouth: report.mouth,
          });
      }
    });
    ipcMain.on("mai:stop-playback", (event) => {
      if (trusted(event.sender)) stopPlayback();
    });
    bridge.on("bot-name", () => broadcast());
    bridge.on("status", (status: Snapshot["connection"]) => {
      if (!bridge.localPort) localAdapterReadyKey = undefined;
      ++historyEpoch;
      store.state.liveReplies = [];
      if (
        status.phase === "connected" &&
        store.state.settings.connectionMode === "server" &&
        status.userId
      ) {
        const key = createHash("sha256")
          .update(`${store.state.settings.serverUrl}\n${status.userId}`)
          .digest("hex");
        const previousHistory = store.state.history;
        store.selectHistory(`server:${key}`);
        if (previousHistory !== store.state.history)
          invalidateReplyDeliveries();
        persist();
      }
      // 初次同步会替换历史对象，保留连接前的 ID，避免缓存重发恢复朗读资格。
      repliesBeforeConnection = new Set(
        store.state.history
          .filter((message) => message.role === "assistant")
          .map((message) => message.id),
      );
      store.state.connection = status;
      flushReplyDeliveries();
      store.state.historySync = {
        enabled:
          store.state.settings.connectionMode === "server" &&
          Boolean(store.state.settings.serverAccountId),
        loading: false,
        before: null,
        hasMore: false,
      };
      if (
        status.phase === "connected" &&
        store.state.settings.connectionMode === "server" &&
        store.state.settings.serverAccountId
      )
        void syncCloudHistory().catch(() =>
          activity("服务器聊天记录同步失败，可重新连接后重试", "error"),
        );
      if (status.phase !== "connected") {
        store.state.conversationActive = false;
        store.state.voiceInput = "idle";
        voiceInputOwner = null;
        clearReplyStatus();
        stopPlayback();
      }
      activity(status.detail);
      if (status.phase !== "connected") setMood("idle");
    });
    bridge.on("diagnostic", (message: string) =>
      activity(`消息解析：${message}`, "error"),
    );
    bridge.on("history", (messages: ChatMessage[]) => {
      if (!store.state.settings.serverAccountId) return;
      const history = store.state.history;
      const epoch = historyEpoch;
      replyQueue = replyQueue
        .catch(() => {})
        .then(() => mergeCloudMessages(messages, history, epoch))
        .catch(() => activity("同步服务器消息失败，请重新连接重试", "error"));
    });
    bridge.on("history_clear", () => {
      const epoch = ++historyEpoch;
      invalidateReplyDeliveries();
      const history = store.state.history;
      replyQueue = replyQueue
        .catch(() => {})
        .then(async () => {
          if (epoch !== historyEpoch || history !== store.state.history) return;
          const removed = history.splice(0);
          store.state.liveReplies = [];
          store.state.historySync = {
            enabled: true,
            loading: false,
            before: null,
            hasMore: false,
          };
          await store.save();
          await removeHistoryMedia(store.directory, removed);
          broadcast();
        })
        .catch(() =>
          activity("同步聊天记录清空操作失败，请重新连接重试", "error"),
        );
    });
    bridge.on("reply", (reply: Reply, acknowledge: (error?: Error) => void) => {
      const history = store.state.history;
      const epoch = replyDeliveryEpoch;
      const scope = replyDeliveryScope();
      const previousReplies = repliesBeforeConnection;
      const receivedAt = Date.now();
      replyQueue = replyQueue
        .then(async () => {
          if (
            history.some(
              (message) =>
                message.id === reply.id && message.role === "assistant",
            )
          ) {
            await store.flush();
          } else {
            const attachments = [];
            for (const attachment of reply.attachments || [])
              attachments.push(
                await saveAttachment(store.directory, attachment),
              );
            history.push({
              ...reply,
              attachments: attachments.length ? attachments : undefined,
              role: "assistant",
              timestamp: receivedAt,
              source: "core",
            });
            if (history.length > 1000) history.splice(0, history.length - 1000);
            await store.save();
          }
          if (
            history === store.state.history &&
            epoch === replyDeliveryEpoch &&
            scope === replyDeliveryScope()
          ) {
            // 存储去重不等于实时投递已处理：history 可能比同一条 reply 先到。
            if (
              !previousReplies.has(reply.id) &&
              !pendingReplyDeliveries.has(reply.id) &&
              !store.state.liveReplies.some((item) => item.id === reply.id)
            ) {
              pendingReplyDeliveries.set(reply.id, {
                receivedAt,
                history,
                scope,
                epoch,
              });
              if (pendingReplyDeliveries.size > 1000)
                pendingReplyDeliveries.delete(
                  pendingReplyDeliveries.keys().next().value!,
                );
            }
            flushReplyDeliveries();
            broadcast();
          }
          acknowledge();
        })
        .catch((error) => {
          acknowledge(
            error instanceof Error ? error : new Error(String(error)),
          );
          activity(`保存内核回复失败：${String(error)}`, "error");
        });
    });
    localServer.on("log", (text: string) => activity(text));
    recoveryShortcut = registerRecoveryShortcut(
      (accelerator, callback) => globalShortcut.register(accelerator, callback),
      () => {
        void restorePetInteraction();
        dashboard?.show();
        dashboard?.focus();
      },
    );
    if (recoveryShortcut !== "Ctrl + Shift + M")
      activity(
        recoveryShortcut
          ? `Ctrl + Shift + M 已被占用，恢复交互请按 ${recoveryShortcut}。`
          : "恢复交互快捷键暂不可用，可在偏好设置或托盘菜单关闭鼠标穿透。",
        "error",
      );
    await Promise.all([createDashboard(), createPet()]);
    createTray();
    scheduleVoiceStatus();
    scheduler = setInterval(() => {
      const now = Date.now();
      void observeScreen(now);
      if (store.state.focusUntil && now >= store.state.focusUntil) {
        store.state.focusUntil = null;
        lastInteraction = now;
        setMood("idle");
        activity("专注时间结束，休息一下吧");
        if (Notification.isSupported())
          new Notification({
            title: "Mai · 休息一下",
            body: "这一段专注结束了，起来走走吧。",
          }).show();
      }
      if (
        shouldReachOut(
          store.state.settings,
          now,
          lastInteraction,
          bridge.supports("proactive"),
          store.state.focusUntil,
        )
      ) {
        lastInteraction = now;
        void bridge
          .proactive(store.state.settings.proactivePrompt)
          .then(() => activity("主动陪伴意图已交给 MaiBot"))
          .catch((error) => activity(String(error), "error"));
      }
    }, 15000);
    if (
      store.state.settings.autoConnect &&
      (store.state.settings.connectionMode === "local"
        ? store.state.credentials.adapterToken
        : store.state.credentials.serverToken && store.state.settings.serverUrl)
    )
      void connectAdapter().catch((error) => activity(String(error), "error"));
  })
  .catch((error) => {
    console.error("Mai 启动失败：", error);
    dialog.showErrorBox("Mai 启动失败", String(error));
    app.quit();
  });
