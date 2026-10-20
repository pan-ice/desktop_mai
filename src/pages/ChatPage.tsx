import { useEffect, useRef, useState } from "react";
import {
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
import type { Page, Snapshot } from "../../shared/types";
import { messageContent } from "../../shared/message-content";
import { replySpeechText } from "../../shared/speech-text";
import { MessageAudio } from "../components/ChatAudio";

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
  const [clear, setClear] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const connected = state.connection.phase === "connected";
  const recorder = useRecorder(async (transcript) => {
    setText(transcript);
    await api.send({ text: transcript, source: "voice" });
    setText("");
  });
  useEffect(
    () => bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }),
    [state.history.length, state.mood],
  );
  const send = async () => {
    if (sending || (!text.trim() && !image)) return;
    setSending(true);
    const success = await perform(() =>
      api.send({ text: text.trim(), image, source: image ? "screen" : "text" }),
    );
    if (success) {
      setText("");
      setImage(undefined);
    }
    setSending(false);
  };
  return (
    <div className="chat-layout">
      <div className="page-heading">
        <div>
          <div className="eyebrow">A CONVERSATION BETWEEN US</div>
          <h1>和{state.settings.nickname}聊聊</h1>
          <p>不用想好开场白，想到什么就说什么。</p>
        </div>
        <div className="heading-actions">
          <button
            className="icon-button"
            aria-label="导出聊天记录"
            title="导出聊天记录"
            onClick={() => {
              void perform(async () => {
                if (await api.exportHistory()) showToast("聊天记录已导出");
              });
            }}
          >
            <ArrowDownToLine size={18} />
          </button>
          <button
            className={`icon-button ${clear ? "danger" : ""}`}
            aria-label={clear ? "确认清空聊天记录" : "清空聊天记录"}
            title={
              clear
                ? state.historySync.enabled
                  ? "再次点击会清空此桌宠的服务器记录和所有设备缓存"
                  : "再点一次确认清空"
                : "清空聊天记录"
            }
            onClick={() => {
              if (!clear) {
                setClear(true);
                return;
              }
              void perform(
                () => api.clearHistory(),
                state.historySync.enabled
                  ? "已清空此桌宠的服务器聊天记录，长期记忆保留"
                  : "已清空桌宠本地记录，MaiBot 的长期记忆仍可在内核中管理",
              );
              setClear(false);
            }}
            onBlur={() => setClear(false)}
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
              <strong>{state.settings.nickname}</strong>
              <small>
                {state.mood === "thinking"
                  ? "正在想怎么回复你…"
                  : "每一句，都认真听。"}
              </small>
            </span>
          </div>
          <Status state={state} small />
        </div>
        {!connected && (
          <div className="connection-banner">
            <PlugIcon /> <span>{state.connection.detail}</span>
            <button onClick={() => navigate("core")}>连接设置 →</button>
          </div>
        )}
        <div className="chat-messages" aria-live="polite">
          {state.historySync.loading && (
            <p className="helper-text">正在同步服务器聊天记录…</p>
          )}
          {state.historySync.hasMore && (
            <button
              className="text-button"
              disabled={state.historySync.loading}
              onClick={() => void perform(() => api.loadEarlierHistory())}
            >
              加载更早的聊天记录
            </button>
          )}
          {state.history.length === 0 ? (
            <Empty
              icon={<MessageCircle size={32} strokeWidth={1.2} />}
              title="有些话，想和你说"
            >
              连接你的 MaiBot，聊聊今天的小事。
              <br />
              人格与记忆会跟随内核，一直保留下去。
            </Empty>
          ) : (
            state.history.map((message) => (
              <div
                key={`${message.role}:${message.id}`}
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
                      ? state.settings.nickname
                      : state.settings.userName}
                    <time>
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
                          title={`${message.role === "assistant" ? state.settings.nickname : state.settings.userName}的音频`}
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
          {state.mood === "thinking" && (
            <div className="typing-indicator">
              <span />
              <span />
              <span />
              <small>{state.settings.nickname}正在思考</small>
            </div>
          )}
          <div ref={bottom} />
        </div>
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
                onClick={() => setImage(undefined)}
              >
                <X size={15} />
              </button>
            </div>
          )}
          <textarea
            aria-label="消息内容"
            placeholder={
              connected
                ? `和${state.settings.nickname}说点什么…`
                : "先连接 MaiBot，再开始我们的聊天…"
            }
            value={text}
            onChange={(event) => setText(event.target.value)}
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
                  !connected || recorder.processing || state.conversationActive
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
              <span className="composer-hint">
                {recorder.recording
                  ? "正在听…点击结束，最长 45 秒"
                  : recorder.processing
                    ? "正在转写语音…"
                    : "Enter 发送 · Shift + Enter 换行"}
              </span>
            </div>
            <button
              className="send-button"
              aria-label="发送消息"
              type="submit"
              disabled={!connected || sending || (!text.trim() && !image)}
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
            setImage(capture);
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
