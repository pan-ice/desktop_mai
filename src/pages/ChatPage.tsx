import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Camera,
  ImagePlus,
  LoaderCircle,
  MessageCircle,
  Mic,
  PawPrint,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { api, perform, showToast } from "../api";
import { Empty, Status } from "../components/ui";
import { ScreenPicker } from "../components/ScreenPicker";
import { CameraShare } from "../components/CameraShare";
import { speak, useRecorder } from "../hooks/useVoice";
import type { Page, SendInput, Snapshot } from "../../shared/types";
import { messageContent } from "../../shared/message-content";
import { replySpeechText } from "../../shared/speech-text";
import { MessageAudio } from "../components/ChatAudio";
import { interactionLabel } from "../../shared/interaction";
import { displayBotName } from "../../shared/bot-name";
import {
  chatMessageKey,
  historyViewChange,
} from "../../shared/chat-history-view";

export function ChatPage({
  state,
  navigate,
}: {
  state: Snapshot;
  navigate: (page: Page) => void;
}) {
  const [text, setText] = useState("");
  const [image, setImage] = useState<string | undefined>();
  const [screens, setScreens] = useState(false);
  const [camera, setCamera] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [unsentVoice, setUnsentVoice] = useState("");
  const [clear, setClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [newMessages, setNewMessages] = useState(0);
  const messageList = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const cancelClear = useRef<HTMLButtonElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const atBottom = useRef(true);
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const previousHistory = useRef<string[]>([]);
  const loadingEarlier = useRef(false);
  const sendingRequest = useRef(false);
  const textRevision = useRef(0);
  const imageRevision = useRef(0);
  const draft = useRef({ text, image });
  draft.current = { text, image };
  const connected = state.connection.phase === "connected";

  const changeText = (value: string) => {
    textRevision.current++;
    draft.current = { ...draft.current, text: value };
    setText(value);
  };
  const changeImage = (value?: string) => {
    imageRevision.current++;
    draft.current = { ...draft.current, image: value };
    setImage(value);
  };
  const rememberScroll = () => {
    const list = messageList.current;
    if (!list) return;
    const top = list.getBoundingClientRect().top;
    const rows = list.querySelectorAll<HTMLElement>("[data-message-key]");
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (rows[middle].getBoundingClientRect().bottom <= top + 1)
        low = middle + 1;
      else high = middle;
    }
    const visible = rows[low];
    anchor.current = visible
      ? {
          key: visible.dataset.messageKey!,
          offset: visible.getBoundingClientRect().top - top,
        }
      : null;
    atBottom.current =
      list.scrollHeight - list.scrollTop - list.clientHeight <= 48;
    setAwayFromLatest(!atBottom.current);
    if (atBottom.current) setNewMessages(0);
  };
  const restoreScroll = () => {
    const list = messageList.current;
    if (!list) return;
    if (!list.querySelector("[data-message-key]")) {
      // 空态不是消息流，不能为贴底行为把引导文字滚出视口。
      list.scrollTop = 0;
      atBottom.current = true;
      anchor.current = null;
      setAwayFromLatest(false);
      setNewMessages(0);
      return;
    }
    if (atBottom.current) list.scrollTop = list.scrollHeight;
    else if (anchor.current) {
      const position = anchor.current;
      const row = Array.from(
        list.querySelectorAll<HTMLElement>("[data-message-key]"),
      ).find((item) => item.dataset.messageKey === position.key);
      if (row)
        list.scrollTop +=
          row.getBoundingClientRect().top -
          list.getBoundingClientRect().top -
          position.offset;
    }
    rememberScroll();
  };
  const jumpToLatest = () => {
    atBottom.current = true;
    restoreScroll();
  };
  useLayoutEffect(() => {
    const keys = state.history.map(chatMessageKey);
    const change = historyViewChange(previousHistory.current, keys);
    previousHistory.current = keys;
    if (change.reset) {
      atBottom.current = true;
      setNewMessages(0);
    } else {
      if (change.prepended && anchor.current) atBottom.current = false;
      if (!atBottom.current && change.appended)
        setNewMessages((count) => count + change.appended);
    }
    restoreScroll();
  }, [
    state.history,
    state.replyStatus,
    state.voiceInput,
    clear,
    sendError,
    unsentVoice,
  ]);
  useEffect(() => {
    const list = messageList.current;
    if (!list) return;
    const observer = new ResizeObserver(restoreScroll);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (clear) cancelClear.current?.focus();
  }, [clear]);
  const loadEarlier = async () => {
    if (loadingEarlier.current || state.historySync.loading) return;
    loadingEarlier.current = true;
    rememberScroll();
    await perform(() => api.loadEarlierHistory());
    loadingEarlier.current = false;
  };
  const submit = async (input: SendInput) => {
    if (sendingRequest.current) return false;
    if (!connected) {
      setSendError("尚未连接 MaiBot，草稿已保留。请先打开连接设置。");
      return false;
    }
    sendingRequest.current = true;
    setSending(true);
    setSendError("");
    jumpToLatest();
    try {
      await api.send(input);
      return true;
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      sendingRequest.current = false;
      setSending(false);
    }
  };
  const recorder = useRecorder(async (transcript) => {
    // 语音自动发送仍然保留；已有的文字草稿不被转写结果覆盖。
    const showTranscript = !draft.current.text.trim();
    if (showTranscript) changeText(transcript);
    const revision = textRevision.current;
    const success = await submit({ text: transcript, source: "voice" });
    if (success && showTranscript && textRevision.current === revision)
      changeText("");
    if (!success && !showTranscript) setUnsentVoice(transcript);
  });
  const send = async () => {
    if (sendingRequest.current || recorder.recording || recorder.processing)
      return;
    const current = draft.current;
    if (!current.text.trim() && !current.image) return;
    const submittedText = textRevision.current;
    const submittedImage = imageRevision.current;
    const success = await submit({
      text: current.text.trim(),
      image: current.image,
      source: current.image ? "screen" : "text",
    });
    if (success) {
      // 请求完成时只清理实际发送的版本，保留期间新写的文字或新选的附件。
      if (textRevision.current === submittedText) changeText("");
      if (imageRevision.current === submittedImage) changeImage();
    }
  };
  const closeClear = () => {
    setClear(false);
    clearButton.current?.focus();
  };
  const clearHistory = async () => {
    if (clearing) return;
    setClearing(true);
    const success = await perform(
      () => api.clearHistory(),
      state.historySync.enabled
        ? "已清空此桌宠的服务器聊天记录，长期记忆保留"
        : "已清空桌宠本地记录，MaiBot 的长期记忆仍可在内核中管理",
    );
    setClearing(false);
    if (success) {
      setClear(false);
      composer.current?.focus();
    }
  };
  return (
    <div className="chat-layout">
      <div className="page-heading">
        <div>
          <div className="eyebrow">A CONVERSATION BETWEEN US</div>
          <h1>和{displayBotName(state)}聊聊</h1>
          <p>不用想好开场白，想到什么就说什么。</p>
        </div>
        <div className="heading-actions">
          <button
            className="icon-button"
            aria-label={exporting ? "正在导出聊天记录" : "导出聊天记录"}
            title="导出聊天记录"
            disabled={exporting || !state.history.length}
            onClick={() => {
              setExporting(true);
              void perform(async () => {
                if (await api.exportHistory()) showToast("聊天记录已导出");
              }).finally(() => setExporting(false));
            }}
          >
            {exporting ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <ArrowDownToLine size={18} />
            )}
          </button>
          <button
            ref={clearButton}
            className={`icon-button ${clear ? "danger" : ""}`}
            aria-label="清空聊天记录"
            aria-expanded={clear}
            aria-controls="chat-clear-confirmation"
            title="清空聊天记录"
            disabled={!state.history.length || clearing}
            onClick={() => setClear(true)}
          >
            <Trash2 size={18} />
          </button>
        </div>
      </div>
      <div className="chat-panel">
        <div className="chat-panel-header">
          <div className="chat-identity">
            <span className="message-avatar">
              <PawPrint size={22} />
            </span>
            <span>
              <strong>{displayBotName(state)}</strong>
              <small>{interactionLabel(state) || "每一句，都认真听。"}</small>
            </span>
          </div>
          <Status state={state} small />
        </div>
        {clear && (
          <div
            className="chat-clear-confirmation"
            id="chat-clear-confirmation"
            role="group"
            aria-label="确认清空聊天记录"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !clearing) closeClear();
            }}
          >
            <div>
              <strong>清空聊天记录？</strong>
              <p>
                {state.historySync.enabled
                  ? "这会删除此桌宠的服务器记录和所有设备缓存。MaiBot 的长期记忆会保留。"
                  : "这会删除本机聊天记录。MaiBot 的长期记忆会保留。"}
              </p>
            </div>
            <div className="heading-actions">
              <button
                ref={cancelClear}
                type="button"
                className="button secondary"
                disabled={clearing}
                onClick={closeClear}
              >
                取消
              </button>
              <button
                type="button"
                className="button danger"
                disabled={clearing}
                onClick={() => void clearHistory()}
              >
                {clearing ? "正在清空…" : "确认清空"}
              </button>
            </div>
          </div>
        )}
        {!connected && (
          <div className="connection-banner">
            <PlugIcon /> <span>{state.connection.detail}</span>
            <button onClick={() => navigate("core")}>连接设置 →</button>
          </div>
        )}
        <div
          className="chat-messages"
          ref={messageList}
          role="log"
          aria-label="聊天记录"
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={state.historySync.loading}
          tabIndex={0}
          onScroll={rememberScroll}
          onLoadCapture={restoreScroll}
        >
          {state.historySync.loading && (
            <p className="helper-text">正在同步服务器聊天记录…</p>
          )}
          {state.historySync.hasMore && (
            <button
              className="text-button"
              disabled={state.historySync.loading}
              onClick={() => void loadEarlier()}
            >
              {state.historySync.loading
                ? "正在加载更早记录…"
                : "加载更早的聊天记录"}
            </button>
          )}
          {state.history.length === 0 ? (
            <div className="chat-empty-state">
              <Empty
                icon={<MessageCircle size={32} strokeWidth={1.2} />}
                title={connected ? "从一句你好开始" : "让熟悉的麦麦来到这里"}
              >
                {connected
                  ? "已经连接好了。聊聊今天的小事，或选一句话作为开场。"
                  : "先连接你的 MaiBot。想说的话也可以先写在下方。"}
              </Empty>
              <div className="chat-starters">
                {connected ? (
                  ["你好，今天过得怎么样？", "陪我聊一会儿吧"].map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="button secondary"
                      onClick={() => {
                        changeText(
                          draft.current.text
                            ? `${draft.current.text}\n${prompt}`
                            : prompt,
                        );
                        composer.current?.focus();
                      }}
                    >
                      {prompt}
                    </button>
                  ))
                ) : (
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => navigate("core")}
                  >
                    打开连接设置
                  </button>
                )}
              </div>
            </div>
          ) : (
            state.history.map((message) => (
              <div
                key={`${message.role}:${message.id}`}
                data-message-key={chatMessageKey(message)}
                className={`message-row ${message.role}`}
              >
                <span className="bubble-avatar">
                  {message.role === "assistant" ? (
                    <PawPrint size={17} />
                  ) : (
                    state.settings.userName.slice(0, 1)
                  )}
                </span>
                <div className="message-content">
                  <div className="message-meta">
                    {message.role === "assistant"
                      ? displayBotName(state)
                      : state.settings.userName}
                    <time
                      title={new Date(message.timestamp).toLocaleString(
                        "zh-CN",
                      )}
                    >
                      {new Date(message.timestamp).toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                    {message.source === "proactive" && <span>主动陪伴</span>}
                    {message.source === "voice" && <Mic size={11} />}
                  </div>
                  <div className="chat-bubble">
                    {messageContent(message).map((part, index) =>
                      part.type === "text" ? (
                        <div className="message-text" key={index}>
                          {part.text}
                        </div>
                      ) : part.type === "image" ? (
                        <img
                          className="message-image"
                          key={index}
                          src={part.dataUrl}
                          alt={part.name || "麦麦分享的图片"}
                        />
                      ) : (
                        <MessageAudio
                          key={index}
                          id={`${message.role}:${message.id}:${index}`}
                          url={part.dataUrl}
                          title={`${message.role === "assistant" ? displayBotName(state) : state.settings.userName}的音频`}
                        />
                      ),
                    )}
                    {message.delivery === "failed" && (
                      <small className="failed-message">发送失败，请重试</small>
                    )}
                    {message.delivery === "unknown" && (
                      <span className="delivery-failed">
                        接收未确认 · 请先检查记录
                      </span>
                    )}
                  </div>
                  {message.role === "assistant" &&
                    replySpeechText(message).trim() && (
                      <button
                        className="message-speak"
                        aria-label="朗读这条消息"
                        onClick={() => {
                          void speak(replySpeechText(message), state.settings);
                        }}
                      >
                        <Volume2 size={13} />
                        朗读
                      </button>
                    )}
                </div>
              </div>
            ))
          )}
          {(state.replyStatus !== "idle" ||
            state.voiceInput === "transcribing") && (
            <div className="typing-indicator" role="status">
              <span />
              <span />
              <span />
              <small>{interactionLabel(state)}</small>
            </div>
          )}
        </div>
        {awayFromLatest && (
          <div className="chat-jump-to-latest">
            <button
              type="button"
              className="button secondary"
              aria-label="回到最新消息"
              onClick={jumpToLatest}
            >
              <ArrowDown size={15} />
              <span aria-live="polite">
                {newMessages ? `${newMessages} 条新消息` : "回到最新消息"}
              </span>
            </button>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {image && (
            <div className="attachment-preview">
              <img src={image} alt="待发送截图" />
              <span>仅在点击发送后交给 MaiBot</span>
              <button
                type="button"
                aria-label="移除截图"
                onClick={() => changeImage()}
              >
                <X size={15} />
              </button>
            </div>
          )}
          <textarea
            ref={composer}
            aria-label="消息内容"
            aria-describedby={`composer-hint${sendError ? " composer-error" : ""}`}
            placeholder={
              connected
                ? `和${displayBotName(state)}说点什么…`
                : "可以先写下想说的话，连接后再发送…"
            }
            value={text}
            onChange={(event) => changeText(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            maxLength={12000}
          />
          {sendError && (
            <div className="composer-error" id="composer-error" role="alert">
              <span>{sendError}</span>
              <small>草稿已保留，请检查聊天记录后再尝试发送。</small>
            </div>
          )}
          {unsentVoice && (
            <div className="composer-voice-draft">
              <p>尚未发送的转写：{unsentVoice}</p>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  changeText(
                    draft.current.text
                      ? `${draft.current.text}\n${unsentVoice}`
                      : unsentVoice,
                  );
                  setUnsentVoice("");
                  composer.current?.focus();
                }}
              >
                补到文字草稿
              </button>
            </div>
          )}
          <div className="composer-bottom">
            <div>
              <button
                type="button"
                className="icon-button"
                title="选择屏幕截图"
                aria-label="选择屏幕截图"
                onClick={() => setScreens(true)}
              >
                <ImagePlus size={19} />
              </button>
              <button
                type="button"
                className={`icon-button ${recorder.recording ? "recording" : ""}`}
                title={
                  recorder.recording
                    ? "结束录音并发送"
                    : "语音输入（需配置语音服务）"
                }
                aria-label={recorder.recording ? "结束录音并发送" : "语音输入"}
                disabled={
                  !recorder.recording &&
                  (!connected ||
                    sending ||
                    recorder.processing ||
                    state.conversationActive)
                }
                onClick={() => {
                  void recorder.toggle();
                }}
              >
                {recorder.processing ? (
                  <LoaderCircle size={18} className="spin" />
                ) : recorder.recording ? (
                  <Square size={17} />
                ) : (
                  <Mic size={19} />
                )}
              </button>
              <span className="composer-hint" id="composer-hint" role="status">
                {recorder.recording
                  ? "正在听…点击结束，最长 45 秒"
                  : recorder.processing
                    ? "正在转写语音…"
                    : sending
                      ? "正在发送；新编辑的草稿会保留"
                      : "Enter 发送 · Shift + Enter 换行"}
              </span>
            </div>
            <button
              className="send-button"
              aria-label="发送消息"
              type="submit"
              disabled={
                !connected ||
                sending ||
                recorder.recording ||
                recorder.processing ||
                (!text.trim() && !image)
              }
            >
              {sending ? (
                <LoaderCircle size={18} className="spin" />
              ) : (
                <ArrowUp size={20} />
              )}
            </button>
          </div>
        </form>
      </div>
      <div className="chat-footnote">
        <span className="tiny-light green" /> 对话由你的 MaiBot 处理 ·
        本地记录最多保留 1,000 条{" "}
        <button className="text-button" onClick={() => navigate("senses")}>
          语音与感知设置
        </button>
      </div>
      {screens && (
        <ScreenPicker
          state={state}
          onClose={() => setScreens(false)}
          onCapture={(capture) => {
            changeImage(capture);
            setScreens(false);
          }}
        />
      )}
      <button
        className="camera-chat-link text-button"
        onClick={() => setCamera(true)}
      >
        <Camera size={13} />
        摄像头分享
      </button>
      {camera && <CameraShare state={state} onClose={() => setCamera(false)} />}
    </div>
  );
}

function PlugIcon() {
  return <span className="tiny-light" />;
}
