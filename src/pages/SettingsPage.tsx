import { useRef, useState } from "react";
import {
  FolderOpen,
  Heart,
  Keyboard,
  LoaderCircle,
  Monitor,
  PawPrint,
  SlidersHorizontal,
} from "lucide-react";
import { api, perform, showToast } from "../api";
import { Field, Panel, SettingToggle } from "../components/ui";
import { useSettingsDraft } from "./SensesPage";
import type { Settings, Snapshot } from "../../shared/types";

export function SettingsPage({ state }: { state: Snapshot }) {
  const { draft, change } = useSettingsDraft(state.settings);
  const [savingNames, setSavingNames] = useState(false);
  const [savingScale, setSavingScale] = useState(false);
  const namesPending = useRef(false);
  const scalePending = useRef(false);
  const queuedScale = useRef<number | undefined>(undefined);
  const scaleInput = useRef(draft.petScale);
  const scaleValue = scalePending.current ? scaleInput.current : draft.petScale;
  const namesDirty =
    draft.nickname !== state.settings.nickname ||
    draft.userName !== state.settings.userName;
  const scaleDirty = scaleValue !== state.settings.petScale;
  const saveNames = async () => {
    if (namesPending.current || !namesDirty) return;
    const nickname = draft.nickname.trim();
    const userName = draft.userName.trim();
    if (!nickname || !userName) {
      showToast("请填写桌宠的名字和你的名字", true);
      return;
    }
    const patch: Partial<Settings> = {};
    if (nickname !== state.settings.nickname) {
      patch.nickname = nickname;
      patch.followBotName = false;
    }
    if (userName !== state.settings.userName) patch.userName = userName;
    if (!Object.keys(patch).length) {
      change("nickname", nickname);
      change("userName", userName);
      return;
    }
    namesPending.current = true;
    setSavingNames(true);
    try {
      const saved = await perform(
        () => api.updateSettings(patch),
        "称呼已保存",
      );
      if (saved) {
        change("nickname", nickname);
        change("userName", userName);
      }
    } finally {
      namesPending.current = false;
      setSavingNames(false);
    }
  };
  const saveScale = async (value: number) => {
    scaleInput.current = value;
    // 先记录最新提交：旧请求尚未完成时，回到原值也需要排队保存。
    queuedScale.current = value;
    if (scalePending.current) return;
    if (value === state.settings.petScale) {
      queuedScale.current = undefined;
      return;
    }
    scalePending.current = true;
    setSavingScale(true);
    try {
      while (queuedScale.current !== undefined) {
        const next: number = queuedScale.current;
        queuedScale.current = undefined;
        let savedScale: number = next;
        const saved: boolean = await perform(async () => {
          const updated = await api.updateSettings({ petScale: next });
          savedScale = updated.settings.petScale;
        });
        // 失败后保留草稿，下一次调整、松开或失焦时可重试，避免自动反复提交。
        if (!saved) break;
        if (queuedScale.current === savedScale) queuedScale.current = undefined;
      }
    } finally {
      queuedScale.current = undefined;
      // 保存回执可能合并旧快照；显示和保留用户在请求期间继续调整的最终值。
      change("petScale", scaleInput.current);
      scalePending.current = false;
      setSavingScale(false);
    }
  };
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
            subtitle="可以跟随当前 MaiBot 的名字，也可以保留自己的称呼。"
            action={<Heart size={18} className="muted" />}
          >
            <SettingToggle
              state={state}
              name="followBotName"
              label="跟随 MaiBot 名称"
              hint={
                state.settings.followBotName
                  ? state.botName
                    ? `当前使用 MaiBot 名称：${state.botName}。手动名字会保留。`
                    : "等待第一条有效回复或服务提供名称，暂时使用下方保存的名字。"
                  : state.botName
                    ? `已获取 MaiBot 名称：${state.botName}。开启后可自动使用。`
                    : "开启后自动使用 MaiBot 提供的名字，未获取时保留手动称呼。"
              }
            />
            {state.settings.followBotName && (
              <p className="helper-text">
                下方保留手动名字；修改并保存后会关闭自动跟随。
              </p>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveNames();
              }}
              aria-busy={savingNames}
            >
              <div className="form-grid">
                <Field label="桌宠的名字">
                  <input
                    required
                    maxLength={40}
                    disabled={savingNames}
                    value={draft.nickname}
                    onChange={(event) => change("nickname", event.target.value)}
                  />
                </Field>
                <Field label="你的名字">
                  <input
                    required
                    maxLength={40}
                    disabled={savingNames}
                    value={draft.userName}
                    onChange={(event) => change("userName", event.target.value)}
                  />
                </Field>
              </div>
              <div className="form-actions">
                <p
                  className={`form-state ${namesDirty ? "dirty" : ""}`}
                  role="status"
                >
                  {savingNames
                    ? "正在保存称呼…"
                    : namesDirty
                      ? "称呼尚未保存，离开本页会放弃修改。"
                      : "称呼已保存"}
                </p>
                <button
                  className="button primary"
                  disabled={
                    savingNames ||
                    !namesDirty ||
                    !draft.nickname.trim() ||
                    !draft.userName.trim()
                  }
                >
                  {savingNames && <LoaderCircle size={15} className="spin" />}
                  {savingNames ? "正在保存…" : "保存称呼"}
                </button>
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
              hint={
                state.recoveryShortcut
                  ? `开启后独立桌宠的角色、气泡和按钮都不挡鼠标；按 ${state.recoveryShortcut} 恢复交互。`
                  : "开启后独立桌宠不挡鼠标；可在本页或托盘菜单关闭穿透。恢复交互快捷键暂不可用。"
              }
            />
            <Field label={`角色大小 · ${Math.round(scaleValue * 100)}%`}>
              <input
                type="range"
                min="0.5"
                max="1.6"
                step="0.05"
                value={scaleValue}
                aria-busy={savingScale}
                onChange={(event) => {
                  scaleInput.current = Number(event.target.value);
                  change("petScale", scaleInput.current);
                }}
                onPointerUp={(event) => {
                  void saveScale(Number(event.currentTarget.value));
                }}
                onKeyUp={(event) => {
                  if (
                    [
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                      "Home",
                      "End",
                      "PageUp",
                      "PageDown",
                    ].includes(event.key)
                  )
                    void saveScale(Number(event.currentTarget.value));
                }}
                onBlur={(event) =>
                  void saveScale(Number(event.currentTarget.value))
                }
              />
            </Field>
            <p
              className={`form-state ${scaleDirty ? "dirty" : ""}`}
              role="status"
            >
              {savingScale
                ? "正在保存角色大小…"
                : scaleDirty
                  ? "大小尚未保存，可重新调整后松开保存。"
                  : "松开滑块或完成键盘调整后自动保存。"}
            </p>
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
              <span>
                {state.recoveryShortcut
                  ? "召回桌宠与控制面板"
                  : "组合键暂不可用，请通过托盘召回"}
              </span>
              {state.recoveryShortcut?.split(" + ").map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
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
