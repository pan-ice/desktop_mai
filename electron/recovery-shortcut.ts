const candidates = [
  ["CommandOrControl+Shift+M", "Ctrl + Shift + M"],
  ["CommandOrControl+Alt+Shift+M", "Ctrl + Alt + Shift + M"],
  ["CommandOrControl+Shift+F12", "Ctrl + Shift + F12"],
] as const;

/** Return the shortcut that actually registered so the UI can describe it. */
export function registerRecoveryShortcut(
  register: (accelerator: string, callback: () => void) => boolean,
  restore: () => void,
): string | null {
  for (const [accelerator, label] of candidates) {
    try {
      if (register(accelerator, restore)) return label;
    } catch {
      // A native registration failure must not prevent another recovery key.
    }
  }
  return null;
}
