import type { Snapshot } from "./types";

/** 已验证的内核名字只影响显示，不覆盖手动保存的称呼。 */
export function displayBotName(
  state: Pick<Snapshot, "settings" | "botName">,
): string {
  return state.settings.followBotName && state.botName
    ? state.botName
    : state.settings.nickname;
}
