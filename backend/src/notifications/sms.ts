export interface SmsResult {
  providerId: string;
}

/** Sends one text message. Throws when the provider refuses or cannot be reached. */
export type SmsSender = (to: string, body: string) => Promise<SmsResult>;

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string;
}

const TIMEOUT_MS = 10_000;

export function createTwilioSender(config: TwilioConfig): SmsSender {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`;
  const authorization = `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`;

  return async (to, body) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: config.from, Body: body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const result = (await response.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!response.ok || !result.sid) {
      // The provider's own message helps the Admin fix a wrong number; it never contains the token.
      throw new Error(`SMS provider refused the message (${response.status}): ${result.message ?? 'no details'}`);
    }
    return { providerId: result.sid };
  };
}
