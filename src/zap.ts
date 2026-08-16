// Zap: real-TV channel navigation for the CrowFlix player.
//
// The zap list is the caller's currently visible channel order (the browse
// context the user last looked at), so channel up/down feels like hardware
// channel surf within whatever the user was browsing.

export const MAX_ZAP_DIGITS = 4;

/** Wrap-based channel surf. Returns null when there is nothing to play. */
export function zapTarget(
  keys: string[],
  currentKey: string | null,
  direction: 1 | -1,
): string | null {
  if (!keys.length) return null;
  const index = currentKey ? keys.indexOf(currentKey) : -1;
  if (index === -1) return direction === 1 ? keys[0] : keys[keys.length - 1];
  return keys[(index + direction + keys.length) % keys.length];
}

/** Append a digit to the on-screen channel-number buffer. */
export function appendZapDigit(buffer: string, digit: string): string {
  if (!/^[0-9]$/.test(digit)) return buffer;
  return (buffer + digit).slice(-MAX_ZAP_DIGITS);
}

/**
 * Resolve a typed channel number to a zap-list index (typed numbers are
 * 1-based, matching every real remote control). Returns null when the number
 * does not address a channel in the list.
 */
export function resolveZapNumber(buffer: string, listLength: number): number | null {
  if (!buffer || !listLength) return null;
  const number = Number.parseInt(buffer, 10);
  if (!Number.isFinite(number) || number < 1 || number > listLength) return null;
  return number - 1;
}
