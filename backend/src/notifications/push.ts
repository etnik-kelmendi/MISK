import webpush from 'web-push';

/** VAPID keys for Web Push; generate once with `npx web-push generate-vapid-keys`. */
export interface PushConfig {
  publicKey: string;
  privateKey: string;
  /** "mailto:team@misk.app" or an https URL, so push services can reach MISK about problems. */
  subject: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
}

/** The browser no longer accepts messages for this subscription; it should be forgotten. */
export class PushGoneError extends Error {}

/** Sends one notification to one browser. Throws `PushGoneError` when the subscription has ended. */
export type PushSender = (target: PushTarget, message: PushMessage) => Promise<void>;

const TIMEOUT_MS = 10_000;
/** A message nobody's phone picked up within a day is no longer useful. */
const TTL_SECONDS = 24 * 60 * 60;

export function createPushSender(config: PushConfig): PushSender {
  return async (target, message) => {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(message),
        {
          vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
          TTL: TTL_SECONDS,
          timeout: TIMEOUT_MS,
        },
      );
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        throw new PushGoneError('Push subscription has ended');
      }
      throw error;
    }
  };
}
