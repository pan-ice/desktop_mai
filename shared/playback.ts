import { z } from "zod";

export interface PlaybackState {
  id: string | null;
  phase: "idle" | "preparing" | "playing";
  /** null 表示系统朗读等无法采样的声音；0 表示采样到静音。 */
  mouth: number | null;
}

export const idlePlayback: PlaybackState = {
  id: null,
  phase: "idle",
  mouth: 0,
};

const id = z.string().uuid();
export const playbackReportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), id }).strict(),
  z
    .object({
      type: z.literal("playing"),
      id,
      mouth: z.number().min(0).max(1).nullable(),
    })
    .strict(),
  z.object({ type: z.literal("end"), id }).strict(),
]);
export type PlaybackReport = z.infer<typeof playbackReportSchema>;

export function audioRms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index++) {
    const value = Number.isFinite(samples[index]) ? samples[index] : 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export function mouthFromRms(rms: number, previous: number): number {
  const target = Math.min(1, Math.max(0, rms - 0.006) * 9);
  const value =
    previous + (target - previous) * (target > previous ? 0.65 : 0.45);
  return value < 0.01 ? 0 : value;
}
