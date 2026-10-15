import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  AudioLines,
  Heart,
  LoaderCircle,
  MessageCircle,
  Mic,
  Moon,
  Settings2,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { api, perform, useSnapshot } from "./api";
import { Avatar } from "./components/Avatar";
import { Toasts } from "./components/ui";
import { stopSpeech, useRecorder, useSpeechReplies } from "./hooks/useVoice";
import { useConversation } from "./hooks/useConversation";

export function Pet() {
  const state = useSnapshot();
  const [chat, setChat] = useState(false);
  const [text, setText] = useState("");
  const [bubble, setBubble] = useState(true);
  const pointer = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const model = state.models.find(
    (item) => item.id === state.settings.activeModelId,
  );
  const reply = state.history.findLast(
    (message) => message.role === "assistant",
  );
  const recorder = useRecorder(async (transcript) => {
    await api.send({ text: transcript, source: "voice" });
  });
  useSpeechReplies(state);
  useConversation(state);
  useEffect(() => {
    if (reply) setBubble(true);
  }, [reply?.id]);
  useEffect(() => {
    const move = (event: MouseEvent) =>
      api.petInteractive(
        Boolean((event.target as Element)?.closest("[data-pet-interactive]")),
      );
    const reset = () => api.petInteractive(false);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseleave", reset);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseleave", reset);
    };
  }, []);
  const submit = async () => {
    if (!text.trim()) return;
    stopSpeech();
    if (await perform(() => api.send({ text: text.trim() }))) setText("");
  };
  return (
    <div
      className={`pet-surface ${state.settings.reducedMotion ? "reduce-motion" : ""}`}
    >
      {bubble && (
        <div className="pet-bubble" data-pet-interactive>
          <button aria-label="关闭气泡" onClick={() => setBubble(false)}>
            <X size={12} />
          </button>
          <p>
            {state.focusUntil
              ? "你安心专注，我在这里。"
              : state.mood === "thinking"
                ? "让我想一想…"
                : reply?.text
                  ? reply.text.slice(0, 150)
                  : `我是${state.settings.nickname}，很高兴在这里遇见你。`}
          </p>
          <span
            className={`pet-bubble-status ${state.connection.phase === "connected" ? "online" : ""}`}
          >
            <i />
            {state.connection.phase === "connected"
              ? state.settings.nickname
              : "等待连接 MaiBot"}
          </span>
        </div>
      )}
      <div className="pet-toolbar" data-pet-interactive>
        <button
          title="陪伴空间"
          aria-label="打开陪伴空间"
          onClick={() => {
            void api.showDashboard("home");
          }}
        >
          <Settings2 size={15} />
        </button>
        <button
          title="安静陪伴"
          aria-label="切换专注陪伴"
          onClick={() => {
            void perform(() => api.focus(state.focusUntil ? 0 : 25));
          }}
        >
          <Moon size={15} />
        </button>
        <button
          title="隐藏桌宠"
          aria-label="隐藏桌宠"
          onClick={() => {
            void perform(() => api.updateSettings({ petVisible: false }));
          }}
        >
          <X size={15} />
        </button>
      </div>
      <div
        className="pet-character"
        data-pet-interactive
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          pointer.current = {
            x: event.clientX,
            y: event.clientY,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          api.petDrag("start");
        }}
        onPointerMove={(event) => {
          const value = pointer.current;
          if (!value) return;
          if (
            Math.abs(event.clientX - value.x) +
              Math.abs(event.clientY - value.y) >
            5
          )
            value.moved = true;
          if (value.moved) api.petDrag("move");
        }}
        onPointerUp={() => {
          const value = pointer.current;
          pointer.current = null;
          api.petDrag("end");
          if (value && !value.moved) {
            void perform(() => api.setMood("happy"));
            setBubble(true);
          }
        }}
        onPointerCancel={() => {
          pointer.current = null;
          api.petDrag("end");
        }}
      >
        <Avatar
          model={model}
          mood={state.mood}
          reducedMotion={state.settings.reducedMotion}
          interactive
        />
      </div>
      <div className="pet-controls" data-pet-interactive>
        <button
          className={chat ? "selected" : ""}
          title="聊聊天"
          aria-label="打开迷你聊天"
          onClick={() => setChat(!chat)}
        >
          <MessageCircle size={17} />
        </button>
        <button
          className={recorder.recording ? "recording" : ""}
          title={recorder.recording ? "结束录音" : "语音对话"}
          aria-label={recorder.recording ? "结束录音" : "语音对话"}
          disabled={
            recorder.processing ||
            state.conversationActive ||
            state.connection.phase !== "connected"
          }
          onClick={() => {
            stopSpeech();
            void recorder.toggle();
          }}
        >
          {recorder.processing ? (
            <LoaderCircle size={17} className="spin" />
          ) : recorder.recording ? (
            <Square size={16} />
          ) : (
            <Mic size={17} />
          )}
        </button>
        <button
          title={state.settings.voiceEnabled ? "关闭朗读" : "开启朗读"}
          aria-label={state.settings.voiceEnabled ? "关闭朗读" : "开启朗读"}
          onClick={() => {
            void perform(() =>
              api.updateSettings({
                voiceEnabled: !state.settings.voiceEnabled,
              }),
            );
          }}
        >
          {state.settings.voiceEnabled ? (
            <Volume2 size={17} />
          ) : (
            <VolumeX size={17} />
          )}
        </button>
        <button
          title="完整聊天"
          aria-label="打开完整聊天"
          onClick={() => {
            void api.showDashboard("chat");
          }}
        >
          <Heart size={17} />
        </button>
      </div>
      {chat && (
        <form
          className="pet-composer"
          data-pet-interactive
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            aria-label="和麦麦说话"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="想和麦麦说点什么？"
            maxLength={12000}
          />
          <button
            aria-label="发送迷你消息"
            disabled={!text.trim() || state.connection.phase !== "connected"}
          >
            <ArrowUp size={17} />
          </button>
        </form>
      )}
      <button
        className={`pet-live ${state.conversationActive ? "listening" : ""}`}
        data-pet-interactive
        title={state.conversationActive ? "结束连续语音" : "开启连续语音"}
        aria-label={state.conversationActive ? "结束连续语音" : "开启连续语音"}
        onClick={() => {
          void perform(() => api.voiceConversation(!state.conversationActive));
        }}
      >
        <AudioLines size={16} />
        {state.conversationActive && <span />}
      </button>
      <Toasts />
    </div>
  );
}
