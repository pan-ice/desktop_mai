import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Camera,
  Clock3,
  ImagePlus,
  LoaderCircle,
  Mic,
  Monitor,
  Send,
  Square,
  X,
} from "lucide-react";
import { api, perform, showToast } from "../api";
import { Field, Panel, SettingToggle, Toggle } from "../components/ui";
import { ScreenPicker } from "../components/ScreenPicker";
import { CameraShare } from "../components/CameraShare";
import { useRecorder } from "../hooks/useVoice";
import { TtsSettings } from "../components/TtsSettings";
import { ModelGuidance } from "../components/ModelGuidance";
import { modelGuideLinks } from "../../shared/model-guidance";
import { mergeSettingsDraft } from "../../shared/settings-draft";
import type { Settings, Snapshot } from "../../shared/types";
import { displayBotName } from "../../shared/bot-name";

export function useSettingsDraft(settings: Settings) {
  const saved = JSON.stringify(settings);
  const [draft, setDraft] = useState(settings);
  const previous = useRef(settings);
  useEffect(() => {
    const updated = JSON.parse(saved) as Settings;
    const baseline = previous.current;
    previous.current = updated;
    setDraft((current) => mergeSettingsDraft(current, baseline, updated));
  }, [saved]);
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  return { draft, change };
}

export function SensesPage({ state }: { state: Snapshot }) {
  const { draft, change } = useSettingsDraft(state.settings);
  const [key, setKey] = useState("");
  const [transcript, setTranscript] = useState("");
  const [screens, setScreens] = useState(false);
  const [capture, setCapture] = useState("");
  const [camera, setCamera] = useState(false);
  const [screenText, setScreenText] =
    useState("看看我的屏幕，我们一起聊聊吧。");
  const recorder = useRecorder((text) => {
    setTranscript(text);
    showToast("转写完成，测试录音没有发送给 MaiBot");
  });
  const saveSpeech = () =>
    perform(async () => {
      if (key) {
        await api.setCredential("speechKey", key);
        setKey("");
      }
      await api.updateSettings({
        speechBaseUrl: draft.speechBaseUrl,
        sttModel: draft.sttModel,
        vadSensitivity: draft.vadSensitivity,
        vadSilenceMs: draft.vadSilenceMs,
      });
    }, "转写设置已保存");
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">LISTEN, SEE, AND BE WITH YOU</div>
          <h1>声音与感知</h1>
          <p>听见你的声音，也看见你愿意分享的世界。</p>
        </div>
        <span className="soft-badge">
          <AudioLines size={14} />
          多一点默契
        </span>
      </div>
      <ModelGuidance />
      <div className="settings-columns">
        <div className="settings-stack">
          <TtsSettings state={state} />
          <Panel
            title="录音与转写"
            subtitle="把你的声音转为文字后交给 MaiBot，与文字朗读分开配置。"
            action={<Mic size={19} className="muted" />}
          >
            <p className="model-guide-note">
              录音会发往下方服务地址，模型将语音转为文字。云端通常按音频时长或
              Token
              收费；此处配置与回复朗读分别结算。自建本地服务的算力与托管成本由部署方承担。
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveSpeech();
              }}
            >
              <Field
                label="API Base URL"
                hint="填写兼容 OpenAI 的转写服务地址，保留 /v1 等路径。"
              >
                <input
                  type="url"
                  required
                  value={draft.speechBaseUrl}
                  onChange={(event) =>
                    change("speechBaseUrl", event.target.value)
                  }
                />
              </Field>
              <Field
                label="转写 API Key"
                hint={
                  state.credentials.speechKey
                    ? "已加密保存，留空继续使用。"
                    : "录音会发送到此服务进行转写。"
                }
              >
                <input
                  type="password"
                  autoComplete="off"
                  value={key}
                  placeholder={
                    state.credentials.speechKey
                      ? "已保存 · 输入可替换"
                      : "输入转写服务 Key；本地服务可留空"
                  }
                  onChange={(event) => setKey(event.target.value)}
                />
              </Field>
              <Field label="转写模型">
                <input
                  required
                  value={draft.sttModel}
                  onChange={(event) => change("sttModel", event.target.value)}
                />
              </Field>
              <div className="form-actions">
                <button className="button primary" type="submit">
                  保存转写设置
                </button>
              </div>
              {state.credentials.speechKey && (
                <button
                  type="button"
                  className="text-button small muted"
                  onClick={() =>
                    void perform(
                      () => api.setCredential("speechKey", ""),
                      "已清除转写 Key",
                    )
                  }
                >
                  清除转写 Key
                </button>
              )}
            </form>
            <p className="model-guide-note">
              按量估算：音频分钟数 × 每分钟单价（若所选模型按时长计费）。
              <a
                href={modelGuideLinks.transcription}
                target="_blank"
                rel="noreferrer noopener"
              >
                查看默认 Whisper 模型计费
              </a>
              ；使用其他模型或地址时请查对应平台价格。
            </p>
          </Panel>
          <Panel
            title="麦克风试一试"
            subtitle="点击录音，再点一次结束。这里仅测试转写，不会自动发消息。"
            action={<Mic size={19} className="muted" />}
          >
            <div className="mic-test">
              <button
                className={`record-test ${recorder.recording ? "recording" : ""}`}
                disabled={recorder.processing || state.conversationActive}
                onClick={() => {
                  void recorder.toggle();
                }}
              >
                {recorder.processing ? (
                  <LoaderCircle size={22} className="spin" />
                ) : recorder.recording ? (
                  <Square size={20} />
                ) : (
                  <Mic size={23} />
                )}
              </button>
              <div>
                <strong>
                  {recorder.recording
                    ? "正在听你说话…"
                    : recorder.processing
                      ? "正在识别…"
                      : "说一句你好吧"}
                </strong>
                <p>
                  {transcript ||
                    "请先保存转写配置。测试会调用转写服务，可能消耗额度。"}
                </p>
              </div>
            </div>
          </Panel>
        </div>
        <div className="settings-stack">
          <Panel
            title="一起看屏幕"
            subtitle="一次分享，一次确认。由 MaiBot 的视觉模型理解截图。"
            action={<Monitor size={19} className="muted" />}
          >
            <p className="model-guide-note">
              分享截图后，MaiBot
              可能调用视觉与聊天模型；开启自动屏幕陪伴后，变化的画面会按间隔发送并可能持续产生用量。费用以
              MaiBot 所用模型或服务器服务方规则为准。
            </p>
            <SettingToggle
              state={state}
              name="screenEnabled"
              label="屏幕感知"
              hint="关闭后禁止截屏；自动捕获需要再开启下方的独立开关。"
            />
            <SettingToggle
              state={state}
              name="screenObservationEnabled"
              label="自动屏幕陪伴"
              hint="先选择窗口，再开启。按设定间隔把变化的画面交给 MaiBot，专注与免打扰期间暂停。"
            />
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform(
                  () =>
                    api.updateSettings({
                      screenObservationSeconds: draft.screenObservationSeconds,
                      screenObservationPrompt: draft.screenObservationPrompt,
                    }),
                  "屏幕陪伴设置已保存",
                );
              }}
            >
              <Field label={`观察间隔 · ${draft.screenObservationSeconds} 秒`}>
                <input
                  type="range"
                  min="30"
                  max="600"
                  step="30"
                  value={draft.screenObservationSeconds}
                  onChange={(event) =>
                    change(
                      "screenObservationSeconds",
                      Number(event.target.value),
                    )
                  }
                />
              </Field>
              <details className="observation-options">
                <summary>调整屏幕陪伴的提示</summary>
                <textarea
                  aria-label="屏幕陪伴提示"
                  value={draft.screenObservationPrompt}
                  onChange={(event) =>
                    change("screenObservationPrompt", event.target.value)
                  }
                  rows={3}
                />
              </details>
              <div className="form-actions">
                <button className="button secondary">保存屏幕节奏</button>
              </div>
            </form>
            <div className="screen-share-intro">
              <span>
                <ImagePlus size={29} strokeWidth={1.3} />
              </span>
              <h4>分享正在做的事</h4>
              <p>
                一张有趣的图片、一段代码，
                <br />
                或者你想一起看的风景。
              </p>
              <button
                className="button secondary"
                onClick={() => setScreens(true)}
              >
                选择屏幕或窗口
              </button>
            </div>
            {capture && (
              <div className="capture-share">
                <div className="capture-frame">
                  <img src={capture} alt="待分享截图" />
                  <button
                    className="icon-button"
                    aria-label="取消截图"
                    onClick={() => setCapture("")}
                  >
                    <X size={15} />
                  </button>
                </div>
                <textarea
                  aria-label="截图附言"
                  value={screenText}
                  onChange={(event) => setScreenText(event.target.value)}
                  rows={2}
                />
                <button
                  className="button primary"
                  disabled={state.connection.phase !== "connected"}
                  onClick={() => {
                    void perform(async () => {
                      await api.send({
                        text: screenText,
                        image: capture,
                        source: "screen",
                      });
                      setCapture("");
                    }, "截图已发送给 MaiBot");
                  }}
                >
                  <Send size={14} />
                  分享给{displayBotName(state)}
                </button>
                {state.connection.phase !== "connected" && (
                  <small>连接 MaiBot 后即可分享。</small>
                )}
              </div>
            )}
          </Panel>
          <Panel
            title="主动来找你"
            subtitle="借用 MaiBot 的人格和上下文，自然地开启话题。"
            action={<Clock3 size={18} className="muted" />}
          >
            <Toggle
              label="主动陪伴"
              checked={state.settings.proactiveEnabled}
              disabled={state.connection.transport === "legacy"}
              hint={
                state.connection.transport === "legacy"
                  ? "当前独立适配器使用消息协议，暂不支持主动陪伴任务。"
                  : "长时间没有交流时，麦麦会试着找一个话题。"
              }
              onChange={(value) =>
                void perform(() =>
                  api.updateSettings({ proactiveEnabled: value }),
                )
              }
            />
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform(
                  () =>
                    api.updateSettings({
                      proactiveMinutes: draft.proactiveMinutes,
                      proactivePrompt: draft.proactivePrompt,
                      quietStart: draft.quietStart,
                      quietEnd: draft.quietEnd,
                    }),
                  "陪伴节奏已保存",
                );
              }}
            >
              <Field label={`安静多久后搭话 · ${draft.proactiveMinutes} 分钟`}>
                <input
                  type="range"
                  min="5"
                  max="240"
                  step="5"
                  value={draft.proactiveMinutes}
                  onChange={(event) =>
                    change("proactiveMinutes", Number(event.target.value))
                  }
                />
              </Field>
              <div className="form-grid">
                <Field label="免打扰开始">
                  <select
                    value={draft.quietStart}
                    onChange={(event) =>
                      change("quietStart", Number(event.target.value))
                    }
                  >
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>
                        {String(i).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="免打扰结束">
                  <select
                    value={draft.quietEnd}
                    onChange={(event) =>
                      change("quietEnd", Number(event.target.value))
                    }
                  >
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>
                        {String(i).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field
                label="搭话提示"
                hint="提示会作为桌宠会话消息交给 MaiBot，不会修改内核人格。"
              >
                <textarea
                  required
                  value={draft.proactivePrompt}
                  onChange={(event) =>
                    change("proactivePrompt", event.target.value)
                  }
                  rows={3}
                />
              </Field>
              <div className="form-actions">
                <button type="submit" className="button secondary">
                  保存陪伴节奏
                </button>
              </div>
            </form>
          </Panel>
        </div>
      </div>
      {screens && (
        <ScreenPicker
          state={state}
          onClose={() => setScreens(false)}
          onCapture={(image) => {
            setCapture(image);
            setScreens(false);
          }}
        />
      )}
      <div className="settings-columns supplemental-senses">
        <Panel
          title="连续语音聊天"
          subtitle="打开后自然说话，停顿时自动发送。等回复时继续聆听，重新开口可停止当前播报。"
          action={<AudioLines size={19} className="muted" />}
        >
          <p className="model-guide-note">
            连续对话会反复调用录音转写、MaiBot
            回复和在线朗读，三部分可能分别收费。关闭连续语音可停止自动录音；自动朗读的开关独立控制。
          </p>
          <Toggle
            label="连续语音对话"
            hint="由桌宠窗口使用麦克风；断线、隐藏桌宠或进入专注时会停止。"
            checked={state.conversationActive}
            onChange={(active) => {
              void perform(() => api.voiceConversation(active));
            }}
          />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(
                () =>
                  api.updateSettings({
                    vadSensitivity: draft.vadSensitivity,
                    vadSilenceMs: draft.vadSilenceMs,
                  }),
                "语音停顿设置已保存",
              );
            }}
          >
            <Field
              label={`声音检测阈值 · ${draft.vadSensitivity.toFixed(3)}`}
              hint="较低的阈值适合轻声说话；环境嘈杂时可以适当调高。"
            >
              <input
                type="range"
                min="0.005"
                max="0.15"
                step="0.005"
                value={draft.vadSensitivity}
                onChange={(event) =>
                  change("vadSensitivity", Number(event.target.value))
                }
              />
            </Field>
            <Field
              label={`停顿多久后发送 · ${(draft.vadSilenceMs / 1000).toFixed(1)} 秒`}
            >
              <input
                type="range"
                min="500"
                max="3000"
                step="100"
                value={draft.vadSilenceMs}
                onChange={(event) =>
                  change("vadSilenceMs", Number(event.target.value))
                }
              />
            </Field>
            <div className="form-actions">
              <button className="button secondary">保存语音节奏</button>
            </div>
          </form>
        </Panel>
        <Panel
          title="通过镜头，看看眼前"
          subtitle="摄像头照片会经预览后发给 MaiBot，与截图使用相同的视觉能力。"
          action={<Camera size={19} className="muted" />}
        >
          <div className="camera-intro">
            <span>
              <Camera size={30} strokeWidth={1.3} />
            </span>
            <div>
              <h4>给麦麦看看你的世界</h4>
              <p>
                分享手边的物件，或一处让你心动的景色。关闭预览即停止使用摄像头。
              </p>
              <button
                className="button secondary"
                onClick={() => setCamera(true)}
              >
                <Camera size={14} />
                打开摄像头
              </button>
            </div>
          </div>
        </Panel>
      </div>
      {camera && <CameraShare state={state} onClose={() => setCamera(false)} />}
    </>
  );
}
