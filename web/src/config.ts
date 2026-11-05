/** Which website this build is: the customer and pro app, or the admin control panel. */
export type Site = 'app' | 'admin';

export interface AppConfig {
  site: Site;
  apiBaseUrl: string;
  /** Links shown at sign-in. Unset until the owner publishes them (QUESTIONS Q7). */
  termsUrl: string | null;
  privacyUrl: string | null;
}

interface RawEnv {
  /** Vite's build mode; `--mode admin` builds the control panel. */
  MODE?: string;
  VITE_API_BASE_URL?: string;
  VITE_TERMS_URL?: string;
  VITE_PRIVACY_URL?: string;
}

function httpUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  return value;
}

function optionalUrl(name: string, value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? httpUrl(name, trimmed) : null;
}

export function loadConfig(env: RawEnv): AppConfig {
  const api = env.VITE_API_BASE_URL?.trim();
  if (!api) {
    throw new Error('VITE_API_BASE_URL is required');
  }
  return {
    site: env.MODE === 'admin' ? 'admin' : 'app',
    apiBaseUrl: httpUrl('VITE_API_BASE_URL', api).replace(/\/+$/, ''),
    termsUrl: optionalUrl('VITE_TERMS_URL', env.VITE_TERMS_URL),
    privacyUrl: optionalUrl('VITE_PRIVACY_URL', env.VITE_PRIVACY_URL),
  };
}
