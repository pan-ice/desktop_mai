import { TtsHttpError } from "./tts-errors";

type Priority = "foreground" | "prefetch";

interface Request<T> {
  lane: string;
  owner: number;
  id: string;
  priority: Priority;
  concurrency?: number;
  minIntervalMs?: number;
  run(signal: AbortSignal): Promise<T>;
}

interface Job {
  lane: Lane;
  owner: number;
  id: string;
  priority: Priority;
  order: number;
  concurrency: number;
  minIntervalMs: number;
  attempts: number;
  cancelled: boolean;
  settled: boolean;
  active: boolean;
  controller?: AbortController;
  run(signal: AbortSignal): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface Lane {
  name: string;
  queue: Job[];
  active: Set<Job>;
  nextStartAt: number;
  lastStartedAt?: number;
  cooldownUntil: number;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 10000;

function cancelled() {
  return new DOMException("语音合成已取消", "AbortError");
}

/** One shared scheduler coordinates all windows using the same speech lane. */
export class TtsScheduler {
  private readonly lanes = new Map<string, Lane>();
  private readonly owners = new Map<number, Map<string, Job>>();
  private readonly now: () => number;
  private readonly random: () => number;
  private sequence = 0;
  private disposed = false;

  constructor(options: { now?: () => number; random?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  schedule<T>(request: Request<T>): Promise<T> {
    if (this.disposed) return Promise.reject(cancelled());
    const concurrency = request.concurrency ?? 1;
    const minIntervalMs = request.minIntervalMs ?? 0;
    if (
      !request.lane ||
      !request.id ||
      !Number.isInteger(request.owner) ||
      request.owner < 0 ||
      !["foreground", "prefetch"].includes(request.priority) ||
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      !Number.isFinite(minIntervalMs) ||
      minIntervalMs < 0
    )
      return Promise.reject(new Error("语音合成调度参数无效"));
    if (this.owners.get(request.owner)?.has(request.id))
      return Promise.reject(new Error("语音合成请求标识重复"));
    this.prune();
    let lane = this.lanes.get(request.lane);
    if (!lane) {
      lane = {
        name: request.lane,
        queue: [],
        active: new Set(),
        nextStartAt: 0,
        cooldownUntil: 0,
      };
      this.lanes.set(request.lane, lane);
    }
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        lane,
        owner: request.owner,
        id: request.id,
        priority: request.priority,
        order: ++this.sequence,
        concurrency,
        minIntervalMs,
        attempts: 0,
        cancelled: false,
        settled: false,
        active: false,
        run: request.run,
        resolve: (value) => resolve(value as T),
        reject,
      };
      let owner = this.owners.get(job.owner);
      if (!owner) {
        owner = new Map();
        this.owners.set(job.owner, owner);
      }
      owner.set(job.id, job);
      lane.queue.push(job);
      this.pump(lane);
    });
  }

  cancel(owner: number, id: string): void {
    const job = this.owners.get(owner)?.get(id);
    if (!job || job.cancelled) return;
    job.cancelled = true;
    job.controller?.abort();
    this.reject(job, cancelled());
    if (!job.active) {
      job.lane.queue = job.lane.queue.filter((entry) => entry !== job);
      this.forget(job);
    }
    this.pump(job.lane);
  }

  cancelOwner(owner: number): void {
    for (const id of [...(this.owners.get(owner)?.keys() ?? [])])
      this.cancel(owner, id);
  }

  dispose(): void {
    this.disposed = true;
    for (const owner of [...this.owners.keys()]) this.cancelOwner(owner);
    for (const lane of this.lanes.values()) this.clearTimer(lane);
    this.lanes.clear();
  }

  private clearTimer(lane: Lane): void {
    if (lane.timer !== undefined) clearTimeout(lane.timer);
    lane.timer = undefined;
  }

  private forget(job: Job): void {
    const owner = this.owners.get(job.owner);
    if (owner?.get(job.id) !== job) return;
    owner.delete(job.id);
    if (!owner.size) this.owners.delete(job.owner);
  }

  private reject(job: Job, error: unknown): void {
    if (job.settled) return;
    job.settled = true;
    job.reject(error);
  }

  private prune(): void {
    const now = this.now();
    for (const lane of this.lanes.values())
      if (
        !lane.active.size &&
        !lane.queue.length &&
        lane.nextStartAt <= now &&
        lane.cooldownUntil <= now
      ) {
        this.clearTimer(lane);
        this.lanes.delete(lane.name);
      }
  }

  private pump(lane: Lane): void {
    this.clearTimer(lane);
    if (this.disposed || !lane.queue.length) return;
    const remaining = lane.cooldownUntil - this.now();
    if (remaining > MAX_WAIT_MS) {
      for (const job of lane.queue.splice(0)) {
        this.reject(job, new TtsHttpError(429, remaining));
        this.forget(job);
      }
      return;
    }
    lane.queue.sort(
      (a, b) =>
        Number(a.priority === "prefetch") - Number(b.priority === "prefetch") ||
        a.order - b.order,
    );
    while (lane.queue.length) {
      const all = [...lane.active, ...lane.queue];
      const concurrency = Math.min(...all.map((job) => job.concurrency));
      if (lane.active.size >= concurrency) return;
      const interval = Math.max(...all.map((job) => job.minIntervalMs));
      const readyAt = Math.max(
        lane.cooldownUntil,
        lane.nextStartAt,
        lane.lastStartedAt === undefined ? 0 : lane.lastStartedAt + interval,
      );
      const wait = readyAt - this.now();
      if (wait > 0) {
        lane.timer = setTimeout(() => {
          lane.timer = undefined;
          this.pump(lane);
        }, wait);
        return;
      }
      const job = lane.queue.shift()!;
      job.active = true;
      job.controller = new AbortController();
      ++job.attempts;
      lane.active.add(job);
      lane.lastStartedAt = this.now();
      lane.nextStartAt = lane.lastStartedAt + interval;
      this.start(job);
    }
  }

  private start(job: Job): void {
    let result: Promise<unknown>;
    try {
      result = job.run(job.controller!.signal);
    } catch (error) {
      result = Promise.reject(error);
    }
    void result.then(
      (value) => {
        job.active = false;
        job.lane.active.delete(job);
        if (!job.settled) {
          job.settled = true;
          job.resolve(value);
        }
        this.forget(job);
        this.pump(job.lane);
      },
      (error: unknown) => {
        const limited =
          error instanceof TtsHttpError &&
          error.status === 429 &&
          error.retryable &&
          !error.quota;
        if (limited) {
          const jitter = Math.max(0, Math.min(1, this.random())) * 250;
          const backoff = 1000 * 2 ** (job.attempts - 1) + jitter;
          const hint =
            Number.isFinite(error.retryAfterMs) && error.retryAfterMs! >= 0
              ? error.retryAfterMs!
              : 0;
          job.lane.cooldownUntil = Math.max(
            job.lane.cooldownUntil,
            this.now() + Math.max(backoff, hint),
          );
        }
        job.active = false;
        job.lane.active.delete(job);
        const remaining = job.lane.cooldownUntil - this.now();
        if (
          limited &&
          !job.cancelled &&
          !this.disposed &&
          job.attempts < MAX_ATTEMPTS &&
          remaining <= MAX_WAIT_MS
        )
          job.lane.queue.push(job);
        else {
          this.reject(
            job,
            limited && remaining > MAX_WAIT_MS
              ? new TtsHttpError(429, remaining)
              : error,
          );
          this.forget(job);
        }
        this.pump(job.lane);
      },
    );
  }
}
