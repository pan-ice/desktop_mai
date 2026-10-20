import { useEffect, useState } from "react";
import { LoaderCircle, Square, Volume2 } from "lucide-react";
import { api, perform, showToast } from "../api";
import { speak, stopSpeech } from "../hooks/useVoice";
import { Field, Panel, SettingToggle, Toggle } from "./ui";
import { speechDeliveryHint } from "../../shared/speech-delivery";
import { VoiceImport } from "./VoiceImport";
import { VoiceServiceGuidance } from "./ModelGuidance";
import {
  TTS_PROVIDERS,
  MIMO_REFERENCE_MAX_BYTES,
  ttsProfile,
  ttsProviders,
  type ClonedVoice,
  type TtsProfile,
  type TtsProvider,
} from "../../shared/tts";
import type { Settings, Snapshot } from "../../shared/types";

export function TtsSettings({ state }: { state: Snapshot }) {
  const saved = JSON.stringify(state.settings);
  const [draft, setDraft] = useState(state.settings);
  useEffect(() => setDraft(JSON.parse(saved) as Settings), [saved]);
  const [keys, setKeys] = useState<Partial<Record<TtsProvider, string>>>({});
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [name, setName] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [referenceText, setReferenceText] = useState("");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [testText, setTestText] = useState(
    `你好，我是${state.settings.nickname}。今天也想陪你一起度过。`,
  );
  const provider = draft.ttsProvider;
  useEffect(() => {
    setFile(null);
    setReferenceText("");
    setReferenceUrl("");
    setVoiceId("");
  }, [provider]);
  const spec = ttsProviders[provider];
  const profile = ttsProfile(draft);
  const nativeOutput =
    draft.ttsEngine === "api" && draft.ttsNativeOutput !== false;
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const changeProfile = (patch: Partial<TtsProfile>) =>
    setDraft((current) => ({
      ...current,
      ttsProfiles: {
        ...current.ttsProfiles,
        [current.ttsProvider]: { ...ttsProfile(current), ...patch },
      },
    }));
  useEffect(() => {
    const update = () => setVoices(speechSynthesis.getVoices());
    update();
    speechSynthesis.addEventListener("voiceschanged", update);
    return () => speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);
  useEffect(() => {
    if (!file) {
      setFileUrl("");
      return;
    }
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const save = async () => {
    if (keys[provider]) {
      await api.setCredential(spec.key, keys[provider]!);
      setKeys((current) => ({ ...current, [provider]: "" }));
    }
    await api.updateSettings({
      ttsEngine: draft.ttsEngine,
      ttsProvider: provider,
      ttsNativeOutput: draft.ttsNativeOutput,
      ttsNaturalSpeech: draft.ttsNaturalSpeech,
      ttsPreloadNext: draft.ttsPreloadNext,
      ttsCloneFidelity: draft.ttsCloneFidelity,
      ttsProfiles: { ...draft.ttsProfiles, [provider]: profile },
      systemVoice: draft.systemVoice,
      speechRate: draft.speechRate,
      speechVolume: draft.speechVolume,
    });
  };
  const useVoice = async (voice: ClonedVoice) => {
    await api.updateSettings({
      ttsEngine: "api",
      ttsProvider: voice.provider,
      ttsProfiles: { ...draft.ttsProfiles, [voice.provider]: voice.profile },
    });
  };
  const clone = async () => {
    setBusy(true);
    try {
      await perform(async () => {
        await save();
        const voice = await api.cloneVoice({
          name,
          voiceId: voiceId || undefined,
          referenceText: referenceText || undefined,
          referenceUrl: referenceUrl || undefined,
          ...(file && spec.reference === "file"
            ? { audio: { name: file.name, data: await file.arrayBuffer() } }
            : {}),
        });
        if (voice.status === "ready") {
          showToast(
            provider === "mimo"
              ? "参考音色已保存到本机，点击「使用音色」后可合成试听"
              : "音色已保存，点击「使用音色」后即可试听和朗读",
          );
        } else
          showToast(
            voice.status === "pending"
              ? "复刻已提交，可在下方查询音色状态"
              : "复刻未通过，请检查参考音频",
          );
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title="让麦麦的声音陪着你"
      subtitle="导入喜欢的声音，让之后的回复用这个声音朗读。"
      action={<Volume2 size={19} className="muted" />}
    >
      <VoiceImport state={state} busy={busy} onBusyChange={setBusy} />
      <SettingToggle
        state={state}
        name="voiceEnabled"
        label="自动朗读回复"
        hint="收到 MaiBot 语音时优先播放原音频；专注时停止。"
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void perform(save, "声音设置已保存");
        }}
      >
        <fieldset disabled={busy} className="tts-fields">
          {draft.ttsEngine === "api" && (
            <Toggle
              label="模型原生输出"
              checked={draft.ttsNativeOutput !== false}
              hint="只传正文、音色和接口所需参数；不添加语气指令、语速、音高、文本归一化或还原模式，音频按原速播放。"
              onChange={(value) => change("ttsNativeOutput", value)}
            />
          )}
          {draft.ttsEngine === "api" && draft.ttsNativeOutput === false && (
            <Toggle
              label="自然聊天语气"
              checked={draft.ttsNaturalSpeech}
              hint={speechDeliveryHint(draft)}
              onChange={(value) => change("ttsNaturalSpeech", value)}
            />
          )}
          <Toggle
            label="长回复连续播放"
            checked={draft.ttsPreloadNext}
            hint="播放当前段时预先合成下一段，减少段间等待。停止前已提交的一段仍可能计费。"
            onChange={(value) => change("ttsPreloadNext", value)}
          />
          {draft.ttsEngine === "api" &&
            draft.ttsNativeOutput === false &&
            draft.ttsProvider === "volcengine" &&
            profile.resourceId === "seed-icl-2.0" && (
              <Toggle
                label="火山复刻还原模式"
                checked={draft.ttsCloneFidelity}
                hint="尽量保留参考音色和说话风格，仅适合参考录音与朗读正文使用同一语种；跨语种请关闭。"
                onChange={(value) => change("ttsCloneFidelity", value)}
              />
            )}
          <details className="tts-advanced">
            <summary>高级声音设置</summary>
            <div className="form-grid">
              <Field label="朗读方式">
                <select
                  value={draft.ttsEngine}
                  onChange={(event) =>
                    change(
                      "ttsEngine",
                      event.target.value as Settings["ttsEngine"],
                    )
                  }
                >
                  <option value="system">系统语音 · 无需 API</option>
                  <option value="api">模型语音 · 在线服务</option>
                </select>
              </Field>
              {draft.ttsEngine === "system" ? (
                <Field label="系统声音">
                  <select
                    value={draft.systemVoice}
                    onChange={(event) =>
                      change("systemVoice", event.target.value)
                    }
                  >
                    <option value="">自动选择中文声音</option>
                    {voices.map((voice) => (
                      <option key={voice.voiceURI} value={voice.voiceURI}>
                        {voice.name} · {voice.lang}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                <Field label="语音服务商">
                  <select
                    value={provider}
                    onChange={(event) =>
                      change("ttsProvider", event.target.value as TtsProvider)
                    }
                  >
                    {TTS_PROVIDERS.map((value) => (
                      <option key={value} value={value}>
                        {ttsProviders[value].name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            {draft.ttsEngine === "system" ? (
              <p className="model-guide-note">
                使用系统提供的声音朗读，桌宠不调用云端合成接口，也不消耗本页语音服务的
                API 额度。音色导入使用在线模型，准备完成后会切换为在线朗读。
              </p>
            ) : (
              <VoiceServiceGuidance provider={provider} />
            )}
            {draft.ttsEngine === "api" && (
              <>
                <Field
                  label="合成服务地址"
                  hint={
                    provider === "bailian"
                      ? "可填写业务空间专属地址，例如 https://你的空间.cn-beijing.maas.aliyuncs.com/api/v1。"
                      : "填写 API 根地址，保留 /v1 或 /api/v3/tts 等路径。"
                  }
                >
                  <input
                    type="url"
                    required
                    value={profile.baseUrl}
                    onChange={(event) =>
                      changeProfile({ baseUrl: event.target.value })
                    }
                  />
                </Field>
                <Field
                  label="合成 API Key"
                  hint={
                    state.credentials[spec.key]
                      ? "此服务商的 Key 已加密保存，留空继续使用。"
                      : "每家服务商单独保存 Key，与录音转写分开。"
                  }
                >
                  <input
                    type="password"
                    autoComplete="off"
                    value={keys[provider] || ""}
                    placeholder={
                      state.credentials[spec.key]
                        ? "已保存 · 输入可替换"
                        : "输入当前服务商 API Key"
                    }
                    onChange={(event) =>
                      setKeys((current) => ({
                        ...current,
                        [provider]: event.target.value,
                      }))
                    }
                  />
                </Field>
                <div className="form-grid">
                  <Field label="语音合成模型">
                    {provider === "mimo" ? (
                      <select
                        value={profile.model}
                        onChange={(event) =>
                          changeProfile({
                            model: event.target.value,
                            voice:
                              event.target.value === "mimo-v2.5-tts"
                                ? "mimo_default"
                                : state.clonedVoices.find(
                                    (voice) => voice.provider === "mimo",
                                  )?.voiceId || "",
                          })
                        }
                      >
                        <option value="mimo-v2.5-tts">
                          MiMo V2.5 · 预置音色
                        </option>
                        <option value="mimo-v2.5-tts-voiceclone">
                          MiMo V2.5 · 音色复刻
                        </option>
                      </select>
                    ) : (
                      <input
                        required
                        value={profile.model}
                        onChange={(event) =>
                          changeProfile({ model: event.target.value })
                        }
                      />
                    )}
                  </Field>
                  <Field label={provider === "mimo" ? "朗读音色" : "音色 ID"}>
                    {provider === "mimo" ? (
                      <select
                        required
                        value={profile.voice}
                        onChange={(event) =>
                          changeProfile({ voice: event.target.value })
                        }
                      >
                        {profile.model === "mimo-v2.5-tts-voiceclone" ? (
                          <>
                            <option value="">请先在下方保存参考音色</option>
                            {state.clonedVoices
                              .filter((voice) => voice.provider === "mimo")
                              .map((voice) => (
                                <option key={voice.id} value={voice.voiceId}>
                                  {voice.name}
                                </option>
                              ))}
                          </>
                        ) : (
                          [
                            "mimo_default",
                            "冰糖",
                            "茉莉",
                            "苏打",
                            "白桦",
                            "Mia",
                            "Chloe",
                            "Milo",
                            "Dean",
                          ].map((voice) => (
                            <option key={voice} value={voice}>
                              {voice === "mimo_default" ? "MiMo 默认" : voice}
                            </option>
                          ))
                        )}
                      </select>
                    ) : (
                      <input
                        value={profile.voice}
                        onChange={(event) =>
                          changeProfile({ voice: event.target.value })
                        }
                        placeholder="系统音色或复刻后的音色 ID"
                      />
                    )}
                  </Field>
                </div>
                {provider === "volcengine" && (
                  <Field
                    label="语音资源 ID"
                    hint="系统音色通常为 seed-tts-2.0；复刻 2.0 音色使用 seed-icl-2.0。"
                  >
                    <input
                      required
                      value={profile.resourceId}
                      onChange={(event) =>
                        changeProfile({ resourceId: event.target.value })
                      }
                    />
                  </Field>
                )}
              </>
            )}
            {draft.ttsEngine === "api" && state.credentials[spec.key] && (
              <button
                type="button"
                className="text-button small muted"
                onClick={() =>
                  void perform(
                    () => api.setCredential(spec.key, ""),
                    "已清除当前服务商 Key",
                  )
                }
              >
                清除合成 Key
              </button>
            )}
          </details>
          <div className="form-grid">
            <Field
              label={
                nativeOutput
                  ? "语速 · 模型原速"
                  : `语速 · ${draft.speechRate.toFixed(1)}×`
              }
            >
              <input
                type="range"
                disabled={nativeOutput}
                min="0.5"
                max="2"
                step="0.1"
                value={nativeOutput ? 1 : draft.speechRate}
                onChange={(event) =>
                  change("speechRate", Number(event.target.value))
                }
              />
            </Field>
            <Field label={`音量 · ${Math.round(draft.speechVolume * 100)}%`}>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={draft.speechVolume}
                onChange={(event) =>
                  change("speechVolume", Number(event.target.value))
                }
              />
            </Field>
          </div>
          <Field label="试听文字">
            <textarea
              value={testText}
              maxLength={500}
              rows={2}
              onChange={(event) => setTestText(event.target.value)}
            />
          </Field>
          <p className="model-guide-note">
            {draft.ttsEngine === "system"
              ? "当前试听使用系统语音，不调用在线合成服务。"
              : "每点一次试听都会请求在线合成；长回复会分段请求。复刻音色的首次试听还可能触发音色或槽位费。"}
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="button secondary"
              disabled={!testText.trim()}
              onClick={() =>
                void perform(async () => {
                  await save();
                  await speak(testText, draft);
                })
              }
            >
              <Volume2 size={15} />
              试听声音
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="停止试听"
              onClick={() => stopSpeech()}
            >
              <Square size={15} />
            </button>
            <button className="button primary" type="submit">
              保存声音设置
            </button>
          </div>
        </fieldset>
      </form>
      {draft.ttsEngine === "api" && spec.reference && (
        <details className="voice-clone-options" key={provider}>
          <summary>更多音色复刻设置</summary>
          <p className="helper-text">{spec.cloneHint}</p>
          {provider === "volcengine" && (
            <p className="helper-text">
              自定义后付费音色首次正式合成会产生槽位费用，并固定音色。请先在控制台确认复刻试听效果。
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void clone();
            }}
          >
            <fieldset disabled={busy} className="tts-fields">
              <Field label="音色名称">
                <input
                  required
                  maxLength={60}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              {spec.reference === "url" ? (
                <Field
                  label="参考音频链接"
                  hint="链接需让百炼服务能直接读取，不会由桌宠上传本地文件。"
                >
                  <input
                    type="url"
                    required
                    value={referenceUrl}
                    onChange={(event) => setReferenceUrl(event.target.value)}
                  />
                </Field>
              ) : (
                <Field label="参考音频">
                  <input
                    type="file"
                    required
                    accept={
                      provider === "siliconflow" || provider === "mimo"
                        ? ".mp3,.wav"
                        : provider === "minimax"
                          ? ".mp3,.wav,.m4a"
                          : ".mp3,.wav,.m4a,.ogg,.aac"
                    }
                    onChange={(event) => {
                      const selected = event.target.files?.[0] || null;
                      if (
                        selected &&
                        selected.size >
                          (provider === "mimo"
                            ? MIMO_REFERENCE_MAX_BYTES
                            : provider === "volcengine"
                              ? 10_000_000
                              : 20_000_000)
                      ) {
                        showToast("参考音频超过服务商大小限制", true);
                        event.target.value = "";
                        setFile(null);
                      } else setFile(selected);
                    }}
                  />
                </Field>
              )}
              {fileUrl && spec.reference === "file" && (
                <audio controls src={fileUrl} />
              )}
              {provider === "siliconflow" && (
                <Field label="参考音频原文">
                  <textarea
                    required
                    value={referenceText}
                    maxLength={4000}
                    rows={3}
                    onChange={(event) => setReferenceText(event.target.value)}
                  />
                </Field>
              )}
              {(provider === "minimax" || provider === "volcengine") && (
                <Field
                  label={
                    provider === "volcengine"
                      ? "复刻音色 ID"
                      : "自定义音色 ID（可选）"
                  }
                  hint={
                    provider === "volcengine"
                      ? "填写 S_ 开头的已购槽位，或 8–256 位英文字母开头的自定义 ID。"
                      : "留空自动生成，ID 不能与已有音色重复。"
                  }
                >
                  <input
                    required={provider === "volcengine"}
                    maxLength={256}
                    value={voiceId}
                    onChange={(event) => setVoiceId(event.target.value)}
                  />
                </Field>
              )}
              <p className="helper-text">
                {provider === "mimo" ? (
                  "参考音频仅保存到本机；使用此音色试听和朗读时，会随每次请求发送给小米 MiMo，按服务商规则计费。"
                ) : (
                  <>
                    点击后会将参考音频及所需文字提交给{spec.name}
                    ，按该服务商规则计费。
                  </>
                )}
              </p>
              <button className="button primary" type="submit">
                {busy && <LoaderCircle size={15} className="spin" />}
                {provider === "mimo"
                  ? busy
                    ? "正在保存…"
                    : "保存参考音色"
                  : busy
                    ? "正在提交复刻…"
                    : "提交音色复刻"}
              </button>
            </fieldset>
          </form>
          {state.clonedVoices.some((voice) => voice.provider === provider) && (
            <div className="cloned-voices">
              <div className="subsection-label">已保存音色</div>
              {state.clonedVoices
                .filter((voice) => voice.provider === provider)
                .map((voice) => (
                  <div key={voice.id} className="cloned-voice">
                    <div>
                      <strong>{voice.name}</strong>
                      <small>
                        {voice.status === "ready"
                          ? provider === "mimo"
                            ? "本机参考音色"
                            : "可使用"
                          : voice.status === "pending"
                            ? "审核 / 训练中"
                            : "复刻未通过"}{" "}
                        · {voice.profile.model}
                      </small>
                    </div>
                    <div className="form-actions">
                      {["bailian", "volcengine"].includes(provider) && (
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              const value = await api.queryVoice(voice.id);
                              showToast(
                                value.status === "ready"
                                  ? "音色已就绪，可以使用"
                                  : value.status === "pending"
                                    ? "音色仍在处理中"
                                    : "音色未通过",
                              );
                            })
                          }
                        >
                          查询状态
                        </button>
                      )}
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy || voice.status !== "ready"}
                        onClick={() =>
                          void perform(
                            () => useVoice(voice),
                            "已切换到此复刻音色",
                          )
                        }
                      >
                        使用音色
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </details>
      )}
    </Panel>
  );
}
