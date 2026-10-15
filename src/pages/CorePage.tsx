import { useState } from "react";
import {
  ArrowUpRight,
  Blocks,
  Brain,
  ChevronRight,
  Download,
  Cpu,
  ExternalLink,
  FolderOpen,
  Heart,
  KeyRound,
  LoaderCircle,
  Play,
  Plug,
  RefreshCw,
  Square,
} from "lucide-react";
import { api, perform } from "../api";
import { Field, Panel, Status } from "../components/ui";
import { useSettingsDraft } from "./SensesPage";
import type { Snapshot } from "../../shared/types";

export function CorePage({ state }: { state: Snapshot }) {
  const { draft, change } = useSettingsDraft(state.settings);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const connected = state.connection.phase === "connected";
  const server = draft.connectionMode === "server";
  const credentialKey = server ? "serverToken" : "adapterToken";
  const connect = async () => {
    setBusy(true);
    await perform(async () => {
      if (token) {
        await api.setCredential(credentialKey, token);
        setToken("");
      }
      await api.updateSettings({
        connectionMode: draft.connectionMode,
        serverUrl: draft.serverUrl,
        adapterPort: draft.adapterPort,
        adapterScope: draft.adapterScope,
        platform: draft.platform,
        botId: draft.botId,
        dashboardUrl: draft.dashboardUrl,
        userId: draft.userId,
      });
      await api.connect();
    });
    setBusy(false);
  };
  const exportConfig = async () => {
    await api.updateSettings({
      adapterPort: draft.adapterPort,
      adapterScope: draft.adapterScope,
      platform: draft.platform,
      botId: draft.botId,
      userId: draft.userId,
    });
    return api.exportAdapterConfig();
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">A FAMILIAR SOUL, A NEW HOME</div>
          <h1>内核与记忆</h1>
          <p>麦麦的灵魂来自 MaiBot，这里是通向它的桥。</p>
        </div>
        <Status state={state} />
      </div>
      <div className="core-banner">
        <span className="core-banner-icon">
          <Brain size={31} strokeWidth={1.4} />
        </span>
        <div>
          <h3>同一个麦麦，陪你走进桌面。</h3>
          <p>
            消息经独立适配器插件进入
            MaiBot，人格、表达、长期记忆、插件与工具都交给内核。
          </p>
        </div>
        <span className="protocol-badge">MESSAGE GATEWAY · V1</span>
      </div>
      <div className="settings-columns core-columns">
        <div className="settings-stack">
          <Panel
            title="连接你的 MaiBot"
            subtitle={state.connection.detail}
            action={<Plug size={19} className="muted" />}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void connect();
              }}
            >
              <Field label="连接方式">
                <select
                  value={draft.connectionMode}
                  onChange={(event) =>
                    change(
                      "connectionMode",
                      event.target.value as "local" | "server",
                    )
                  }
                >
                  <option value="local">本机 MaiBot</option>
                  <option value="server">多人服务器</option>
                </select>
              </Field>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  void perform(async () => {
                    if (await api.importServerConnection()) setToken("");
                  });
                }}
              >
                <Download size={15} />
                导入服务器凭证
              </button>
              {server ? (
                <Field
                  label="服务器地址"
                  hint="由管理员提供，例如 wss://mai.example.com/desktop。"
                >
                  <input
                    type="url"
                    required
                    value={draft.serverUrl}
                    placeholder="wss://mai.example.com/desktop"
                    onChange={(event) =>
                      change("serverUrl", event.target.value)
                    }
                  />
                </Field>
              ) : (
                <>
                  <Field
                    label="本机接入端口"
                    hint="桌宠在本机等待适配器连接，端口需与导出的插件配置一致。"
                  >
                    <input
                      type="number"
                      required
                      min={1024}
                      max={65535}
                      value={draft.adapterPort}
                      onChange={(event) =>
                        change("adapterPort", Number(event.target.value))
                      }
                    />
                  </Field>
                  <div className="form-grid">
                    <Field label="平台标识">
                      <input
                        required
                        value={draft.platform}
                        onChange={(event) =>
                          change("platform", event.target.value)
                        }
                      />
                    </Field>
                    <Field label="桌宠机器人 ID">
                      <input
                        required
                        value={draft.botId}
                        onChange={(event) =>
                          change("botId", event.target.value)
                        }
                      />
                    </Field>
                  </div>
                  <Field
                    label="路由作用域（可留空）"
                    hint="已有安装建议留空以延续原会话；多套桌宠可使用不同作用域隔离。"
                  >
                    <input
                      value={draft.adapterScope}
                      onChange={(event) =>
                        change("adapterScope", event.target.value)
                      }
                    />
                  </Field>
                  <Field
                    label="你的会话身份"
                    hint="固定身份可延续同一个桌宠私聊。修改后会开启另一个内核会话。"
                  >
                    <input
                      required
                      value={draft.userId}
                      onChange={(event) => change("userId", event.target.value)}
                    />
                  </Field>
                </>
              )}
              <Field
                label={server ? "个人接入令牌" : "独立连接令牌"}
                hint={
                  state.credentials[credentialKey]
                    ? "令牌已通过系统加密保存。留空会继续使用。"
                    : server
                      ? "导入管理员发给你的凭证文件，或填写管理员提供的令牌。"
                      : "开启接入或导出配置时会自动生成。也可输入至少 32 位的独立令牌。"
                }
              >
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  placeholder={
                    state.credentials[credentialKey]
                      ? "已加密保存 · 输入可替换"
                      : server
                        ? "填写管理员提供的个人令牌"
                        : "留空自动生成"
                  }
                  onChange={(event) => setToken(event.target.value)}
                />
              </Field>
              {!server && (
                <Field label="MaiBot 管理界面">
                  <input
                    type="url"
                    required
                    value={draft.dashboardUrl}
                    onChange={(event) =>
                      change("dashboardUrl", event.target.value)
                    }
                  />
                </Field>
              )}
              <div className="form-actions">
                {connected ||
                state.connection.phase === "reconnecting" ||
                state.connection.phase === "connecting" ? (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      void perform(() => api.disconnect());
                    }}
                  >
                    <Square size={14} />
                    断开
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={busy}
                  className="button primary"
                >
                  {busy ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : connected ? (
                    <RefreshCw size={15} />
                  ) : (
                    <Plug size={16} />
                  )}
                  {server
                    ? connected
                      ? "重新连接服务器"
                      : "连接服务器"
                    : `保存并${connected ? "重新连接" : "开启接入"}`}
                </button>
              </div>
              {!server && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    void perform(exportConfig);
                  }}
                >
                  <Download size={15} />
                  导出插件配置
                </button>
              )}
              {state.connection.sessionId && (
                <p className="helper-text">
                  当前会话：{state.connection.sessionId}
                </p>
              )}
              {server && state.connection.userId && (
                <p className="helper-text">
                  当前账号：{state.connection.userId} · 身份由服务器分配
                </p>
              )}
              {state.credentials[credentialKey] && (
                <button
                  type="button"
                  className="text-button small muted"
                  onClick={() => {
                    void perform(
                      () => api.setCredential(credentialKey, ""),
                      server
                        ? "接入令牌已清除，请重新导入服务器凭证"
                        : "插件令牌已清除，重新导出配置即可生成新令牌",
                    );
                  }}
                >
                  清除令牌并断开
                </button>
              )}
            </form>
          </Panel>
          {!server && (
            <Panel
              title="本地内核进程"
              subtitle={state.core.detail}
              action={<Cpu size={19} className="muted" />}
            >
              <div className="core-folder">
                <FolderOpen size={19} />
                <span title={state.settings.corePath}>
                  {state.settings.corePath || "选择本地 MaiBot 目录"}
                </span>
                <button
                  className="text-button"
                  onClick={() => {
                    void perform(() => api.selectCorePath());
                  }}
                >
                  选择
                </button>
              </div>
              <div className="form-actions">
                <span className="helper-text">
                  桌宠退出时，会清理由它启动的内核进程。
                </span>
                {state.core.running ? (
                  <button
                    className="button secondary"
                    onClick={() => {
                      void perform(() => api.stopCore());
                    }}
                  >
                    <Square size={14} />
                    停止内核
                  </button>
                ) : (
                  <button
                    className="button secondary"
                    onClick={() => {
                      void perform(() => api.startCore());
                    }}
                  >
                    <Play size={14} />
                    启动本地内核
                  </button>
                )}
              </div>
            </Panel>
          )}
        </div>
        <div className="settings-stack">
          {server ? (
            <Panel
              title="连接服务器"
              subtitle="每人使用独立凭证，聊天会话由服务器分配。"
            >
              <ol>
                <li>
                  <p>向管理员领取你的桌宠服务器凭证文件。</p>
                </li>
                <li>
                  <p>点击「导入服务器凭证」，再点击「连接服务器」。</p>
                </li>
                <li>
                  <p>显示“会话已确认”后，即可在聊天页交流。</p>
                </li>
              </ol>
              <p className="helper-text">
                凭证代表你的账号，请妥善保管。同一账号在另一台桌宠连接时，本机会断开。服务器暂时离线时会自动重连。
              </p>
              <p className="helper-text">
                人格、模型和插件由服务器管理员配置；角色、声音及屏幕分享由你在本机设置。
              </p>
            </Panel>
          ) : (
            <>
              <Panel
                title="在熟悉的地方，管理麦麦"
                subtitle="打开 MaiBot 自带管理界面，登录后即可继续。"
              >
                <div className="core-links">
                  {[
                    {
                      section: "personality" as const,
                      title: "人格与表达",
                      hint: "性格、说话方式与聊天习惯",
                      icon: Heart,
                    },
                    {
                      section: "memory" as const,
                      title: "长期记忆",
                      hint: "查看知识、记忆与关系",
                      icon: Brain,
                    },
                    {
                      section: "models" as const,
                      title: "模型与服务商",
                      hint: "配置对话、视觉、嵌入等模型",
                      icon: KeyRound,
                    },
                    {
                      section: "plugins" as const,
                      title: "插件与工具",
                      hint: "扩展工具执行与外部服务",
                      icon: Blocks,
                    },
                  ].map((item) => (
                    <button
                      key={item.section}
                      onClick={() => {
                        void perform(() => api.openDashboard(item.section));
                      }}
                    >
                      <span>
                        <item.icon size={20} strokeWidth={1.5} />
                      </span>
                      <div>
                        <strong>{item.title}</strong>
                        <small>{item.hint}</small>
                      </div>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                </div>
              </Panel>
              <Panel title="第一次接入？" className="setup-guide">
                <ol>
                  <li>
                    <span>1</span>
                    <div>
                      <strong>初始化 MaiBot</strong>
                      <p>
                        进入 MaiBot 目录，运行 <code>uv sync</code>，再运行{" "}
                        <code>uv run bot.py</code>，在终端阅读并确认内核协议。
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>2</span>
                    <div>
                      <strong>安装桌宠适配器</strong>
                      <p>
                        在管理界面配置模型 API。将发行包中的{" "}
                        <code>desktop_pet_adapter</code> 放入 MaiBot 的{" "}
                        <code>plugins</code>，导出配置为插件内的{" "}
                        <code>config.toml</code>。在内核目录安装插件的{" "}
                        <code>requirements.txt</code>。
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>3</span>
                    <div>
                      <strong>开启接入，启动内核</strong>
                      <p>
                        左侧保存并开启接入，再启动或重载 MaiBot
                        插件。状态显示“会话已确认”即可聊天。人格、记忆和工具由内核维护。
                      </p>
                    </div>
                  </li>
                </ol>
                <p className="helper-text">
                  兼容 MaiBot 1.3.5–1.3.x / SDK
                  2.10–2.x。插件会自动注册账号路由；配置文件含独立令牌。远程内核请使用
                  SSH 隧道转发到本机接入端口。
                </p>
                <button
                  className="text-button"
                  onClick={() => {
                    void perform(() => api.openDashboard());
                  }}
                >
                  打开 MaiBot 管理界面
                  <ExternalLink size={14} />
                </button>
              </Panel>
            </>
          )}
        </div>
      </div>
      <Panel
        title="接入动态"
        className="diagnostics"
        action={
          <span className="helper-text">最近 12 条 · 不保存认证信息</span>
        }
      >
        {state.activity.length ? (
          state.activity.slice(0, 12).map((item) => (
            <div key={item.id} className={`diagnostic-line ${item.level}`}>
              <time>
                {new Date(item.timestamp).toLocaleTimeString("zh-CN")}
              </time>
              <span>{item.text}</span>
            </div>
          ))
        ) : (
          <p className="helper-text">连接信息和内核启动日志会显示在这里。</p>
        )}
      </Panel>
    </>
  );
}
