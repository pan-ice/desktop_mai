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
import { adapterConfig, messageAdapterConfig } from "./protocol";
import { StateStore } from "./store";
import {
  inlineAttachment,
  mediaFile,
  pruneMedia,
  removeHistoryMedia,
  saveAttachment,
} from "./media";
import { containedFile, importModelFile, withModelUrls } from "./models";
import {
  findLive2DCore,
  downloadLive2DCore,
  installLive2DCore,
  LIVE2D_CORE_FILE,
  live2dCoreUrl,
  type Live2DCore,
} from "./live2d-core";
import { inQuietHours, shouldReachOut } from "./companion";
import { synthesizeAudio, transcribeAudio } from "./speech";
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
let qqLogin: { server: string; proof: LoginProof } | null = null;
let historyEpoch = 0;
let store: StateStore;
let live2dCore: Live2DCore | undefined;
let live2dCoreDownload: Promise<Live2DCore> | undefined;
let live2dCoreError = "";
let dashboard: BrowserWindow | null = null;
let pet: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let cleanupDone = false;
let lastInteraction = Date.now();
let moodTimer: ReturnType<typeof setTimeout> | null = null;
let scheduler: ReturnType<typeof setInterval> | null = null;
let drag: { cursor: Electron.Point; bounds: Electron.Rectangle } | null = null;
let replyQueue: Promise<void> = Promise.resolve();
let lastObservation = 0;
let lastScreenHash = "";
let observing = false;

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
    live2dCoreReady: Boolean(live2dCore),
    live2dCoreDownloading: Boolean(live2dCoreDownload),
    live2dCoreError,
    models: store.state.models.map((model) =>
      model.kind === "live2d" && live2dCore
        ? { ...model, coreUrl: live2dCoreUrl(live2dCore) }
        : model,
    ),
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

function downloadCore(): Promise<Live2DCore> {
  if (live2dCoreDownload) return live2dCoreDownload;
  live2dCoreError = "";
  live2dCoreDownload = (async () => {
    try {
      live2dCore = await downloadLive2DCore(
        join(store.directory, "models"),
        (url, options) => net.fetch(url, options),
      );
      activity("已从 Live2D 官方下载运行库，之后可离线复用");
      return live2dCore;
    } catch (error) {
      live2dCoreError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      live2dCoreDownload = undefined;
      broadcast();
    }
  })();
  broadcast();
  return live2dCoreDownload;
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
function setMood(mood: Mood, resetMs?: number) {
  if (moodTimer) clearTimeout(moodTimer);
  moodTimer = null;
  store.state.mood =
    store.state.focusUntil && mood === "idle" ? "sleeping" : mood;
  if (resetMs) moodTimer = setTimeout(() => setMood("idle"), resetMs);
  broadcast();
}

function trusted(sender: Electron.WebContents) {
  return [dashboard?.webContents.id, pet?.webContents.id].includes(sender.id);
}
function loadWindow(window: BrowserWindow, view: string) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL)
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/?view=${view}`);
  else
    void window.loadFile(join(here, "../renderer/index.html"), {
      query: { view },
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
  loadWindow(dashboard, "dashboard");
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
  loadWindow(pet, "pet");
}

function applyPetSettings() {
  if (!pet) return;
  const settings = store.state.settings;
  const previous = pet.getBounds();
  // Windows 会把不可拉伸窗口的当前尺寸作为最小值，缩小前清除旧约束。
  pet.setMinimumSize(0, 0);
  fitPet(previous.x, previous.y);
  pet.setAlwaysOnTop(settings.alwaysOnTop, "floating");
  pet.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
  if (settings.petVisible) pet.showInactive();
  else pet.hide();
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
  if (connectionChanged && bridge.phase !== "disconnected") {
    await bridge.disconnect();
    activity("连接配置已更新，请重新连接 MaiBot");
  }
  store.state.settings = { ...previous, ...parsed };
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
  if (parsed.petVisible === false) store.state.conversationActive = false;
  await store.save();
  applyPetSettings();
  if ("petPositionLocked" in parsed) updateTrayMenu();
  if (app.isPackaged && "launchAtLogin" in parsed)
    app.setLoginItemSettings({
      openAtLogin: store.state.settings.launchAtLogin,
    });
  broadcast();
  return snapshot();
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
  setMood("thinking", 90000);
  try {
    if (value.source === "proactive")
      await bridge.proactive(value.text, message.id);
    else await bridge.send(value.text, value.image, message.id, value.source);
    message.delivery = "sent";
    await store.save();
    broadcast();
    return true;
  } catch (error) {
    message.delivery =
      error instanceof DeliveryUnknownError ? "unknown" : "failed";
    setMood("idle");
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
        label: "召回桌宠（Ctrl+Shift+M）",
        click: () => {
          void updateSettings({ petVisible: true, clickThrough: false });
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

async function connectAdapter() {
  if (store.state.settings.connectionMode === "server") {
    if (!credential("serverToken"))
      throw new Error(
        "请先通过 QQ 登录并选择桌宠账号，或导入管理员提供的服务器凭证",
      );
    store.selectHistory("server:pending");
    if (store.state.settings.serverAccountId)
      await ensureLocalServer(store.state.settings.serverUrl);
  } else {
    await ensureAdapterToken();
    store.selectHistory("local");
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
      const key = z
        .enum(["adapterToken", "serverToken", "speechKey"])
        .parse(args[0]);
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
      if (key === "adapterToken" || key === "serverToken")
        await bridge.disconnect();
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
      await bridge.disconnect();
      await replyQueue;
      ++historyEpoch;
      store.restoreServerAccount(server, id);
      await updateSettings({ serverAccountId: id, nickname: selected.name });
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
        await bridge.disconnect();
        broadcast();
        activity(`已移除 ${new URL(serverUrl).hostname} 的自定义 WSS 证书`);
      }
      return;
    }
    case "disconnect":
      return bridge.disconnect();
    case "send":
      return send(sendSchema.parse(args[0]));
    case "clearHistory": {
      const currentHistory = store.state.history;
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
      await downloadCore();
      return;
    }
    case "importLive2DCore": {
      const selected = await dialog.showOpenDialog({
        title: "设置 Live2D 运行库（只需一次，可供其他模型复用）",
        properties: ["openFile"],
        filters: [{ name: "Cubism Core", extensions: ["js"] }],
      });
      if (selected.canceled) return false;
      live2dCore = await installLive2DCore(
        join(store.directory, "models"),
        selected.filePaths[0],
      );
      live2dCoreError = "";
      activity("Live2D 运行库已保存，导入其他模型时会自动复用");
      return true;
    }
    case "importModel": {
      const selected = await dialog.showOpenDialog({
        title: "导入角色模型或图片",
        properties: ["openFile"],
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
      const file = selected.filePaths[0];
      const modelsRoot = join(store.directory, "models");
      let coreFile: string | undefined;
      if (file.toLowerCase().endsWith(".model3.json")) {
        coreFile = (await findLive2DCore(modelsRoot))?.file;
        if (!coreFile) {
          const candidate = join(dirname(file), LIVE2D_CORE_FILE);
          try {
            await access(candidate);
            coreFile = candidate;
          } catch {
            // 首次设置时，也可以选择保存在其他目录的官方 Core。
          }
        }
        if (!coreFile) {
          coreFile = (await downloadCore()).file;
        }
      }
      const model = await importModelFile(file, modelsRoot, coreFile);
      if (model.kind === "live2d")
        live2dCore = await findLive2DCore(modelsRoot);
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
    case "synthesize":
      return synthesizeAudio(
        store.state.settings,
        credential("speechKey"),
        z.string().min(1).max(12000).parse(args[0]),
      );
    case "voiceConversation": {
      const active = z.boolean().parse(args[0]);
      if (active && bridge.phase !== "connected")
        throw new Error("请先连接 MaiBot，再开启连续语音");
      if (active && store.state.focusUntil)
        throw new Error("请先结束专注模式，再开启连续语音");
      if (active && !store.state.settings.petVisible)
        await updateSettings({ petVisible: true });
      store.state.conversationActive = active;
      broadcast();
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
      setMood(minutes ? "sleeping" : "idle");
      activity(minutes ? `开始 ${minutes} 分钟专注陪伴` : "专注已结束");
      return;
    }
    case "showPet":
      await updateSettings({ petVisible: true, clickThrough: false });
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
  if (scheduler) clearInterval(scheduler);
  if (moodTimer) clearTimeout(moodTimer);
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
    serverCertificates = new ServerCertificateStore(store.directory);
    try {
      await serverCertificates.load();
    } catch (error) {
      // 可选证书存储损坏时保持 TLS 默认拒绝，不让它阻止用户启动后重新导入。
      activity(error instanceof Error ? error.message : String(error), "error");
    }
    await pruneMedia(store.directory, store.allHistory());
    live2dCore = await findLive2DCore(join(store.directory, "models"));
    store.state.models = store.state.models.map(withModelUrls);
    if (!store.state.settings.corePath && !app.isPackaged)
      store.state.settings.corePath = join(root, "MaiBot");
    protocol.handle("mai-asset", async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname === "runtime") {
          if (
            !live2dCore ||
            url.pathname !== `/${LIVE2D_CORE_FILE}` ||
            url.searchParams.get("v") !== live2dCore.revision
          )
            return new Response("Not found", { status: 404 });
          return net.fetch(pathToFileURL(live2dCore.file).toString());
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
    protocol.handle("mai-media", async (request) => {
      try {
        return await net.fetch(
          pathToFileURL(mediaFile(store.directory, request.url)).toString(),
        );
      } catch {
        return new Response("Not found", { status: 404 });
      }
    });
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
          activity(message, "error");
          return { ok: false, error: message };
        }
      },
    );
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
    ipcMain.on("mai:interactive", (event, value: unknown) => {
      if (
        event.sender.id === pet?.webContents.id &&
        typeof value === "boolean" &&
        store.state.settings.clickThrough
      )
        pet?.setIgnoreMouseEvents(!value, { forward: true });
    });
    bridge.on("status", (status: Snapshot["connection"]) => {
      ++historyEpoch;
      if (
        status.phase === "connected" &&
        store.state.settings.connectionMode === "server" &&
        status.userId
      ) {
        const key = createHash("sha256")
          .update(`${store.state.settings.serverUrl}\n${status.userId}`)
          .digest("hex");
        store.selectHistory(`server:${key}`);
        persist();
      }
      store.state.connection = status;
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
      if (status.phase !== "connected") store.state.conversationActive = false;
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
      const history = store.state.history;
      replyQueue = replyQueue
        .catch(() => {})
        .then(async () => {
          if (epoch !== historyEpoch || history !== store.state.history) return;
          const removed = history.splice(0);
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
    bridge.on(
      "reply",
      (
        reply: {
          id: string;
          text: string;
          attachments: ChatMessage["attachments"];
        },
        acknowledge: (error?: Error) => void,
      ) => {
        const history = store.state.history;
        replyQueue = replyQueue
          .then(async () => {
            if (
              history.some(
                (message) =>
                  message.id === reply.id && message.role === "assistant",
              )
            ) {
              await store.flush();
              acknowledge();
              return;
            }
            const attachments = [];
            for (const attachment of reply.attachments || [])
              attachments.push(
                await saveAttachment(store.directory, attachment),
              );
            history.push({
              ...reply,
              attachments: attachments.length ? attachments : undefined,
              role: "assistant",
              timestamp: Date.now(),
              source: "core",
            });
            if (history.length > 1000) history.splice(0, history.length - 1000);
            lastInteraction = Date.now();
            setMood("happy", 10000);
            await store.save();
            broadcast();
            acknowledge();
          })
          .catch((error) => {
            acknowledge(
              error instanceof Error ? error : new Error(String(error)),
            );
            activity(`保存内核回复失败：${String(error)}`, "error");
          });
      },
    );
    localServer.on("log", (text: string) => activity(text));
    createDashboard();
    createPet();
    createTray();
    globalShortcut.register("CommandOrControl+Shift+M", () => {
      void updateSettings({ petVisible: true, clickThrough: false });
      dashboard?.show();
    });
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
    dialog.showErrorBox("Mai 启动失败", String(error));
    app.quit();
  });
