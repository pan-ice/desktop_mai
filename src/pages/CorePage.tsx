import { useRef, useState } from "react";
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
  const [operation, setOperation] = useState("");
  const pending = useRef(false);
  const busy = Boolean(operation);
  const addressDirty = draft.serverUrl !== state.settings.serverUrl;
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
  const run = async (
    name: string,
    action: () => Promise<unknown>,
    success?: string,
  ) => {
    if (pending.current) return;
    pending.current = true;
    setOperation(name);
    try {
      await perform(action, success);
    } finally {
      pending.current = false;
      setOperation("");
    }
  };
  const saveConnection = () =>
    run("connection", async () => {
      const updated = await api.updateSettings({
        connectionMode: "server",
        serverUrl: draft.serverUrl.trim(),
      });
      change("serverUrl", updated.settings.serverUrl);
      if (updated.credentials.serverToken && updated.settings.serverAccountId) {
        await api.connect();
        showToast("服务器地址已保存，连接请求已发送");
      } else if (updated.credentials.serverToken) {
        showToast("服务器地址已保存，请在「桌宠账号」选择或新建账号");
      } else {
        showToast("服务器地址已保存，在「桌宠账号」登录 QQ 后即可连接");
      }
    });

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
              aria-busy={busy}
            >
              <Field
                label="服务器地址"
                hint="填写服务方提供的 ws:// 或 wss:// 地址；公网建议使用 wss://。"
              >
                <input
                  type="url"
                  required
                  disabled={busy}
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
                      void run("certificate-import", async () => {
                        if (await api.importServerCertificate(draft.serverUrl))
                          showToast("自定义 WSS 证书已导入");
                      });
                    }}
                  >
                    {operation === "certificate-import" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Upload size={14} />
                    )}
                    {operation === "certificate-import"
                      ? "正在导入…"
                      : certificate
                        ? "替换"
                        : "导入"}
                  </button>
                  {certificate && (
                    <button
                      type="button"
                      className="text-button small muted"
                      disabled={busy}
                      onClick={() => {
                        void run(
                          "certificate-remove",
                          () => api.removeServerCertificate(draft.serverUrl),
                          "自定义 WSS 证书已移除",
                        );
                      }}
                    >
                      {operation === "certificate-remove" ? (
                        <LoaderCircle size={13} className="spin" />
                      ) : (
                        <Trash2 size={13} />
                      )}
                      {operation === "certificate-remove"
                        ? "正在移除…"
                        : "移除"}
                    </button>
                  )}
                </span>
              </div>
              <p className="certificate-hint">
                自定义信任只应用于该 IP
                或主机，客户端仍会校验证书有效期和主机名。
              </p>
              <div className="form-actions">
                <p
                  className={`form-state ${addressDirty ? "dirty" : ""}`}
                  role="status"
                >
                  {operation === "connection"
                    ? "正在保存并检查连接…"
                    : addressDirty
                      ? "地址尚未保存，离开本页会放弃修改。"
                      : state.settings.serverAccountId
                        ? "使用已保存的地址与账号连接。"
                        : "保存地址后，在「桌宠账号」完成登录与选择。"}
                </p>
                {active && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        "disconnect",
                        () => api.disconnect(),
                        "已断开服务器连接",
                      )
                    }
                  >
                    {operation === "disconnect" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Square size={14} />
                    )}
                    {operation === "disconnect" ? "正在断开…" : "断开"}
                  </button>
                )}
                <button
                  type="submit"
                  className="button primary"
                  disabled={busy || !draft.serverUrl.trim()}
                >
                  {operation === "connection" ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : selectedAccount ? (
                    <RefreshCw size={16} />
                  ) : (
                    <Plug size={16} />
                  )}
                  {operation === "connection"
                    ? "正在保存…"
                    : selectedAccount
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
                  void run("local", async () => {
                    const url = await api.prepareLocalServer();
                    if (url) {
                      change("serverUrl", url);
                      showToast("本机连接已准备好，可在「桌宠账号」继续登录");
                    }
                  });
                }}
              >
                {operation === "local" ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Play size={16} />
                )}
                {operation === "local"
                  ? "正在准备本机连接…"
                  : "本机测试（自动初始化）"}
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
