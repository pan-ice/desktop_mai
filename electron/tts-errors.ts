function message(status: number): string {
  if (status === 429)
    return "语音服务请求受限（HTTP 429），可能是请求限流或账户额度限制，请稍后重试或检查服务商用量";
  if (status === 402)
    return "语音服务余额或额度不足（HTTP 402），请检查服务商账户用量和余额";
  if (status === 401)
    return "语音服务认证失败（HTTP 401），请检查当前服务商的 API Key";
  if (status === 403)
    return "语音服务拒绝访问（HTTP 403），请检查服务权限和模型访问资格";
  return `语音服务请求失败（HTTP ${status}），请检查模型、服务状态和访问权限`;
}

export class TtsHttpError extends Error {
  readonly quota: boolean;
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message(status));
    this.name = "TtsHttpError";
    this.quota = status === 402;
    this.retryable = status === 429;
  }
}

function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const milliseconds = Number(text) * 1000;
    return Number.isSafeInteger(Math.ceil(milliseconds))
      ? Math.ceil(milliseconds)
      : undefined;
  }
  // A date must contain its textual HTTP-date parts. In particular, a negative
  // delta must not be interpreted by Date.parse as a historical calendar date.
  if (!/[A-Za-z]/.test(text)) return undefined;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Keep only safe protocol metadata; provider error bodies may contain secrets. */
export async function ttsResponseError(
  response: Response,
  now = Date.now(),
): Promise<TtsHttpError> {
  const retryAfterMs = retryAfter(response.headers.get("Retry-After"), now);
  await response.body?.cancel().catch(() => {});
  return new TtsHttpError(response.status, retryAfterMs);
}
