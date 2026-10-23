import {
  FolderOpen,
  Heart,
  Keyboard,
  Monitor,
  PawPrint,
  SlidersHorizontal,
} from "lucide-react";
import { api, perform } from "../api";
import { Field, Panel, SettingToggle } from "../components/ui";
import { useSettingsDraft } from "./SensesPage";
import type { Snapshot } from "../../shared/types";

export function SettingsPage({ state }: { state: Snapshot }) {
  const { draft, change } = useSettingsDraft(state.settings);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">JUST THE WAY YOU LIKE IT</div>
          <h1>偏好设置</h1>
          <p>把这个小小的空间，调整成舒服的样子。</p>
        </div>
        <span className="soft-badge">
          <SlidersHorizontal size={14} />
          按你的习惯来
        </span>
      </div>
      <div className="settings-columns">
        <div className="settings-stack">
          <Panel
            title="我们怎么称呼彼此"
            subtitle="桌宠显示名与 MaiBot 的内核人格设置分别保存。"
            action={<Heart size={18} className="muted" />}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform(
                  () =>
                    api.updateSettings({
                      nickname: draft.nickname,
                      userName: draft.userName,
                    }),
                  "称呼已保存",
                );
              }}
            >
              <div className="form-grid">
                <Field label="桌宠的名字">
                  <input
                    required
                    maxLength={40}
                    value={draft.nickname}
                    onChange={(event) => change("nickname", event.target.value)}
                  />
                </Field>
                <Field label="你的名字">
                  <input
                    required
                    maxLength={40}
                    value={draft.userName}
                    onChange={(event) => change("userName", event.target.value)}
                  />
                </Field>
              </div>
              <div className="form-actions">
                <button className="button primary">保存称呼</button>
              </div>
            </form>
          </Panel>
          <Panel
            title="桌面上的陪伴"
            action={<Monitor size={19} className="muted" />}
          >
            <SettingToggle
              state={state}
              name="petVisible"
              label="显示桌宠"
              hint="也可以从托盘菜单随时召回。"
            />
            <SettingToggle
              state={state}
              name="alwaysOnTop"
              label="始终置顶"
              hint="让麦麦待在其他窗口上方。"
            />
            <SettingToggle
              state={state}
              name="petPositionLocked"
              label="锁定桌宠位置"
              hint="固定当前位置；关闭后可拖动角色，点击互动仍然可用。"
            />
            <SettingToggle
              state={state}
              name="clickThrough"
              label="鼠标穿透"
              hint="开启后角色、气泡和按钮都不挡鼠标；Ctrl + Shift + M 恢复交互。"
            />
            <Field label={`角色大小 · ${Math.round(draft.petScale * 100)}%`}>
              <input
                type="range"
                min="0.5"
                max="1.6"
                step="0.05"
                value={draft.petScale}
                onChange={(event) =>
                  change("petScale", Number(event.target.value))
                }
                onPointerUp={() => {
                  void perform(() =>
                    api.updateSettings({ petScale: draft.petScale }),
                  );
                }}
                onKeyUp={() => {
                  void perform(() =>
                    api.updateSettings({ petScale: draft.petScale }),
                  );
                }}
              />
            </Field>
            <SettingToggle
              state={state}
              name="reducedMotion"
              label="减少动态效果"
              hint="减少呼吸、尾巴摆动和界面过渡。"
            />
          </Panel>
        </div>
        <div className="settings-stack">
          <Panel
            title="开始与结束"
            action={<PawPrint size={19} className="muted" />}
          >
            <SettingToggle
              state={state}
              name="autoConnect"
              label="启动时自动连接 MaiBot"
              hint="连接不可用时会逐步重试，最长间隔 30 秒。"
            />
            <SettingToggle
              state={state}
              name="launchAtLogin"
              label="开机启动"
              hint="打包版生效，开发模式不会添加系统启动项。"
            />
            <div className="info-callout">
              <span>关闭主窗口后，麦麦会留在系统托盘。</span>
              <small>需要结束陪伴时，请在托盘菜单中选择「退出 Mai」。</small>
            </div>
            <div className="shortcut-row">
              <Keyboard size={17} />
              <span>召回桌宠与控制面板</span>
              <kbd>Ctrl</kbd>
              <kbd>Shift</kbd>
              <kbd>M</kbd>
            </div>
          </Panel>
          <Panel
            title="留在这台电脑里的小事"
            subtitle={
              state.settings.serverAccountId
                ? "设置和模型保存在本机，聊天记录随账号同步。"
                : "设置、模型与最近的聊天记录保存在本机。"
            }
          >
            <div className="data-storage">
              <FolderOpen size={26} strokeWidth={1.3} />
              <div>
                <strong>应用数据目录</strong>
                <p>API Key 使用 Windows 系统加密保存。</p>
              </div>
              <button
                className="button secondary"
                onClick={() => {
                  void perform(() => api.openDataFolder());
                }}
              >
                打开目录
              </button>
            </div>
            <p className="helper-text">
              MaiBot
              的长期记忆由内核保管。清空桌宠聊天记录不会删除内核中的记忆。
            </p>
          </Panel>
          <div className="about-card">
            <span className="brand-mark">
              <PawPrint size={25} />
            </span>
            <div>
              <h3>Mai · 桌面伙伴</h3>
              <p>v{state.version} · Powered by MaiBot</p>
              <small>参考 N.E.K.O 的桌面陪伴体验，为麦麦搭建一个新家。</small>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
