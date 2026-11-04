/** International format: a plus sign, a country code, and 8 to 15 digits in total. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Accepts a number as people type it ("+49 170 123-4567", "0049 170 1234567") and returns it in
 * international format, or null when it cannot be one. A number without a country code is refused,
 * because guessing the country could text a stranger.
 */
export function normalizePhone(input: string): string | null {
  const compact = input.trim().replace(/[\s\-().]/g, '');
  const international = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return E164.test(international) ? international : null;
}
