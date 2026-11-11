/** The same format checks the API makes, so forms can say what is wrong before anything is sent. */

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** International format: + and 8 to 15 digits; spaces, dashes, dots, brackets and a leading 00 are allowed. */
const E164 = /^\+[1-9]\d{7,14}$/;

export const isValidEmail = (email: string) => EMAIL_FORMAT.test(email.trim());

export function isValidPhone(phone: string): boolean {
  const compact = phone.trim().replace(/[\s\-().]/g, '');
  return E164.test(compact.startsWith('00') ? `+${compact.slice(2)}` : compact);
}
