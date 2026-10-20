import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pause, Play, RotateCcw, RotateCw, X } from "lucide-react";
import { showToast } from "../api";
import type { Snapshot } from "../../shared/types";

type Clip = { id: string; url: string; title: string };
type Position = { playing: boolean; time: number; duration: number };
type Playback = Position & {
  clip: Clip | null;
  toggle: (clip: Clip) => void;
  seek: (time: number) => void;
  stop: () => void;
};
const AudioContext = createContext<Playback | null>(null);
const idle: Position = { playing: false, time: 0, duration: 0 };

/** 播放器由窗口持有；聊天页的控件可以卸载，媒体元素保持连接。 */
export function ChatAudioProvider({
  state,
  children,
}: {
  state: Snapshot;
  children: ReactNode;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const current = useRef<Clip | null>(null);
  const generation = useRef(0);
  const [clip, setClip] = useState<Clip | null>(null);
  const [position, setPosition] = useState(idle);
  const updatePosition = () => {
    const element = audio.current;
    if (element)
      setPosition({
        playing: !element.paused && !element.ended,
        time: Number.isFinite(element.currentTime) ? element.currentTime : 0,
        duration: Number.isFinite(element.duration) ? element.duration : 0,
      });
  };
  const stop = () => {
    ++generation.current;
    current.current = null;
    const element = audio.current;
    if (element) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    setClip(null);
    setPosition(idle);
  };
  useEffect(() => {
    if (audio.current) audio.current.volume = state.settings.speechVolume;
  }, [state.settings.speechVolume]);
  useEffect(() => {
    if (
      current.current &&
      !state.history.some((message) =>
        message.attachments?.some(
          (attachment) => attachment.dataUrl === current.current?.url,
        ),
      )
    )
      stop();
  }, [state.history]);
  useEffect(() => {
    const element = audio.current;
    return () => {
      ++generation.current;
      element?.pause();
    };
  }, []);
  const toggle = (next: Clip) => {
    const element = audio.current;
    if (!element) return;
    const token = ++generation.current;
    if (current.current?.id === next.id && !element.paused) {
      element.pause();
      return;
    }
    if (current.current?.id !== next.id) {
      element.pause();
      current.current = next;
      setClip(next);
      setPosition(idle);
      element.src = next.url;
      element.load();
    } else if (element.error) element.load();
    else if (element.ended) element.currentTime = 0;
    void element.play().catch(() => {
      if (generation.current === token) {
        updatePosition();
        showToast("音频无法播放，请检查文件或音频输出设备后重试", true);
      }
    });
  };
  const seek = (value: number) => {
    const element = audio.current;
    if (
      !element ||
      !Number.isFinite(element.duration) ||
      !Number.isFinite(value)
    )
      return;
    element.currentTime = Math.max(0, Math.min(value, element.duration));
    updatePosition();
  };
  return (
    <AudioContext.Provider value={{ ...position, clip, toggle, seek, stop }}>
      <audio
        ref={audio}
        hidden
        data-chat-player
        preload="metadata"
        onLoadedMetadata={updatePosition}
        onDurationChange={updatePosition}
        onTimeUpdate={updatePosition}
        onPlay={updatePosition}
        onPause={updatePosition}
        onEnded={updatePosition}
        onSeeked={updatePosition}
      />
      {children}
    </AudioContext.Provider>
  );
}

function usePlayback() {
  const playback = useContext(AudioContext);
  if (!playback) throw new Error("聊天音频需要窗口播放器");
  return playback;
}
function timeLabel(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function MessageAudio({ id, url, title }: Clip) {
  const playback = usePlayback();
  const active = playback.clip?.id === id;
  const playing = active && playback.playing;
  const time = active ? playback.time : 0;
  const duration = active ? playback.duration : 0;
  return (
    <div className="message-audio" role="group" aria-label={title}>
      <button
        type="button"
        className="icon-button"
        aria-label={playing ? "暂停这段音频" : "播放这段音频"}
        onClick={() => playback.toggle({ id, url, title })}
      >
        {playing ? <Pause size={17} /> : <Play size={17} />}
      </button>
      <div className="message-audio-progress">
        <input
          type="range"
          aria-label="音频播放进度"
          min={0}
          max={duration || 1}
          step={0.1}
          disabled={!active || !duration}
          value={Math.min(time, duration || 1)}
          onChange={(event) => playback.seek(Number(event.target.value))}
        />
        <span>
          {timeLabel(time)} / {duration ? timeLabel(duration) : "--:--"}
        </span>
      </div>
    </div>
  );
}

export function ChatAudioDock({ visible }: { visible: boolean }) {
  const playback = usePlayback();
  if (!visible || !playback.clip) return null;
  return (
    <div
      className="chat-audio-dock"
      role="region"
      aria-label="正在播放的聊天音频"
    >
      <button
        type="button"
        className="icon-button"
        aria-label={playback.playing ? "暂停当前音频" : "继续播放当前音频"}
        onClick={() => playback.toggle(playback.clip!)}
      >
        {playback.playing ? <Pause size={19} /> : <Play size={19} />}
      </button>
      <div className="chat-audio-dock-track">
        <strong>{playback.clip.title}</strong>
        <input
          type="range"
          aria-label="当前音频播放进度"
          min={0}
          max={playback.duration || 1}
          step={0.1}
          disabled={!playback.duration}
          value={Math.min(playback.time, playback.duration || 1)}
          onChange={(event) => playback.seek(Number(event.target.value))}
        />
        <small>
          {timeLabel(playback.time)} /{" "}
          {playback.duration ? timeLabel(playback.duration) : "--:--"}
        </small>
      </div>
      <button
        type="button"
        className="icon-button"
        aria-label="快退十秒"
        title="快退 10 秒"
        onClick={() => playback.seek(playback.time - 10)}
      >
        <RotateCcw size={17} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="快进十秒"
        title="快进 10 秒"
        onClick={() => playback.seek(playback.time + 10)}
      >
        <RotateCw size={17} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="停止当前音频"
        onClick={playback.stop}
      >
        <X size={17} />
      </button>
    </div>
  );
}
