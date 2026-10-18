import { useState } from "react";
import {
  LoaderCircle,
  Play,
  Plug,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { api, perform, showToast } from "../api";
import { Field, Panel, Status } from "../components/ui";
import { ServerAccounts } from "../components/ServerAccounts";
import { LegacyConnection } from "../components/LegacyConnection";
import { MessageAdapterConnection } from "../components/MessageAdapterConnection";
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
  const active =
    state.settings.connectionMode === "server" &&
    ["connected", "connecting", "reconnecting"].includes(
      state.connection.phase,
    );
  let wssHost = "";
  try {
    const url = new URL(draft.serverUrl);
    if (url.protocol === "wss:") wssHost = url.hostname.toLowerCase();
  } catch {
    /* 地址输入未完成时不启用证书操作。 */
  }
  const certificate = state.serverCertificates.find(
    (item) => item.host === wssHost,
  );
  const certificateExpired = Boolean(
    certificate && certificate.validTo <= Date.now(),
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
          <p>连接自己的 MaiBot，或通过 QQ 登录桌宠服务器。</p>
        </div>
        <Status state={state} />
      </div>
      <div className="settings-columns core-columns">
        <div className="settings-stack">
          <MessageAdapterConnection state={state} />
          <Panel
            title="服务器连接"
            subtitle={
              state.settings.connectionMode === "server"
                ? state.connection.detail
                : "使用服务方提供的地址，通过 QQ 登录。"
            }
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
                hint="填写服务方提供的 ws:// 或 wss:// 地址；公网建议使用 wss://。"
              >
                <input
                  type="url"
                  required
                  value={draft.serverUrl}
                  placeholder="ws://192.168.1.10:18766/desktop"
                  onChange={(event) => change("serverUrl", event.target.value)}
                />
              </Field>
              <div
                className={`server-certificate ${certificate ? "trusted" : ""} ${certificateExpired ? "expired" : ""}`}
              >
                <ShieldCheck size={18} />
                <div>
                  <strong>
                    {certificate
                      ? certificateExpired
                        ? "自定义证书已过期"
                        : "自定义 WSS 证书已导入"
                      : "自签名或私有 CA"}
                  </strong>
                  {certificate ? (
                    <>
                      <small>
                        {certificate.host} · {certificate.certificateCount}{" "}
                        张证书 · 有效至{" "}
                        {new Date(certificate.validTo).toLocaleDateString()}
                      </small>
                      <code title={certificate.fingerprint256}>
                        SHA-256{" "}
                        {certificate.fingerprint256
                          .split(":")
                          .slice(0, 6)
                          .join(":")}
                        …
                      </code>
                    </>
                  ) : (
                    <small>
                      WSS 使用非公开证书时，在这里导入 CA
                      或服务器证书；不要导入私钥。
                    </small>
                  )}
                </div>
                <span className="server-certificate-actions">
                  <button
                    type="button"
                    className="text-button small"
                    disabled={busy || !wssHost}
                    title={
                      wssHost
                        ? "导入 PEM、CRT、CER 或 DER 证书"
                        : "请先填写 wss:// 服务器地址"
                    }
                    onClick={() => {
                      setBusy(true);
                      void perform(async () => {
                        if (await api.importServerCertificate(draft.serverUrl))
                          showToast("自定义 WSS 证书已导入");
                      }).finally(() => setBusy(false));
                    }}
                  >
                    <Upload size={14} /> {certificate ? "替换" : "导入"}
                  </button>
                  {certificate && (
                    <button
                      type="button"
                      className="text-button small muted"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        void perform(
                          () => api.removeServerCertificate(draft.serverUrl),
                          "自定义 WSS 证书已移除",
                        ).finally(() => setBusy(false));
                      }}
                    >
                      <Trash2 size={13} /> 移除
                    </button>
                  )}
                </span>
              </div>
              <p className="certificate-hint">
                自定义信任只应用于该 IP
                或主机，客户端仍会校验证书有效期和主机名。
              </p>
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
