import type { Settings } from "../shared/types";

export function inQuietHours(
  hour: number,
  start: number,
  end: number,
): boolean {
  if (start === end) return false;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

export function shouldReachOut(
  settings: Settings,
  now: number,
  lastInteraction: number,
  connected: boolean,
  focusUntil: number | null,
): boolean {
  return (
    settings.proactiveEnabled &&
    connected &&
    (!focusUntil || now >= focusUntil) &&
    !inQuietHours(
      new Date(now).getHours(),
      settings.quietStart,
      settings.quietEnd,
    ) &&
    now - lastInteraction >= settings.proactiveMinutes * 60000
  );
}
