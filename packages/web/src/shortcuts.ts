// Keyboard-shortcut labels for the host platform. The handlers already
// accept both ⌘ and Ctrl; only the labels need to match what the user's
// keyboard says: "⌘K" on macOS, "Ctrl+K" elsewhere.

interface NavigatorWithUAData extends Navigator {
  userAgentData?: { platform?: string };
}

function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as NavigatorWithUAData;
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac/i.test(platform);
}

export const isMac = detectMac();

const MAC_SYMBOLS: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥', enter: '↵' };
const PC_NAMES: Record<string, string> = {
  mod: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  enter: 'Enter',
};

/**
 * Formats a shortcut written as `mod+shift+s`, where `mod` is ⌘ on macOS and
 * Ctrl elsewhere: `shortcut('mod+k')` → "⌘K" / "Ctrl+K".
 */
export function shortcut(keys: string): string {
  const parts = keys.split('+').map((k) => k.trim().toLowerCase());
  const names = isMac ? MAC_SYMBOLS : PC_NAMES;
  const labels = parts.map((k) => names[k] ?? (k.length === 1 ? k.toUpperCase() : k));
  return isMac ? labels.join('') : labels.join('+');
}
