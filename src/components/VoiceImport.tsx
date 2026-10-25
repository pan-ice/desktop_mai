import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, LoaderCircle, Upload } from "lucide-react";
import { api, showToast } from "../api";
import { stopSpeech } from "../hooks/useVoice";
import {
  VOICE_IMPORT_PROVIDERS,
  ttsProfile,
  ttsProviders,
  voiceImportAudioRules,
  type VoiceImportProvider,
} from "../../shared/tts";
import type { Settings, Snapshot } from "../../shared/types";
import { Field } from "./ui";
import { VoiceServiceGuidance } from "./ModelGuidance";
import {
  modelGuideLinks,
  voiceServiceGuides,
} from "../../shared/model-guidance";
import {
  analyzeVoiceReference,
  type VoiceReferenceReport,
} from "../../shared/voice-reference";

export function VoiceImport({
  state,
  busy,
  onBusyChange,
  onBeforeApply,
}: {
  state: Snapshot;
  busy: boolean;
  onBusyChange: (value: boolean) => void;
  onBeforeApply?: () => (settings: Settings) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const pendingApplication = useRef<{
    id: string;
    apply: (settings: Settings) => void;
  } | null>(null);
  const applyPending = (snapshot: Snapshot) => {
    const pending = pendingApplication.current;
    if (!pending) return;
    const voice = snapshot.clonedVoices.find((item) => item.id === pending.id);
    if (!voice) return;
    if (
      voice.status === "ready" &&
      snapshot.settings.ttsEngine === "api" &&
      snapshot.settings.ttsProvider === voice.provider &&
      JSON.stringify(ttsProfile(snapshot.settings)) ===
        JSON.stringify(voice.profile)
    ) {
      pendingApplication.current = null;
      pending.apply(snapshot.settings);
    } else if (voice.status === "failed" || voice.autoUse === false) {
      pendingApplication.current = null;
    }
  };
  useEffect(() => applyPending(state), [state.settings, state.clonedVoices]);
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
  const savedVolcProfile = ttsProfile(state.settings, "volcengine");
  const savedVolcVoice =
    savedVolcProfile.resourceId === "seed-icl-2.0"
      ? savedVolcProfile.voice
      : "";
  useEffect(() => {
    setQueuedFile(null);
    setError("");
    setReferenceText("");
    setVoiceId(provider === "volcengine" ? savedVolcVoice : "");
    setReferenceReport(null);
    setReferenceCheckNote("");
  }, [provider, savedVolcVoice]);
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
    if (provider === "volcengine") return;
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
        const apply = onBeforeApply?.();
        const voice = await api.importVoice({
          provider,
          audio: { name: file.name, data },
          ...(referenceText.trim()
            ? { referenceText: referenceText.trim() }
            : {}),
        });
        setQueuedFile(null);
        if (voice.status === "failed")
          throw new Error("音色准备未通过，请换一段清晰的说话录音后重试。");
        const current = await api.snapshot();
        if (voice.status === "ready") {
          pendingApplication.current = null;
          apply?.(current.settings);
          stopSpeech();
        } else if (voice.status === "pending" && apply) {
          pendingApplication.current = { id: voice.id, apply };
          applyPending(current);
        }
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
      <form
        className="voice-service-setup"
        onSubmit={(event) => {
          event.preventDefault();
          if (!key.trim()) return;
          if (queuedFile) {
            void importFile(queuedFile);
            return;
          }
          void run("正在保存…", async () => {
            await api.setCredential(spec.key, key.trim());
            if (selected && !connected && provider !== "volcengine")
              await api.updateSettings({ voiceEnabled: true });
            setKey("");
            showToast(
              connected
                ? `${spec.name} API Key 已更新`
                : provider === "volcengine"
                  ? "API Key 已保存，请填写已在火山准备好的音色 ID"
                  : selected
                    ? "音色已启用，可以点击下方试听"
                    : "已保存，接下来导入音色音频即可",
            );
          });
        }}
      >
        <Field
          label={provider === "mimo" ? "MiMo API Key" : `${spec.name} API Key`}
          hint={
            provider === "volcengine"
              ? "填写音色所属项目的豆包语音 API Key（非 AccessKey / Access Token），用于朗读。"
              : "每家服务商单独保存 Key，音色导入与朗读共用，可随时更换。"
          }
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
            placeholder={
              connected
                ? "已保存 · 输入新 Key 可替换"
                : "填写当前服务商 API Key"
            }
            onChange={(event) => setKey(event.target.value)}
          />
        </Field>
        <div className="voice-service-actions">
          <button
            type="submit"
            className="button secondary"
            disabled={busy || !state.desktop || !key.trim()}
          >
            {queuedFile
              ? "保存并导入音色"
              : connected
                ? "更新 Key"
                : selected && provider !== "volcengine"
                  ? "保存并启用音色"
                  : "保存 Key"}
          </button>
          {connected && (
            <span className="voice-import-status" role="status">
              <Check size={14} />
              API Key 已保存
            </span>
          )}
        </div>
      </form>
      {provider === "volcengine" ? (
        <form
          className="voice-existing-setup"
          onSubmit={(event) => {
            event.preventDefault();
            if (!voiceId.trim()) return;
            void run("正在保存音色…", async () => {
              const apply = onBeforeApply?.();
              const current = await api.snapshot();
              stopSpeech();
              const updated = await api.updateSettings({
                ttsEngine: "api",
                ttsProvider: "volcengine",
                ttsProfiles: {
                  ...current.settings.ttsProfiles,
                  volcengine: {
                    ...ttsProfile(current.settings, "volcengine"),
                    voice: voiceId.trim(),
                    resourceId: "seed-icl-2.0",
                  },
                },
                voiceEnabled: false,
              });
              pendingApplication.current = null;
              apply?.(updated.settings);
              showToast("火山音色已保存，可手动试听或开启自动朗读");
            });
          }}
        >
          <p className="helper-text">
            请先在火山官方控制台上传音频并完成复刻，确认效果和费用后，将音色 ID
            填在这里。
          </p>
          <a
            className="button secondary"
            href={modelGuideLinks.volcengineClone}
            target="_blank"
            rel="noreferrer noopener"
          >
            打开火山上传指引 <ArrowUpRight size={15} />
          </a>
          <Field
            label="已有火山音色 ID"
            hint="填写控制台中已准备好的复刻音色 ID，如 S_ 开头的槽位 ID。"
          >
            <input
              aria-label="已有火山音色 ID"
              required
              maxLength={256}
              value={voiceId}
              disabled={busy || !state.desktop}
              onChange={(event) => setVoiceId(event.target.value)}
            />
          </Field>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !state.desktop || !voiceId.trim()}
          >
            保存火山音色
          </button>
          <p className="helper-text">
            保存仅更新配置，自动朗读保持关闭。试听或开启朗读后按火山规则计费。
          </p>
        </form>
      ) : (
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
      )}
      <VoiceServiceGuidance
        provider={provider}
        importing={provider !== "volcengine"}
      />
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
      {provider === "siliconflow" && (
        <details className="voice-import-extras">
          <summary>补充选项（通常无需填写）</summary>
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
                const apply = onBeforeApply?.();
                const current = await api.snapshot();
                const updated = await api.updateSettings({
                  ttsEngine: "api",
                  ttsProvider: voice.provider,
                  ttsProfiles: {
                    ...current.settings.ttsProfiles,
                    [voice.provider]: voice.profile,
                  },
                  voiceEnabled:
                    voice.provider !== "volcengine" &&
                    current.credentials[ttsProviders[voice.provider].key],
                });
                pendingApplication.current = null;
                apply?.(updated.settings);
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
          「{voice.name}」准备未通过，
          {provider === "volcengine"
            ? "请前往火山控制台处理。"
            : "请换一段清晰的录音重新导入。"}
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
    </div>
  );
}
