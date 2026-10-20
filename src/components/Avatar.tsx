import { useEffect, useRef, useState } from "react";
import type { ImportedModel, Mood } from "../../shared/types";
import { mouthOpen, usePlaybackActivity } from "../audio/playback";

interface Props {
  model?: ImportedModel;
  mood: Mood;
  reducedMotion?: boolean;
  interactive?: boolean;
  speech?: boolean;
}

export function Avatar(props: Props) {
  // 加载错误与渲染器都属于当前资源；换角色时一起重建，避免旧错误移除新挂载点。
  return (
    <AvatarContent
      key={
        props.model
          ? `${props.model.id}:${props.model.coreUrl ?? ""}`
          : "placeholder"
      }
      {...props}
    />
  );
}

function AvatarContent({
  model,
  mood,
  reducedMotion,
  interactive = false,
  speech = true,
}: Props) {
  usePlaybackActivity();
  const mouth = speech ? mouthOpen(mood) : 0;
  const [failure, setFailure] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(mood);
  latest.current = mood;
  useEffect(() => {
    setFailure("");
    const element = host.current;
    if (
      !element ||
      !model ||
      model.kind === "image" ||
      model.kind === "pngtuber"
    )
      return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    const load = async () => {
      const module =
        model.kind === "live2d"
          ? await import("../renderers/live2d")
          : await import("../renderers/three");
      if (cancelled) return;
      const result = await module.mount(
        element,
        model,
        () => latest.current,
        Boolean(reducedMotion),
        () => (speech ? mouthOpen(latest.current) : 0),
      );
      if (cancelled) result();
      else dispose = result;
    };
    void load().catch((error) => {
      if (!cancelled)
        setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [model?.id, model?.kind, model?.coreUrl, reducedMotion, speech]);

  if (model) {
    if (failure)
      return (
        <div className="avatar-error">
          <span>模型未能显示</span>
          <small>{failure}</small>
        </div>
      );
    if (model.kind === "image" || model.kind === "pngtuber") {
      const speaking = mouth > 0.1;
      return (
        <div
          className={`imported-avatar mood-${mood} ${reducedMotion ? "still" : ""}`}
          data-mouth-open={mouth.toFixed(3)}
        >
          <img
            draggable={false}
            src={
              speaking && model.talkingUrl ? model.talkingUrl : model.assetUrl
            }
            alt={model.name}
            onError={() => setFailure("图片无法读取，请重新导入")}
          />
        </div>
      );
    }
    return (
      <div
        className="model-canvas"
        ref={host}
        aria-label={model.name}
        data-mouth-open={mouth.toFixed(3)}
      />
    );
  }
  return (
    <div
      className={`placeholder-avatar mood-${mood} ${reducedMotion ? "still" : ""} ${interactive ? "touchable" : ""}`}
      data-mouth-open={mouth.toFixed(3)}
    >
      <svg viewBox="0 0 300 300" role="img" aria-label="等待导入角色的麦麦小猫">
        <defs>
          <linearGradient id="mai-body" x1="0" x2="0.6" y1="0" y2="1">
            <stop stopColor="#fffdf5" />
            <stop offset="1" stopColor="#f1e9dd" />
          </linearGradient>
          <linearGradient id="mai-scarf" x1="0" x2="1" y1="0" y2="1">
            <stop stopColor="#b8ceba" />
            <stop offset="1" stopColor="#8eaf96" />
          </linearGradient>
        </defs>
        <ellipse
          className="cat-shadow"
          cx="152"
          cy="266"
          rx="72"
          ry="10"
          fill="#998874"
          opacity=".13"
        />
        <g className="cat-body">
          <path
            className="cat-tail"
            d="M208 226 Q269 246 258 198 Q253 186 246 192 Q239 197 245 208 Q250 227 218 216"
            fill="#e8ded0"
            stroke="#72675d"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d="M101 180 Q80 216 94 249 Q115 268 150 263 Q186 268 208 250 Q223 217 196 178Z"
            fill="url(#mai-body)"
            stroke="#72675d"
            strokeWidth="3"
          />
          <path
            d="M100 236 Q107 222 117 235 L119 258 M181 258 L184 235 Q192 224 202 237"
            fill="none"
            stroke="#c6b8a5"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <path
            d="M74 113 Q65 70 85 46 Q111 50 132 79 L171 79 Q198 49 220 48 Q237 75 226 117 Q244 153 223 180 Q204 209 151 207 Q99 211 78 183 Q59 157 74 113Z"
            fill="url(#mai-body)"
            stroke="#72675d"
            strokeWidth="3.2"
            strokeLinejoin="round"
          />
          <path
            d="M85 92 Q79 71 89 60 L113 83Z M190 83 L216 61 Q225 78 215 96Z"
            fill="#eac9bb"
          />
          <path
            d="M139 82 L145 99 M153 81 L154 100 M166 82 L162 98"
            stroke="#d8c4a9"
            strokeWidth="7"
            strokeLinecap="round"
          />
          <g className="cat-eyes" fill="#685c50">
            {mood === "sleeping" ? (
              <>
                <path
                  d="M96 136q12 13 24 0 M180 136q12 13 24 0"
                  fill="none"
                  stroke="#685c50"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
              </>
            ) : mood === "happy" ? (
              <>
                <path
                  d="M97 141q11-16 23 0 M181 141q11-16 23 0"
                  fill="none"
                  stroke="#685c50"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
              </>
            ) : (
              <>
                <ellipse cx="109" cy="137" rx="5" ry="8" />
                <ellipse cx="192" cy="137" rx="5" ry="8" />
                <circle cx="110" cy="134" r="1.5" fill="white" />
                <circle cx="193" cy="134" r="1.5" fill="white" />
              </>
            )}
          </g>
          <ellipse
            cx="91"
            cy="155"
            rx="13"
            ry="7"
            fill="#e8b6a9"
            opacity=".55"
          />
          <ellipse
            cx="210"
            cy="155"
            rx="13"
            ry="7"
            fill="#e8b6a9"
            opacity=".55"
          />
          <path d="M146 150 Q151 147 156 150 L151 155Z" fill="#bd9486" />
          {mouth > 0 || mood === "speaking" ? (
            <ellipse
              className="cat-mouth"
              cx="151"
              cy="163"
              rx="6"
              ry={1 + mouth * 8}
              fill="#ad7c75"
            />
          ) : (
            <path
              d="M151 155 L151 162 Q142 171 137 162 M151 162 Q160 171 166 162"
              fill="none"
              stroke="#857267"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          )}
          <path
            d="M81 147 L62 141 M81 158 L59 158 M220 147 L239 141 M221 158 L242 158"
            stroke="#a79a8b"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M102 193 Q147 208 198 193 L199 208 Q149 224 102 208Z"
            fill="url(#mai-scarf)"
          />
          <path
            d="M178 207 L195 207 L199 239 Q189 245 180 238Z"
            fill="#9ab49d"
          />
          <path
            d="M129 207 Q153 222 174 208"
            fill="none"
            stroke="#7d9f85"
            strokeWidth="2"
          />
          <circle
            cx="151"
            cy="215"
            r="10"
            fill="#d5b87b"
            stroke="#b89a60"
            strokeWidth="1.5"
          />
          <path
            d="M149 211 L153 211 M151 211 L151 217 M147 218 L155 218"
            stroke="#927742"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>
        {mood === "thinking" && (
          <g className="thinking-dots" fill="#a1b29d">
            <circle cx="230" cy="79" r="4" />
            <circle cx="245" cy="65" r="5" />
            <circle cx="264" cy="58" r="6" />
          </g>
        )}
        {mood === "sleeping" && (
          <text
            className="sleep-z"
            x="225"
            y="85"
            fill="#a6afa1"
            fontSize="25"
            fontFamily="sans-serif"
          >
            z z
          </text>
        )}
      </svg>
    </div>
  );
}
