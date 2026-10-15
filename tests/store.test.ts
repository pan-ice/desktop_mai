import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { defaultSettings } from "../shared/defaults";
import { StateStore } from "../electron/store";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe("持久化版本迁移", () => {
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
