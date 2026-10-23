import type { Settings } from "./types";
import { ttsProfile, type TtsProfile } from "./tts";

/** 外部设置更新只替换未编辑字段，保留尚未保存和保存期间继续编辑的草稿。 */
export function mergeSettingsDraft(
  draft: Settings,
  previous: Settings,
  saved: Settings,
): Settings {
  const result = { ...draft };
  let changed = false;
  const update = <K extends keyof Settings>(key: K) => {
    if (
      JSON.stringify(draft[key]) === JSON.stringify(previous[key]) &&
      JSON.stringify(draft[key]) !== JSON.stringify(saved[key])
    ) {
      result[key] = saved[key];
      changed = true;
    }
  };
  for (const key of Object.keys(saved) as (keyof Settings)[]) update(key);
  return changed ? result : draft;
}

/** 明确选用音色只替换目标服务商的设置，之后的新输入仍保留为草稿。 */
export function mergeAppliedVoiceDraft(
  draft: Settings,
  beforeApply: Settings,
  applied: Settings,
): Settings {
  const provider = applied.ttsProvider;
  const profile = { ...ttsProfile(draft, provider) };
  const previousProfile = ttsProfile(beforeApply, provider);
  const appliedProfile = ttsProfile(applied, provider);
  for (const key of Object.keys(appliedProfile) as (keyof TtsProfile)[]) {
    if (profile[key] === previousProfile[key])
      profile[key] = appliedProfile[key];
  }
  const merged = mergeSettingsDraft(draft, beforeApply, {
    ...beforeApply,
    ttsEngine: applied.ttsEngine,
    ttsProvider: provider,
  });
  return {
    ...merged,
    ttsProfiles: { ...draft.ttsProfiles, [provider]: profile },
  };
}
