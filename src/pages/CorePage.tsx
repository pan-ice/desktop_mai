import { useState } from "react";
import { LoaderCircle, Play, Plug, RefreshCw, Square } from "lucide-react";
import { api, perform } from "../api";
import { Field, Panel, Status } from "../components/ui";
import { ServerAccounts } from "../components/ServerAccounts";
import { LegacyConnection } from "../components/LegacyConnection";
import { useSettingsDraft } from "./SensesPage";
import type { Snapshot } from "../../shared/types";

export function CorePage({ state }: { state: Snapshot }) {
  const { draft, change } = useSettingsDraft(state.settings);
  const [busy, setBusy] = useState(false);
  const connected = state.connection.phase === "connected";
  const selectedAccount =
    state.settings.connectionMode === "server" &&
    state.settings.serverAccountId &&
    state.settings.serverUrl === draft.serverUrl;
  const active = ["connected", "connecting", "reconnecting"].includes(
    state.connection.phase,
  );
  const saveConnection = async () => {
    setBusy(true);
    try {
      await perform(async () => {
        const updated = await api.updateSettings({
          connectionMode: "server",
          serverUrl: draft.serverUrl,
        });
        if (updated.credentials.serverToken && updated.settings.serverAccountId)
          await api.connect();
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>连接与账号</h1>
          <p>通过 QQ 登录，选择你的桌宠，继续上次的聊天。</p>
        </div>
        <Status state={state} />
      </div>
      <div className="settings-columns core-columns">
        <div className="settings-stack">
          <Panel
            title="服务器连接"
            subtitle={state.connection.detail}
            action={<Plug size={19} className="muted" />}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveConnection();
              }}
            >
              <Field
                label="服务器地址"
                hint="填写服务方提供的 wss://域名/desktop 地址。"
              >
                <input
                  type="url"
                  required
                  value={draft.serverUrl}
                  placeholder="wss://mai.example.com/desktop"
                  onChange={(event) => change("serverUrl", event.target.value)}
                />
              </Field>
              <div className="form-actions">
                {active && (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => void perform(() => api.disconnect())}
                  >
                    <Square size={14} /> 断开
                  </button>
                )}
                <button
                  type="submit"
                  className="button primary"
                  disabled={busy || !draft.serverUrl.trim()}
                >
                  {busy ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : selectedAccount ? (
                    <RefreshCw size={16} />
                  ) : (
                    <Plug size={16} />
                  )}
                  {selectedAccount
                    ? connected
                      ? "重新连接服务器"
                      : "连接服务器"
                    : "保存地址"}
                </button>
              </div>
            </form>
          </Panel>
          <details className="connection-more local-testing">
            <summary>本机测试</summary>
            <div className="connection-more-content">
              <p className="helper-text">
                MaiBot 已在本机运行时，可自动准备桌宠连接。
              </p>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void perform(async () => {
                    const url = await api.prepareLocalServer();
                    if (url) change("serverUrl", url);
                  }).finally(() => setBusy(false));
                }}
              >
                {busy ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Play size={16} />
                )}
                本机测试（自动初始化）
              </button>
            </div>
          </details>
          <LegacyConnection state={state} />
        </div>
        <div className="settings-stack">
          <ServerAccounts state={state} serverUrl={draft.serverUrl} />
        </div>
      </div>
    </>
  );
}
