import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { defaultSettings } from "../shared/defaults";
import { StateStore } from "../electron/store";
import { ttsProfile, ttsProviders } from "../shared/tts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe("持久化版本迁移", () => {
  it("旧版语音配置继续使用原服务、模型与音色", async () => {
    const base = resolve(".cache/tests");
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "speech-legacy-"));
    directories.push(directory);
    await writeFile(
      join(directory, "state.json"),
      JSON.stringify({
        version: 2,
        settings: {
          ttsEngine: "api",
          speechBaseUrl: "http://localhost:9000/v1",
          ttsModel: "existing-model",
          ttsVoice: "existing-voice",
        },
        history: [],
        models: [],
        encrypted: { speechKey: "existing-ciphertext" },
      }),
    );
    const store = new StateStore(directory);
    await store.load();
    expect(ttsProfile(store.state.settings)).toMatchObject({
      baseUrl: "http://localhost:9000/v1",
      model: "existing-model",
      voice: "existing-voice",
    });
    expect(store.state.clonedVoices).toEqual([]);
    expect(store.state.credentials.speechKey).toBe(true);
    expect(store.state.credentials.ttsSiliconflowKey).toBe(false);
  });
  it("五家合成配置、复刻音色与密文独立保存并重启恢复", async () => {
    const base = resolve(".cache/tests");
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "speech-providers-"));
    directories.push(directory);
    const store = new StateStore(directory);
    store.state.settings.ttsProvider = "bailian";
    for (const provider of [
      "siliconflow",
      "bailian",
      "minimax",
      "volcengine",
      "mimo",
    ] as const) {
      const spec = ttsProviders[provider];
      store.state.settings.ttsProfiles[provider] = {
        ...spec.defaults,
        voice: `custom-${provider}`,
      };
      store.encrypted[spec.key] = `ciphertext-${provider}`;
    }
    expect(defaultSettings.ttsProfiles).toEqual({});
    expect(new StateStore(directory).state.settings.ttsProfiles).toEqual({});
    store.state.clonedVoices.push({
      id: "fa105858-b614-467d-917c-ebcb1236b6bf",
      name: "麦麦",
      provider: "bailian",
      voiceId: "custom-bailian",
      profile: store.state.settings.ttsProfiles.bailian!,
      status: "pending",
      createdAt: 1,
    });
    await store.save();
    const restored = new StateStore(directory);
    await restored.load();
    expect(restored.state.settings).toEqual(store.state.settings);
    expect(restored.state.clonedVoices).toEqual(store.state.clonedVoices);
    expect(restored.encrypted).toEqual(store.encrypted);
    for (const provider of [
      "siliconflow",
      "bailian",
      "minimax",
      "volcengine",
      "mimo",
    ] as const)
      expect(restored.state.credentials[ttsProviders[provider].key]).toBe(true);
  });
  it("从本机移除桌宠后重启仍保留偏好和聊天记录，其他服务器与设备不受影响", async () => {
    const base = resolve(".cache/tests");
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "removed-account-"));
    directories.push(directory);
    const server = "wss://mai.example.com/desktop";
    const otherServer = "wss://other.example.com/desktop";
    const id = "pet_" + "a".repeat(32);
    const store = new StateStore(directory);
    store.selectHistory("server:pet-history");
    store.state.history.push({
      id: "retained",
      text: "移除后仍保留的聊天记录",
      role: "user",
      source: "text",
      timestamp: 1,
    });
    store.selectHistory("server:pending");
    store.removeServerAccount(server, id);
    await store.save();
    const restored = new StateStore(directory);
    await restored.load();
    expect(restored.removedAccounts(server)).toEqual([id]);
    expect(restored.removedAccounts(otherServer)).toEqual([]);
    expect(new StateStore("另一台设备").removedAccounts(server)).toEqual([]);
    restored.restoreServerAccount(server, id);
    restored.selectHistory("server:pet-history");
    expect(restored.state.history.map((message) => message.id)).toEqual([
      "retained",
    ]);
    await restored.save();
    const afterRestoring = new StateStore(directory);
    await afterRestoring.load();
    expect(afterRestoring.removedAccounts(server)).toEqual([]);
    expect(afterRestoring.state.history[0].text).toBe("移除后仍保留的聊天记录");
  });

  it("切换服务器用户后分别保留历史，重新加载和切回后仍归属于原账号", async () => {
    const base = resolve(".cache/tests");
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "profiles-"));
    directories.push(directory);
    const store = new StateStore(directory);
    store.state.history.push({
      id: "local",
      text: "本机",
      role: "user",
      timestamp: 1,
      source: "text",
    });
    store.selectHistory("server:alice");
    expect(store.state.history).toHaveLength(0);
    store.state.history.push({
      id: "alice",
      text: "Alice",
      role: "user",
      timestamp: 2,
      source: "text",
    });
    store.selectHistory("server:bob");
    expect(store.state.history).toHaveLength(0);
    await store.save();
    const restored = new StateStore(directory);
    await restored.load();
    expect(restored.state.history).toHaveLength(0);
    expect(
      restored
        .allHistory()
        .map((item) => item.id)
        .sort(),
    ).toEqual(["alice", "local"]);
    restored.selectHistory("server:alice");
    expect(restored.state.history.map((item) => item.id)).toEqual(["alice"]);
    restored.selectHistory("local");
    expect(restored.state.history.map((item) => item.id)).toEqual(["local"]);
  });
  it("备份 v1，保留身份、历史和声音密钥，旧内核令牌不复用", async () => {
    const base = resolve(".cache/tests");
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "migration-"));
    directories.push(directory);
    const {
      adapterPort: _port,
      adapterScope: _scope,
      ...oldSettings
    } = defaultSettings;
    const original = JSON.stringify({
      version: 1,
      settings: {
        ...oldSettings,
        maibotUrl: "ws://127.0.0.1:8000/ws",
        userId: "existing-owner",
        platform: "existing_pet",
      },
      history: [{ id: "old-chat" }],
      models: [],
      encrypted: {
        maibotToken: "old-ciphertext",
        speechKey: "speech-ciphertext",
      },
    });
    await writeFile(join(directory, "state.json"), original);
    const store = new StateStore(directory);
    await store.load();
    expect(
      await readFile(join(directory, "state.v1.backup.json"), "utf8"),
    ).toBe(original);
    expect(store.state.settings).toMatchObject({
      userId: "existing-owner",
      platform: "existing_pet",
      adapterPort: 18765,
      adapterScope: "",
      autoConnect: false,
    });
    expect(store.state.history[0].id).toBe("old-chat");
    expect(store.encrypted).toEqual({ speechKey: "speech-ciphertext" });
    expect(
      JSON.parse(await readFile(join(directory, "state.json"), "utf8")).version,
    ).toBe(2);
    const reloaded = new StateStore(directory);
    await reloaded.load();
    expect(reloaded.state.settings.userId).toBe("existing-owner");
  });
});
