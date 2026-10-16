import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Laptop,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { api, perform, showToast } from "../api";
import { Field, Panel } from "./ui";
import type {
  AuthorizedDevice,
  PetAccount,
  QQLoginChallenge,
} from "../../shared/accounts";
import type { Snapshot } from "../../shared/types";

export function ServerAccounts({
  state,
  serverUrl,
}: {
  state: Snapshot;
  serverUrl: string;
}) {
  const [challenge, setChallenge] = useState<QQLoginChallenge | null>(null);
  const [deviceName, setDeviceName] = useState("我的电脑");
  const [name, setName] = useState("");
  const [accounts, setAccounts] = useState<PetAccount[]>([]);
  const [removing, setRemoving] = useState<PetAccount | null>(null);
  const [devices, setDevices] = useState<AuthorizedDevice[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    const [accounts, devices] = await Promise.all([
      api.serverAccounts(),
      api.serverDevices(),
    ]);
    setAccounts(accounts);
    setDevices(devices);
    setAuthorized(true);
    setMessage("");
  }, []);

  useEffect(() => {
    setAuthorized(false);
    setAccounts([]);
    setDevices([]);
    setRemoving(null);
    if (
      state.credentials.serverToken &&
      state.settings.connectionMode === "server" &&
      state.settings.serverUrl === serverUrl
    )
      void refresh().catch(() =>
        setMessage("通过 QQ 验证后，即可选择已有桌宠或新建一个。"),
      );
  }, [
    state.credentials.serverToken,
    state.settings.connectionMode,
    state.settings.serverUrl,
    serverUrl,
    refresh,
  ]);

  useEffect(() => {
    if (state.connection.phase !== "error" || !state.settings.serverAccountId)
      return;
    void refresh().catch(() => {
      setAuthorized(false);
      setAccounts([]);
      setDevices([]);
      setMessage("设备授权已失效，请通过 QQ 重新登录。");
    });
  }, [state.connection.phase, state.settings.serverAccountId, refresh]);

  useEffect(() => {
    if (!challenge) return;
    let stopped = false;
    let polling = false;
    const timer = setInterval(() => {
      if (polling || stopped) return;
      polling = true;
      void api
        .pollQQLogin()
        .then(async (status) => {
          if (stopped) return;
          if (status === "confirmed") {
            setChallenge(null);
            await refresh();
            showToast("QQ 验证成功，请选择或新建桌宠账号");
          } else if (status === "expired") {
            setChallenge(null);
            setMessage("登录码已过期，请重新申请。");
          }
        })
        .catch((error: Error) => {
          if (!stopped) {
            setChallenge(null);
            setMessage(error.message);
          }
        })
        .finally(() => {
          polling = false;
        });
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [challenge, refresh]);

  useEffect(
    () => () => {
      void api.cancelQQLogin().catch(() => {});
    },
    [],
  );

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await perform(action);
    setBusy(false);
  };
  const removed = new Set(state.removedServerAccounts);
  const visibleAccounts = accounts.filter(
    (account) => !removed.has(account.id),
  );
  const removedAccounts = accounts.filter((account) => removed.has(account.id));

  return (
    <>
      <Panel
        title="桌宠账号"
        subtitle="每个桌宠保留自己的聊天记录。"
        action={<ShieldCheck size={19} className="muted" />}
      >
        {!authorized && !challenge && (
          <>
            <Field
              label="这台设备的名称"
              hint="验证时会显示这个名称，便于日后管理授权设备。"
            >
              <input
                value={deviceName}
                maxLength={40}
                onChange={(event) => setDeviceName(event.target.value)}
              />
            </Field>
            <button
              type="button"
              className="button primary"
              disabled={busy || !serverUrl || !deviceName.trim()}
              onClick={() =>
                void run(async () => {
                  setMessage("");
                  setChallenge(
                    await api.beginQQLogin(serverUrl, deviceName.trim()),
                  );
                })
              }
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <ShieldCheck size={16} />
              )}{" "}
              通过 QQ 登录
            </button>
            {!serverUrl && (
              <p className="helper-text">
                先在左侧填写管理员提供的服务器地址。
              </p>
            )}
          </>
        )}
        {challenge && (
          <div className="qq-login-challenge" role="status">
            <strong>用自己的 QQ 私聊这台服务器的 MaiBot</strong>
            <p>发送下方命令，授权「{deviceName}」登录。登录码 5 分钟内有效。</p>
            <input
              aria-label="QQ 登录命令"
              readOnly
              value={`/桌宠登录 ${challenge.code}`}
              onFocus={(event) => event.target.select()}
            />
            <p className="helper-text">
              <LoaderCircle size={14} className="spin" /> 等待 QQ 确认…
            </p>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                void run(async () => {
                  setChallenge(null);
                  await api.cancelQQLogin();
                })
              }
            >
              取消登录
            </button>
          </div>
        )}
        {message && (
          <p className="helper-text" role="status">
            {message}
          </p>
        )}
        {authorized && (
          <>
            <div className="form-actions">
              <span className="helper-text">
                <ShieldCheck size={14} /> 这台设备已通过 QQ 验证
              </span>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void run(refresh)}
              >
                <RefreshCw size={14} /> 刷新
              </button>
            </div>
            <div className="server-account-list">
              {visibleAccounts.map((account) => {
                const active = state.settings.serverAccountId === account.id;
                return (
                  <div className="server-account-row" key={account.id}>
                    <button
                      type="button"
                      className={`server-account ${active ? "selected" : ""}`}
                      disabled={busy}
                      onClick={() =>
                        void run(() => api.selectServerAccount(account.id))
                      }
                    >
                      <span>
                        <strong>{account.name}</strong>
                        <small>
                          {active ? "当前桌宠" : "独立会话与聊天记录"}
                        </small>
                      </span>
                      {active ? <Check size={18} /> : <span>切换 →</span>}
                    </button>
                    <button
                      type="button"
                      className="text-button small muted server-account-remove"
                      aria-label={`从本机移除桌宠 ${account.name}`}
                      disabled={busy}
                      onClick={() => setRemoving(account)}
                    >
                      <X size={14} /> 移除
                    </button>
                  </div>
                );
              })}
            </div>
            {removing && (
              <div className="server-account-removal" role="alert">
                <strong>从本机移除「{removing.name}」？</strong>
                <p>
                  仅从这台电脑的列表移除，聊天记录全部保留，其他电脑仍可继续使用。以后可通过“添加已有桌宠”恢复。
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => setRemoving(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.removeServerAccount(removing.id);
                        setRemoving(null);
                        await refresh();
                        showToast("已从本机移除，账号和聊天记录已保留");
                      })
                    }
                  >
                    确认移除
                  </button>
                </div>
              </div>
            )}
            {!visibleAccounts.length && (
              <p className="helper-text">
                {removedAccounts.length
                  ? "本机列表为空，可以添加已有桌宠或新建一个。"
                  : "这个 QQ 还没有桌宠账号，给第一个桌宠取个名字吧。"}
              </p>
            )}
            {removedAccounts.length > 0 && (
              <details className="server-account-restore">
                <summary>添加已有桌宠（{removedAccounts.length}）</summary>
                {removedAccounts.map((account) => (
                  <div className="server-account-restore-item" key={account.id}>
                    <span>{account.name}</span>
                    <button
                      type="button"
                      className="text-button small"
                      disabled={busy}
                      aria-label={`添加已有桌宠 ${account.name}`}
                      onClick={() =>
                        void run(async () => {
                          await api.selectServerAccount(account.id);
                          await refresh();
                        })
                      }
                    >
                      <Plus size={14} /> 添加并连接
                    </button>
                  </div>
                ))}
              </details>
            )}
            <Field label="新桌宠的名称">
              <input
                value={name}
                maxLength={40}
                placeholder="例如：小麦"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <button
              type="button"
              className="button secondary"
              disabled={busy || !name.trim()}
              onClick={() =>
                void run(async () => {
                  const account = await api.createServerAccount(name.trim());
                  setName("");
                  await refresh();
                  await api.selectServerAccount(account.id);
                })
              }
            >
              <Plus size={15} /> 新建桌宠并连接
            </button>
            <p className="helper-text">换电脑时选择已有桌宠即可继续聊天。</p>
          </>
        )}
      </Panel>
      {authorized && (
        <details className="connection-more server-devices">
          <summary>设备管理（{devices.length}）</summary>
          <div className="connection-more-content">
            <p className="helper-text">
              可以移除不再使用的电脑，账号和聊天记录会保留。
            </p>
            {devices.map((device) => (
              <div className="server-device" key={device.id}>
                <Laptop size={18} className="muted" />
                <span>
                  <strong>{device.name}</strong>
                  <small>{device.current ? "当前设备" : "已授权"}</small>
                </span>
                <button
                  type="button"
                  className="text-button small muted"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.revokeServerDevice(device.id);
                      if (device.current) {
                        setAuthorized(false);
                        setDevices([]);
                        setAccounts([]);
                      } else await refresh();
                    })
                  }
                >
                  <X size={14} /> {device.current ? "退出此设备" : "移除"}
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
