import type { Api } from '../api/client';

/** What this browser can do with push notifications right now. */
export type PushState = 'unsupported' | 'not_set_up' | 'denied' | 'off' | 'on';

const WORKER_URL = '/sw.js';

function supported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** The server's VAPID public key, turned into the bytes the browser asks for. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function pushState(api: Api): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const { publicKey } = await api.get<{ publicKey: string | null }>('/push/key');
  if (!publicKey) return 'not_set_up';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await navigator.serviceWorker.getRegistration(WORKER_URL);
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? 'on' : 'off';
}

/** Asks the browser for permission and tells MISK where to send this person's notifications. */
export async function turnPushOn(api: Api): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const { publicKey } = await api.get<{ publicKey: string | null }>('/push/key');
  if (!publicKey) return 'not_set_up';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const registration = await navigator.serviceWorker.register(WORKER_URL);
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  const json = subscription.toJSON();
  await api.post('/push/subscriptions', { endpoint: subscription.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } });
  return 'on';
}

export async function turnPushOff(api: Api): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const registration = await navigator.serviceWorker.getRegistration(WORKER_URL);
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await api.post('/push/subscriptions/remove', { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  }
  return 'off';
}
