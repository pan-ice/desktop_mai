import { describe, expect, it, vi } from "vitest";
import { emptySnapshot } from "../shared/defaults";
import { speechSegments } from "../shared/speech-text";
import type { ChatMessage, Settings } from "../shared/types";
import {
  ReplySpeechQueue,
  type SynthesisResult,
} from "../src/audio/reply-speech-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function message(id: string, text = id): ChatMessage {
  return {
    id,
    text,
    role: "assistant",
    source: "core",
    timestamp: Date.now() - 3600000,
  };
}

function fixture() {
  const state = emptySnapshot();
  state.settings.voiceEnabled = true;
  state.settings.ttsEngine = "api";
  state.settings.ttsReplyBufferSize = 2;
  const plays: {
    text: string;
    settings: Settings;
    dataUrl?: string;
    prepared?: Promise<SynthesisResult>;
    done: ReturnType<typeof deferred<void>>;
  }[] = [];
  const requests: {
    text: string;
    done: ReturnType<typeof deferred<string>>;
  }[] = [];
  const stop = vi.fn();
  const onError = vi.fn();
  const queue = new ReplySpeechQueue({
    synthesize: vi.fn((text) => {
      const done = deferred<string>();
      requests.push({ text, done });
      return done.promise;
    }),
    play: vi.fn((text, settings, dataUrl, prepared) => {
      const done = deferred<void>();
      plays.push({ text, settings, dataUrl, prepared, done });
      return done.promise;
    }),
    stop,
    onError,
  });
  const accept = () => queue.accept(structuredClone(state));
  const deliver = (...replies: ChatMessage[]) => {
    state.history.push(...replies);
    state.liveReplies.push(
      ...replies.map((reply) => ({
        id: reply.id,
        receivedAt: Date.now() + 10,
      })),
    );
    accept();
  };
  return { state, queue, plays, requests, stop, onError, accept, deliver };
}

describe("跨消息朗读缓冲", () => {
  it("未完成的预合成提升为当前播放后，释放后台槽继续准备后文", async () => {
    const f = fixture();
    f.deliver(
      message("one"),
      message("two"),
      message("three"),
      message("four"),
    );
    expect(f.requests.map((request) => request.text)).toEqual(["two"]);
    f.plays[0].done.resolve();
    await settle();
    expect(f.plays.map((play) => play.text)).toEqual(["one", "two"]);
    expect(f.requests.map((request) => request.text)).toEqual(["two", "three"]);
    f.requests[0].done.resolve("audio:two");
    await settle();
    await expect(f.plays[1].prepared).resolves.toEqual({ url: "audio:two" });
    expect(f.requests).toHaveLength(2);
    f.requests[1].done.resolve("audio:three");
    await settle();
    expect(f.requests.map((request) => request.text)).toEqual([
      "two",
      "three",
      "four",
    ]);
    f.queue.dispose();
  });

  it("首条立即播放，同时以单后台请求预备后两条，准备完成不抢播", async () => {
    const f = fixture();
    f.deliver(
      message("第一条"),
      message("第二条"),
      message("第三条"),
      message("第四条"),
    );
    expect(f.plays.map((play) => play.text)).toEqual(["第一条"]);
    expect(f.plays[0].prepared).toBeUndefined();
    expect(f.requests.map((request) => request.text)).toEqual(["第二条"]);
    f.requests[0].done.resolve("audio:second");
    await settle();
    expect(f.requests.map((request) => request.text)).toEqual([
      "第二条",
      "第三条",
    ]);
    f.requests[1].done.resolve("audio:third");
    await settle();
    expect(f.requests).toHaveLength(2);
    expect(f.plays).toHaveLength(1);
    f.plays[0].done.resolve();
    await settle();
    expect(f.plays.map((play) => play.text)).toEqual(["第一条", "第二条"]);
    await expect(f.plays[1].prepared).resolves.toEqual({ url: "audio:second" });
    expect(f.requests.map((request) => request.text)).toEqual([
      "第二条",
      "第三条",
      "第四条",
    ]);
    f.queue.dispose();
  });

  it("按即时到达顺序排队，原始音频保持位置且不占文字预备名额", async () => {
    const f = fixture();
    const voice = message("voice", "有原音频时不重复合成这段文字");
    voice.attachments = [
      { type: "audio", dataUrl: "audio:original-1" },
      { type: "audio", dataUrl: "audio:original-2" },
    ];
    f.state.history = [message("last"), voice, message("first")];
    f.state.liveReplies = ["first", "voice", "last"].map((id) => ({
      id,
      receivedAt: Date.now() + 10,
    }));
    f.accept();
    expect(f.plays[0].text).toBe("first");
    expect(f.requests.map((request) => request.text)).toEqual(["last"]);
    f.requests[0].done.resolve("audio:last");
    await settle();
    f.plays[0].done.resolve();
    await settle();
    expect(f.plays[1].dataUrl).toBe("audio:original-1");
    expect(f.plays[1].prepared).toBeUndefined();
    f.plays[1].done.resolve();
    await settle();
    expect(f.plays[2].dataUrl).toBe("audio:original-2");
    f.plays[2].done.resolve();
    await settle();
    expect(f.plays[3].text).toBe("last");
    await expect(f.plays[3].prepared).resolves.toEqual({ url: "audio:last" });
    f.queue.dispose();
  });

  it("只预备长回复的首段并跳过引用，段内预加载选项保持独立", async () => {
    const f = fixture();
    f.state.settings.ttsPreloadNext = false;
    const longText = "需要读出的正文。".repeat(260);
    f.deliver(
      message("first"),
      message("long", "[引用消息] 不应读出\n" + longText),
    );
    expect(f.requests[0].text).toBe(speechSegments(longText, "openai")[0]);
    expect(f.requests[0].text.length).toBeLessThan(longText.length);
    f.requests[0].done.resolve("audio:first-segment");
    await settle();
    expect(f.requests).toHaveLength(1);
    f.plays[0].done.resolve();
    await settle();
    expect(f.plays[1].text).toBe(longText);
    expect(f.plays[1].settings.ttsPreloadNext).toBe(false);
    f.queue.dispose();
  });

  it("设为0时继续串行播放且不发跨消息合成请求", async () => {
    const f = fixture();
    f.state.settings.ttsReplyBufferSize = 0;
    f.deliver(message("one"), message("two"));
    expect(f.requests).toHaveLength(0);
    f.plays[0].done.resolve();
    await settle();
    expect(f.plays.map((play) => play.text)).toEqual(["one", "two"]);
    expect(f.plays[1].prepared).toBeUndefined();
    f.queue.dispose();
  });

  it("降低缓冲至0停止新预备，已提交同声线首段仍可复用", async () => {
    const f = fixture();
    f.deliver(message("one"), message("two"), message("three"));
    f.state.settings.ttsReplyBufferSize = 0;
    f.accept();
    f.requests[0].done.resolve("audio:two");
    await settle();
    expect(f.requests).toHaveLength(1);
    f.plays[0].done.resolve();
    await settle();
    await expect(f.plays[1].prepared).resolves.toEqual({ url: "audio:two" });
    expect(f.requests).toHaveLength(1);
    f.queue.dispose();
  });

  it("无关快照不重复预备，声线变化立即重备且忽略旧请求迟到", async () => {
    const f = fixture();
    f.deliver(message("one"), message("two"));
    f.state.mood = "happy";
    f.state.settings.nickname = "新名字";
    f.state.playback.phase = "playing";
    f.accept();
    expect(f.requests).toHaveLength(1);
    f.state.settings.ttsVoice = "new-voice";
    f.accept();
    expect(f.requests).toHaveLength(2);
    f.requests[0].done.resolve("audio:old-voice");
    await settle();
    expect(f.requests).toHaveLength(2);
    f.requests[1].done.resolve("audio:new-voice");
    await settle();
    f.plays[0].done.resolve();
    await settle();
    await expect(f.plays[1].prepared).resolves.toEqual({
      url: "audio:new-voice",
    });
    expect(f.plays[1].settings.ttsVoice).toBe("new-voice");
    f.queue.dispose();
  });

  it("停止丢弃队列，旧播放和旧合成均不能卡住或干扰新一轮", async () => {
    const f = fixture();
    f.deliver(message("one"), message("two"));
    f.queue.clear();
    expect(f.stop).toHaveBeenCalledOnce();
    f.accept();
    expect(f.plays).toHaveLength(1);
    f.deliver(message("three"), message("four"));
    expect(f.plays.map((play) => play.text)).toEqual(["one", "three"]);
    expect(f.requests.map((request) => request.text)).toEqual(["two", "four"]);
    f.plays[0].done.resolve();
    f.requests[0].done.resolve("audio:discarded");
    await settle();
    expect(f.plays).toHaveLength(2);
    expect(f.requests).toHaveLength(2);
    f.requests[1].done.resolve("audio:four");
    await settle();
    f.plays[1].done.resolve();
    await settle();
    expect(f.plays[2].text).toBe("four");
    await expect(f.plays[2].prepared).resolves.toEqual({ url: "audio:four" });
    f.queue.dispose();
  });

  it("卸载后迟到合成不播放，也不继续提交后续合成", async () => {
    const f = fixture();
    f.deliver(message("one"), message("two"), message("three"));
    f.queue.dispose();
    f.requests[0].done.resolve("audio:discarded");
    f.plays[0].done.resolve();
    f.deliver(message("four"));
    await settle();
    expect(f.plays).toHaveLength(1);
    expect(f.requests).toHaveLength(1);
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it.each(["recording", "transcribing"] as const)(
    "%s时暂停预备和播放，结束后按序恢复",
    async (phase) => {
      const f = fixture();
      f.state.voiceInput = phase;
      f.deliver(message("one"), message("two"));
      expect(f.plays).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
      f.state.voiceInput = "idle";
      f.accept();
      expect(f.plays[0].text).toBe("one");
      expect(f.requests[0].text).toBe("two");
      f.queue.dispose();
    },
  );

  it.each(["disabled", "focus", "system"] as const)(
    "%s时不会向API提交预合成",
    (mode) => {
      const f = fixture();
      if (mode === "disabled") f.state.settings.voiceEnabled = false;
      if (mode === "focus") f.state.focusUntil = Date.now() + 60000;
      if (mode === "system") f.state.settings.ttsEngine = "system";
      f.deliver(message("one"), message("two"));
      expect(f.requests).toHaveLength(0);
      expect(f.plays).toHaveLength(mode === "system" ? 1 : 0);
      f.state.settings.voiceEnabled = true;
      f.state.focusUntil = null;
      f.accept();
      if (mode !== "system") expect(f.plays).toHaveLength(0);
      f.queue.dispose();
    },
  );

  it("只消费即时回复，历史先到不提前去重；实时先到保留缺口顺序", async () => {
    const f = fixture();
    f.state.history = [message("history")];
    f.accept();
    expect(f.plays).toHaveLength(0);
    f.state.liveReplies = [
      { id: "missing-first", receivedAt: Date.now() + 10 },
      { id: "history", receivedAt: Date.now() + 10 },
    ];
    f.accept();
    expect(f.plays).toHaveLength(0);
    expect(f.requests[0].text).toBe("history");
    f.state.history.push(message("missing-first"));
    f.accept();
    expect(f.plays[0].text).toBe("missing-first");
    f.requests[0].done.resolve("audio:history");
    f.plays[0].done.resolve();
    await settle();
    expect(f.plays[1].text).toBe("history");
    f.accept();
    expect(f.plays).toHaveLength(2);
    f.queue.dispose();
  });

  it("窗口加载前的即时元数据不重播，服务器消息时间偏差不影响新投递", () => {
    const f = fixture();
    f.state.history = [message("old")];
    f.state.liveReplies = [{ id: "old", receivedAt: Date.now() - 60000 }];
    f.accept();
    expect(f.plays).toHaveLength(0);
    f.deliver(message("new"));
    expect(f.plays[0].text).toBe("new");
    f.queue.dispose();
  });

  it("使用首次渲染时间，effect建立队列前收到的新回复不会漏播", () => {
    const renderedAt = Date.now() - 100;
    const state = emptySnapshot();
    state.settings.voiceEnabled = true;
    const play = vi.fn(async (_text: string) => {});
    const queue = new ReplySpeechQueue({
      startedAt: renderedAt,
      synthesize: async () => "unused",
      play,
    });
    state.history = [message("before-render"), message("before-effect")];
    state.liveReplies = [
      { id: "before-render", receivedAt: renderedAt - 1 },
      { id: "before-effect", receivedAt: renderedAt + 1 },
    ];
    queue.accept(state);
    expect(play).toHaveBeenCalledOnce();
    expect(play.mock.calls[0][0]).toBe("before-effect");
    queue.dispose();
  });

  it("上限5条只准备其首段，不随着普通快照多提交第6条", async () => {
    const f = fixture();
    f.state.settings.ttsReplyBufferSize = 5;
    f.deliver(
      ...Array.from({ length: 8 }, (_, index) => message(`reply-${index}`)),
    );
    for (let index = 0; index < 5; index++) {
      expect(f.requests).toHaveLength(index + 1);
      f.requests[index].done.resolve(`audio:${index}`);
      await settle();
    }
    f.accept();
    expect(f.requests).toHaveLength(5);
    expect(f.plays).toHaveLength(1);
    f.queue.dispose();
  });

  it("切换会话取消旧积压，重复旧元数据不会再次排入", () => {
    const f = fixture();
    f.deliver(message("one"), message("two"));
    f.state.connection.sessionId = "new-session";
    f.accept();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.plays).toHaveLength(1);
    f.deliver(message("new-session-reply"));
    expect(f.plays[1].text).toBe("new-session-reply");
    f.queue.dispose();
  });

  it("预合成失败被保存为结果，消费失败项后继续后续回复", async () => {
    const state = emptySnapshot();
    state.settings.voiceEnabled = true;
    state.settings.ttsEngine = "api";
    const first = deferred<void>();
    const starts: string[] = [];
    const onError = vi.fn();
    const queue = new ReplySpeechQueue({
      synthesize: async (text) => {
        if (text === "two") throw new Error("prepare failed");
        return "audio:" + text;
      },
      play: async (text, _settings, _dataUrl, prepared) => {
        starts.push(text);
        if (prepared) {
          const result = await prepared;
          if (result.error) throw result.error;
        }
        if (text === "one") await first.promise;
      },
      onError,
    });
    state.history = [message("one"), message("two"), message("three")];
    state.liveReplies = state.history.map(({ id }) => ({
      id,
      receivedAt: Date.now() + 10,
    }));
    queue.accept(state);
    await settle();
    expect(starts).toEqual(["one"]);
    expect(onError).not.toHaveBeenCalled();
    first.resolve();
    await settle();
    expect(starts).toEqual(["one", "two", "three"]);
    expect(onError).toHaveBeenCalledOnce();
    queue.dispose();
  });

  it("长会话清理保留仍在live中的已消费ID，历史补回不重排", () => {
    const f = fixture();
    f.state.voiceInput = "recording";
    const anchor = message("retained-anchor");
    const anchorDelivery = { id: anchor.id, receivedAt: Date.now() + 10 };
    for (let batch = 0; batch < 3; batch++) {
      f.state.history = Array.from({ length: 999 }, (_, index) =>
        message(`${batch}-${index}`),
      );
      if (batch === 0) f.state.history.push(anchor);
      f.state.liveReplies = [
        anchorDelivery,
        ...f.state.history
          .filter(({ id }) => id !== anchor.id)
          .map(({ id }) => ({ id, receivedAt: Date.now() + 10 })),
      ];
      f.accept();
    }
    f.queue.clear();
    f.state.history.push(anchor);
    f.state.voiceInput = "idle";
    f.accept();
    expect(f.plays).toHaveLength(0);
    f.queue.dispose();
  });
});
