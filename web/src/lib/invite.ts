/**
 * The team's "Invite pro" link opens the app with ?as=pro. It is remembered for this browser tab, so the
 * role question after signing in starts on "pro" even after the sign-in steps changed the address.
 */
const KEY = 'misk.invitedAs';

export function rememberInvite(params: URLSearchParams) {
  if (params.get('as') !== 'pro') {
    return;
  }
  try {
    sessionStorage.setItem(KEY, 'pro');
  } catch {
    // Storage can be blocked (private mode); the person then simply picks "pro" themselves.
  }
}

export function invitedAsPro(): boolean {
  try {
    return sessionStorage.getItem(KEY) === 'pro';
  } catch {
    return false;
  }
}
