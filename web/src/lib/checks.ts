/** The same format checks the API makes, so forms can say what is wrong before anything is sent. */

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** International format: + and 8 to 15 digits; spaces, dashes, dots, brackets and a leading 00 are allowed. */
const E164 = /^\+[1-9]\d{7,14}$/;

/** The longest email address the API accepts. */
export const MAX_EMAIL_LENGTH = 254;

export const isValidEmail = (email: string) => EMAIL_FORMAT.test(email.trim());

/**
 * A postcode from any country, as the API checks it after normalizePostcode (D84): 2 to 10 letters, digits,
 * single spaces and hyphens, starting and ending with a letter or digit and holding at least one digit.
 */
const POSTCODE_FORMAT = /^(?=[A-Z -]*\d)[A-Z0-9](?:[ -]?[A-Z0-9]){1,9}$/;
/** The longest postcode once normalized. */
export const MAX_POSTCODE_LENGTH = 10;

/** Upper-case with single spaces and nothing around it, the way the API stores postcodes. */
export const normalizePostcode = (input: string) => input.trim().toUpperCase().replace(/\s+/g, ' ');

/** Tidies a postcode while it is typed: upper-case and single spaces, but a space at the end may stay. */
export const tidyPostcodeInput = (input: string) => input.toUpperCase().replace(/\s+/g, ' ').replace(/^ /, '');

export function isValidPostcode(input: string): boolean {
  const code = normalizePostcode(input);
  return code.length <= MAX_POSTCODE_LENGTH && POSTCODE_FORMAT.test(code);
}

export function isValidPhone(phone: string): boolean {
  const compact = phone.trim().replace(/[\s\-().]/g, '');
  return E164.test(compact.startsWith('00') ? `+${compact.slice(2)}` : compact);
}
