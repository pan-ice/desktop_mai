import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaultSettings, emptySnapshot } from "../shared/defaults";
import { serverUrlSchema, settingsPatchSchema } from "../shared/schemas";
import type { CredentialKey, Snapshot } from "../shared/types";

interface Persisted {
  version: 2;
  settings: Snapshot["settings"];
  history: Snapshot["history"];
  models: Snapshot["models"];
  encrypted: Partial<Record<CredentialKey, string>>;
  petPosition?: { x: number; y: number };
  historyScope?: string;
  archivedHistories?: Record<string, Snapshot["history"]>;
  removedServerAccounts?: Record<string, string[]>;
}

export class StateStore {
  state = emptySnapshot(true);
  encrypted: Persisted["encrypted"] = {};
  petPosition: Persisted["petPosition"];
  private historyScope = "local";
  private archivedHistories: Record<string, Snapshot["history"]> = {};
  private removedServerAccounts: Record<string, string[]> = {};
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}

  async load() {
    await mkdir(this.directory, { recursive: true });
    try {
      const data = JSON.parse(
        await readFile(join(this.directory, "state.json"), "utf8"),
      );
      if (data.version !== 1 && data.version !== 2)
        throw new Error("不支持的数据版本");
      if (data.version === 1) {
        // 先逐字节备份，保留旧安装的配置与密文；旧内核令牌不复用于插件。
        await copyFile(
          join(this.directory, "state.json"),
          join(this.directory, "state.v1.backup.json"),
        );
        delete data.settings.maibotUrl;
        delete data.encrypted.maibotToken;
        data.settings.autoConnect = false;
        this.state.activity.push({
          id: "adapter-migration-v2",
          level: "info",
          timestamp: Date.now(),
          text: "已升级至独立插件接入。聊天记录与会话身份已保留，可在「连接与账号」的「旧版接入」中导出插件配置。旧数据已备份。",
        });
      }
      this.state.settings = {
        ...defaultSettings,
        ...settingsPatchSchema.parse(data.settings),
      };
      this.state.history = data.history.slice(-1000);
      this.historyScope = data.historyScope || "local";
      this.archivedHistories = data.archivedHistories || {};
      this.removedServerAccounts = z
        .record(
          serverUrlSchema,
          z.array(z.string().regex(/^pet_[a-f0-9]{32}$/)),
        )
        .parse(data.removedServerAccounts ?? {});
      this.state.models = data.models;
      this.encrypted = data.encrypted;
      this.petPosition = data.petPosition;
      for (const key of ["adapterToken", "serverToken", "speechKey"] as const)
        this.state.credentials[key] = Boolean(this.encrypted[key]);
      if (data.version === 1) await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          `无法读取本地数据，请检查 ${join(this.directory, "state.json")}：${String(error)}`,
        );
    }
  }

  save(): Promise<void> {
    const content = JSON.stringify(
      {
        version: 2,
        settings: this.state.settings,
        history: this.state.history.slice(-1000),
        models: this.state.models,
        encrypted: this.encrypted,
        petPosition: this.petPosition,
        historyScope: this.historyScope,
        archivedHistories: this.archivedHistories,
        removedServerAccounts: this.removedServerAccounts,
      } satisfies Persisted,
      null,
      2,
    );
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        const target = join(this.directory, "state.json");
        await writeFile(`${target}.tmp`, content, "utf8");
        await rename(`${target}.tmp`, target);
      });
    this.queue = operation;
    return operation;
  }

  flush() {
    return this.queue;
  }

  selectHistory(scope: string) {
    if (scope === this.historyScope) return;
    if (this.historyScope !== "server:pending")
      this.archivedHistories[this.historyScope] = this.state.history;
    this.state.history = this.archivedHistories[scope] || [];
    delete this.archivedHistories[scope];
    this.historyScope = scope;
  }

  allHistory(): Snapshot["history"] {
    return [
      this.state.history,
      ...Object.values(this.archivedHistories),
    ].flat();
  }

  removedAccounts(serverUrl: string): string[] {
    if (!serverUrl) return [];
    return [...(this.removedServerAccounts[new URL(serverUrl).href] || [])];
  }

  removeServerAccount(serverUrl: string, id: string) {
    const key = new URL(serverUrl).href;
    this.removedServerAccounts[key] = [
      ...new Set([...this.removedAccounts(serverUrl), id]),
    ];
  }

  restoreServerAccount(serverUrl: string, id: string) {
    const key = new URL(serverUrl).href;
    const remaining = this.removedAccounts(serverUrl).filter(
      (removed) => removed !== id,
    );
    if (remaining.length) this.removedServerAccounts[key] = remaining;
    else delete this.removedServerAccounts[key];
  }
}
