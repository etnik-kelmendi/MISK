import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// OWASP's minimum Argon2id settings. The library's default algorithm is Argon2id.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Wrong passwords never lock an account (D18). Instead each failed log-in answers about a second
 * later: a person retrying does not notice, but automated guessing slows to a crawl.
 */
export const FAILED_LOGIN_DELAY_MS = 1000;

export function slowDownFailedLogin(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

const unknownUserHash = hashPassword(randomBytes(32).toString('hex'));

/** Spends the same time as a real check, so response times do not reveal whether an account exists. */
export async function spendVerificationTime(password: string): Promise<void> {
  await verifyPassword(await unknownUserHash, password);
}
