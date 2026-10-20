import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Upload } from "lucide-react";
import { api, showToast } from "../api";
import { stopSpeech } from "../hooks/useVoice";
import {
  VOICE_IMPORT_PROVIDERS,
  ttsProfile,
  ttsProviders,
  voiceImportAudioRules,
  type VoiceImportProvider,
} from "../../shared/tts";
import type { Snapshot } from "../../shared/types";
import { Field } from "./ui";
import { VoiceServiceGuidance } from "./ModelGuidance";
import { voiceServiceGuides } from "../../shared/model-guidance";
import {
  analyzeVoiceReference,
  type VoiceReferenceReport,
} from "../../shared/voice-reference";

export function VoiceImport({
  state,
  busy,
  onBusyChange,
}: {
  state: Snapshot;
  busy: boolean;
  onBusyChange: (value: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const [provider, setProvider] = useState<VoiceImportProvider>(
    state.settings.ttsProvider === "openai"
      ? "mimo"
      : state.settings.ttsProvider,
  );
  useEffect(() => {
    if (state.settings.ttsProvider !== "openai")
      setProvider(state.settings.ttsProvider);
  }, [state.settings.ttsProvider]);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [referenceReport, setReferenceReport] =
    useState<VoiceReferenceReport | null>(null);
  const [referenceCheckNote, setReferenceCheckNote] = useState("");
  const [keys, setKeys] = useState<
    Partial<Record<VoiceImportProvider, string>>
  >({});
  const [queuedFile, setQueuedFile] = useState<File | null>(null);
  const [referenceText, setReferenceText] = useState("");
  const [voiceId, setVoiceId] = useState("");
  useEffect(() => {
    setQueuedFile(null);
    setError("");
    setReferenceText("");
    setVoiceId("");
    setReferenceReport(null);
    setReferenceCheckNote("");
  }, [provider]);
  const spec = ttsProviders[provider];
  const rules = voiceImportAudioRules(provider);
  const key = keys[provider] || "";
  const setKey = (value: string) =>
    setKeys((current) => ({ ...current, [provider]: value }));
  const voices = state.clonedVoices.filter(
    (voice) => voice.provider === provider,
  );
  const selected =
    state.settings.ttsEngine === "api" &&
    state.settings.ttsProvider === provider
      ? voices.find(
          (voice) =>
            voice.status === "ready" &&
            voice.voiceId === ttsProfile(state.settings).voice &&
            voice.profile.model === ttsProfile(state.settings).model &&
            voice.profile.baseUrl === ttsProfile(state.settings).baseUrl,
        )
      : undefined;
  const pending = voices.filter((voice) => voice.status === "pending");
  const failed = voices.filter((voice) => voice.status === "failed");
  const connected = state.credentials[spec.key];
  const run = async (message: string, task: () => Promise<void>) => {
    if (busy || working.current) return;
    working.current = true;
    onBusyChange(true);
    setPhase(message);
    setError("");
    try {
      await task();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      working.current = false;
      onBusyChange(false);
      setPhase("");
    }
  };
  const importFile = async (file: File) => {
    const format = file.name.toLowerCase().split(".").at(-1) || "";
    if (!rules.formats.includes(format)) {
      setError(
        `请选择 ${rules.formats.map((value) => value.toUpperCase()).join(" / ")} 音频。`,
      );
      return;
    }
    if (!file.size || file.size > rules.maxBytes) {
      setError(
        `音频不能为空，大小需小于约 ${(rules.maxBytes / 1_000_000).toFixed(1)} MB。`,
      );
      return;
    }
    if (provider !== "mimo" && !connected && !key.trim()) {
      setQueuedFile(file);
      setError("");
      return;
    }
    setQueuedFile(provider === "mimo" ? null : file);
    await run(
      provider === "siliconflow" ? "正在识别并准备音色…" : "正在导入音色…",
      async () => {
        const data = await file.arrayBuffer();
        setReferenceReport(null);
        setReferenceCheckNote("");
        if (file.size <= 3_000_000) {
          let context: AudioContext | undefined;
          try {
            context = new AudioContext();
            const decoded = await context.decodeAudioData(data.slice(0));
            setReferenceReport(
              analyzeVoiceReference(
                Array.from({ length: decoded.numberOfChannels }, (_, index) =>
                  decoded.getChannelData(index),
                ),
                decoded.sampleRate,
              ),
            );
          } catch {
            setReferenceCheckNote(
              "本机未能完成波形检查，服务商仍会校验录音；请使用清晰的单人说话音频。",
            );
          } finally {
            await context?.close().catch(() => {});
          }
        } else
          setReferenceCheckNote(
            "为避免解码大文件占用过多内存，本次跳过波形检查；建议使用 10–20 秒清晰的单人说话片段。",
          );
        if (key.trim()) {
          await api.setCredential(spec.key, key.trim());
          setKey("");
        }
        const voice = await api.importVoice({
          provider,
          audio: { name: file.name, data },
          ...(referenceText.trim()
            ? { referenceText: referenceText.trim() }
            : {}),
          ...(voiceId.trim() ? { voiceId: voiceId.trim() } : {}),
        });
        setQueuedFile(null);
        if (voice.status === "failed")
          throw new Error("音色准备未通过，请换一段清晰的说话录音后重试。");
        const current = await api.snapshot();
        if (voice.status === "ready") stopSpeech();
        showToast(
          voice.status === "pending"
            ? `「${voice.name}」正在准备，完成后会自动选用`
            : current.credentials[spec.key]
              ? `已使用「${voice.name}」，之后的回复会用这个声音朗读`
              : `「${voice.name}」已导入，首次保存 API Key 后即可朗读`,
        );
      },
    );
  };
  return (
    <div className="voice-import-section">
      <Field label="音色服务" hint={voiceServiceGuides[provider].summary}>
        <select
          aria-label="音色服务"
          value={provider}
          disabled={busy}
          onChange={(event) =>
            setProvider(event.target.value as VoiceImportProvider)
          }
        >
          {VOICE_IMPORT_PROVIDERS.map((value) => (
            <option key={value} value={value}>
              {ttsProviders[value].name}
            </option>
          ))}
        </select>
      </Field>
      <div
        className={`voice-import ${dragging ? "dragging" : ""}`}
        aria-busy={busy}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy && state.desktop) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (busy || !state.desktop) return;
          if (event.dataTransfer.files.length !== 1) {
            setError("一次导入一段音频即可。");
            return;
          }
          void importFile(event.dataTransfer.files[0]);
        }}
      >
        <div className="voice-import-intro">
          <span className="voice-import-icon">
            <Upload size={22} />
          </span>
          <div>
            <strong>用你喜欢的声音陪伴</strong>
            <p>导入一段清晰的说话音频，准备完成后自动选用。</p>
            <p>
              建议 10–20
              秒自然说话，只有一个人，无伴奏、混响或破音；唱歌、耳语和配乐片段会影响相似度与表达。
            </p>
          </div>
        </div>
        <input
          ref={input}
          type="file"
          hidden
          aria-label="选择音色音频"
          accept={rules.formats.map((value) => `.${value}`).join(",")}
          disabled={busy || !state.desktop}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importFile(file);
          }}
        />
        <button
          type="button"
          className="button primary"
          disabled={busy || !state.desktop}
          onClick={() => input.current?.click()}
        >
          {phase ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Upload size={16} />
          )}
          {phase || "导入音色音频"}
        </button>
        <small>
          {state.desktop
            ? `${rules.formats.map((value) => value.toUpperCase()).join(" / ")} · 小于约 ${(rules.maxBytes / 1_000_000).toFixed(1)} MB · 支持拖入`
            : "请在桌面应用中导入音色音频"}
        </small>
      </div>
      <VoiceServiceGuidance provider={provider} importing />
      {(referenceReport || referenceCheckNote) && (
        <div className="voice-reference-advice" role="status">
          <strong>参考录音检查</strong>
          {referenceReport && (
            <p>
              {referenceReport.duration.toFixed(1)} 秒 ·{" "}
              {referenceReport.channels} 声道
            </p>
          )}
          {referenceReport?.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          {referenceCheckNote && <p>{referenceCheckNote}</p>}
          <p>
            检查在本机完成，不产生转写费用；这些指标不能判断背景音乐、说话风格或保证复刻相似度。
          </p>
        </div>
      )}
      {error && (
        <p className="voice-import-error" role="alert">
          {error}
        </p>
      )}
      {queuedFile && !busy && (
        <div className="voice-import-queued">
          <span>待导入：{queuedFile.name}</span>
          {connected && (
            <button
              type="button"
              className="text-button"
              onClick={() => void importFile(queuedFile)}
            >
              重试导入音色
            </button>
          )}
        </div>
      )}
      {(provider === "siliconflow" || provider === "volcengine") && (
        <details className="voice-import-extras">
          <summary>补充选项（通常无需填写）</summary>
          {provider === "siliconflow" ? (
            <Field
              label="参考音频原文（可选）"
              hint="留空会自动识别；识别不准确时可在这里补充。"
            >
              <textarea
                aria-label="参考音频原文（可选）"
                rows={2}
                maxLength={4000}
                value={referenceText}
                disabled={busy}
                onChange={(event) => setReferenceText(event.target.value)}
              />
            </Field>
          ) : (
            <Field
              label="已有音色槽位（可选）"
              hint="填写已购买的 S_ 槽位；留空自动创建自定义音色。"
            >
              <input
                aria-label="已有音色槽位（可选）"
                value={voiceId}
                disabled={busy}
                maxLength={256}
                onChange={(event) => setVoiceId(event.target.value)}
              />
            </Field>
          )}
        </details>
      )}
      {voices.length > 0 && (
        <Field label="已导入的音色">
          <select
            aria-label="已导入的音色"
            value={selected?.id || ""}
            disabled={busy}
            onChange={(event) => {
              const voice = voices.find(
                (item) => item.id === event.target.value,
              );
              if (!voice || voice.status !== "ready") return;
              void run("正在切换音色…", async () => {
                const current = await api.snapshot();
                await api.updateSettings({
                  ttsEngine: "api",
                  ttsProvider: voice.provider,
                  ttsProfiles: {
                    ...current.settings.ttsProfiles,
                    [voice.provider]: voice.profile,
                  },
                  voiceEnabled:
                    current.credentials[ttsProviders[voice.provider].key],
                });
                stopSpeech();
                showToast(`已选用「${voice.name}」`);
              });
            }}
          >
            <option value="" disabled>
              选择一个已准备好的音色
            </option>
            {voices.map((voice) => (
              <option
                key={voice.id}
                value={voice.id}
                disabled={voice.status !== "ready"}
              >
                {voice.name}
                {voice.status === "pending"
                  ? " · 准备中"
                  : voice.status === "failed"
                    ? " · 未通过"
                    : ""}
              </option>
            ))}
          </select>
        </Field>
      )}
      {pending.map((voice) => (
        <div key={voice.id} className="voice-preparation" role="status">
          <LoaderCircle size={14} className="spin" />
          <span>
            「{voice.name}」正在准备{voice.autoUse ? "，完成后自动选用" : ""}。
            {voice.statusMessage}
          </span>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() =>
              void run("正在查询…", async () => {
                await api.queryVoice(voice.id);
              })
            }
          >
            刷新进度
          </button>
        </div>
      ))}
      {failed.map((voice) => (
        <p key={voice.id} className="voice-import-error">
          「{voice.name}」准备未通过，请换一段清晰的录音重新导入。
        </p>
      ))}
      {selected && (
        <p className="voice-import-status" role="status">
          {connected && <Check size={14} />}
          {connected
            ? `当前音色：${selected.name}${state.settings.voiceEnabled ? " · 已用于回复朗读" : " · 自动朗读已关闭"}`
            : "音色已导入，首次连接语音服务后即可朗读。"}
        </p>
      )}
      {!connected && (
        <form
          className="voice-service-setup"
          onSubmit={(event) => {
            event.preventDefault();
            if (queuedFile) {
              void importFile(queuedFile);
              return;
            }
            void run("正在保存…", async () => {
              await api.setCredential(spec.key, key.trim());
              if (selected) await api.updateSettings({ voiceEnabled: true });
              setKey("");
              showToast(
                selected
                  ? "音色已启用，可以点击下方试听"
                  : "已保存，接下来导入音色音频即可",
              );
            });
          }}
        >
          <Field
            label={
              provider === "mimo" ? "MiMo API Key" : `${spec.name} API Key`
            }
            hint="每家服务首次填写一次，之后只需导入音频。"
          >
            <input
              aria-label={
                provider === "mimo" ? "MiMo API Key" : `${spec.name} API Key`
              }
              type="password"
              required
              autoComplete="off"
              value={key}
              disabled={busy || !state.desktop}
              placeholder="首次使用，填写一次即可"
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          <button
            type="submit"
            className="button secondary"
            disabled={busy || !state.desktop || !key.trim()}
          >
            {queuedFile
              ? "保存并导入音色"
              : selected
                ? "保存并启用音色"
                : "保存 Key"}
          </button>
        </form>
      )}
    </div>
  );
}
