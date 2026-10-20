export interface VoiceReferenceReport {
  duration: number;
  sampleRate: number;
  channels: number;
  warnings: string[];
}

/** 只做本机波形检查，不推断说话人身份、音乐类型或声纹相似度。 */
export function analyzeVoiceReference(
  channels: readonly Float32Array[],
  sampleRate: number,
): VoiceReferenceReport {
  const length = channels[0]?.length || 0;
  const duration = sampleRate > 0 ? length / sampleRate : 0;
  const warnings: string[] = [];
  if (!length || !Number.isFinite(duration) || duration <= 0)
    return {
      duration: 0,
      sampleRate,
      channels: channels.length,
      warnings: ["没有可分析的音频数据，请换一段清晰录音。"],
    };
  if (duration < 8)
    warnings.push("录音偏短，音色信息有限；建议换成 10–20 秒自然说话的片段。");
  if (duration > 30)
    warnings.push(
      "录音较长，建议选取 10–30 秒音色稳定的单人片段，减少长静音与背景声。",
    );
  if (sampleRate < 16000)
    warnings.push(
      "采样率偏低，高频信息可能不足；建议使用 16kHz 以上的原始录音，简单升采样不能恢复细节。",
    );
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
  let silentFrames = 0,
    frames = 0,
    clipped = 0,
    samples = 0,
    peak = 0;
  for (let start = 0; start < length; start += frameSize) {
    let energy = 0,
      count = 0;
    for (const channel of channels) {
      for (
        let index = start;
        index < Math.min(start + frameSize, channel.length);
        index++
      ) {
        const value = channel[index];
        peak = Math.max(peak, Math.abs(value));
        energy += value * value;
        if (Math.abs(value) >= 0.995) clipped++;
        count++;
      }
    }
    samples += count;
    if (!count || Math.sqrt(energy / count) < 0.003) silentFrames++;
    frames++;
  }
  if (silentFrames / frames > 0.6)
    warnings.push("静音或极轻的声音占比较高，建议换成说话更连续的片段。");
  if (peak < 0.01)
    warnings.push("录音音量很低，可能影响复刻；请优先使用录音清楚的原文件。");
  if (samples && clipped / samples > 0.003)
    warnings.push(
      "波形有明显削波风险，可能已有破音；调低播放音量无法修复录音失真。",
    );
  return { duration, sampleRate, channels: channels.length, warnings };
}
