import { replySpeechText, speechSegments } from "../../shared/speech-text";
import type { ChatMessage, Settings, Snapshot } from "../../shared/types";

export interface SynthesisResult {
  url: string | null;
  error?: unknown;
}

interface Dependencies {
  startedAt?: number;
  synthesize(text: string): Promise<string>;
  play(
    text: string,
    settings: Settings,
    dataUrl?: string,
    preparedFirst?: Promise<SynthesisResult>,
  ): Promise<void>;
  stop?(): void;
  onError?(error: unknown): void;
}

interface Prepared {
  key: string;
  promise: Promise<SynthesisResult>;
}

interface Entry {
  id: string;
  pending: boolean;
  text: string;
  dataUrl?: string;
  prepared?: Prepared;
}

function synthesisKey(settings: Settings): string {
  return JSON.stringify([
    settings.ttsEngine,
    settings.ttsProvider,
    settings.ttsProfiles,
    settings.ttsNativeOutput,
    settings.ttsNaturalSpeech,
    settings.ttsCloneFidelity,
    settings.speechRate,
    settings.speechBaseUrl,
    settings.ttsModel,
    settings.ttsVoice,
  ]);
}

function scopeKey(state: Snapshot): string {
  const settings = state.settings;
  return JSON.stringify([
    settings.connectionMode,
    settings.serverUrl,
    settings.serverAccountId,
    settings.adapterScope,
    settings.platform,
    settings.botId,
    settings.userId,
    state.connection.sessionId,
  ]);
}

/** Owns reply order and bounded lookahead; playback keeps its normal cancellation. */
export class ReplySpeechQueue {
  private readonly started: number;
  private readonly seen = new Set<string>();
  private entries: Entry[] = [];
  private state?: Snapshot;
  private scope?: string;
  private key = "";
  private current?: Entry;
  private background?: Prepared;
  private epoch = 0;
  private disposed = false;

  constructor(private readonly dependencies: Dependencies) {
    this.started = dependencies.startedAt ?? Date.now();
  }

  accept(state: Snapshot): void {
    if (this.disposed) return;
    const scope = scopeKey(state);
    if (this.scope !== undefined && this.scope !== scope) {
      this.clear();
    }
    this.scope = scope;
    this.state = state;
    const key = synthesisKey(state.settings);
    if (this.key !== key) this.background = undefined;
    this.key = key;
    const liveIds = new Set(state.liveReplies.map((reply) => reply.id));
    const history = new Map(
      state.history
        .filter((reply) => reply.role === "assistant")
        .map((reply) => [reply.id, reply]),
    );

    if (!this.enabled()) this.clear();
    // Keep a missing history record in its delivery position. A later message
    // must not overtake it while history and live notification catch up.
    this.entries = this.entries.flatMap((entry) => {
      if (!entry.pending) return [entry];
      const reply = history.get(entry.id);
      if (reply) return this.replyEntries(reply);
      return liveIds.has(entry.id) ? [entry] : [];
    });
    for (const delivery of state.liveReplies) {
      if (this.seen.has(delivery.id)) continue;
      this.seen.add(delivery.id);
      if (delivery.receivedAt < this.started || !this.enabled()) continue;
      const reply = history.get(delivery.id);
      this.entries.push(
        ...(reply
          ? this.replyEntries(reply)
          : [{ id: delivery.id, pending: true, text: "" }]),
      );
    }
    if (this.seen.size > 2000) {
      const retained = new Set([...history.keys(), ...liveIds]);
      for (const id of this.seen) if (!retained.has(id)) this.seen.delete(id);
    }
    this.pump();
    this.prepareAhead();
  }

  clear(): void {
    ++this.epoch;
    this.entries = [];
    this.background = undefined;
    const current = this.current;
    this.current = undefined;
    if (current) this.dependencies.stop?.();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private enabled(): boolean {
    return Boolean(
      this.state &&
      (this.state.settings.voiceEnabled || this.state.conversationActive) &&
      !this.state.focusUntil,
    );
  }

  private ready(): boolean {
    return (
      !this.disposed &&
      this.enabled() &&
      this.state?.voiceInput !== "recording" &&
      this.state?.voiceInput !== "transcribing"
    );
  }

  private replyEntries(reply: ChatMessage): Entry[] {
    const voices = reply.attachments?.filter((item) => item.type === "audio");
    if (voices?.length)
      return voices.map((voice) => ({
        id: reply.id,
        pending: false,
        text: "",
        dataUrl: voice.dataUrl,
      }));
    const text = replySpeechText(reply);
    return text.trim() ? [{ id: reply.id, pending: false, text }] : [];
  }

  private pump(): void {
    if (this.current || !this.ready() || this.entries[0]?.pending) return;
    const entry = this.entries.shift();
    if (!entry || !this.state) return;
    this.current = entry;
    const epoch = this.epoch;
    const settings = structuredClone(this.state.settings);
    const prepared =
      settings.ttsEngine === "api" && entry.prepared?.key === this.key
        ? entry.prepared.promise
        : undefined;
    // Its pending request now belongs to foreground playback. Keep reusing it,
    // while the background slot starts preparing the following reply.
    if (prepared && this.background === entry.prepared)
      this.background = undefined;
    let playing: Promise<void>;
    try {
      playing = this.dependencies.play(
        entry.text,
        settings,
        entry.dataUrl,
        prepared,
      );
    } catch (error) {
      playing = Promise.reject(error);
    }
    void playing
      .catch((error) => {
        if (epoch === this.epoch) this.dependencies.onError?.(error);
      })
      .finally(() => {
        if (this.current !== entry) return;
        this.current = undefined;
        this.pump();
        this.prepareAhead();
      });
  }

  private prepareAhead(): void {
    const settings = this.state?.settings;
    const size =
      this.ready() && settings?.ttsEngine === "api"
        ? Math.max(0, Math.min(5, settings.ttsReplyBufferSize ?? 2))
        : 0;
    const candidates = this.entries
      .filter((entry) => !entry.pending && !entry.dataUrl)
      .slice(0, size);
    for (const entry of this.entries)
      if (entry.prepared?.key !== this.key) entry.prepared = undefined;
    if (this.background || !settings) return;
    const next = candidates.find((entry) => !entry.prepared);
    if (!next) return;
    const segment = speechSegments(next.text, settings.ttsProvider).find(
      (text) => text.trim(),
    );
    if (!segment) return;
    let response: Promise<string>;
    try {
      response = this.dependencies.synthesize(segment);
    } catch (error) {
      response = Promise.reject(error);
    }
    const prepared: Prepared = {
      key: this.key,
      promise: response.then(
        (url) => ({ url }),
        (error: unknown) => ({ url: null, error }),
      ),
    };
    next.prepared = prepared;
    this.background = prepared;
    void prepared.promise.then(() => {
      if (this.background !== prepared) return;
      this.background = undefined;
      this.prepareAhead();
    });
  }
}
