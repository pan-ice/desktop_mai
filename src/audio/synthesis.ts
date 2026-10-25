import { api } from "../api";
import type { SynthesisOptions } from "../../shared/types";

function cancelled() {
  return new DOMException("语音合成已取消", "AbortError");
}

/** Cancellation reaches the main-process queue, including work not sent yet. */
export function requestSynthesis(
  text: string,
  priority: SynthesisOptions["priority"],
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(cancelled());
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      api.cancelSynthesis?.(id);
      reject(cancelled());
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    let response: Promise<string>;
    try {
      response = api.synthesizeResult
        ? api.synthesizeResult(text, { id, priority }).then((result) => {
            if (result.ok) return result.value;
            // Error names do not survive Electron's contextBridge. Rebuild
            // them in this world from the main process's safe result metadata.
            const error = new Error(result.error);
            if (result.errorKind === "cancelled") error.name = "AbortError";
            if (result.errorKind === "tts_final") error.name = "TtsFinalError";
            throw error;
          })
        : api.synthesize(text, { id, priority });
    } catch (error) {
      response = Promise.reject(error);
    }
    void response.then(
      (url) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(url);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function finalSynthesisError(error: unknown) {
  return (
    error instanceof Error &&
    ["AbortError", "TtsFinalError"].includes(error.name)
  );
}
