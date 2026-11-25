import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Api } from '../../api/client';
import type { ProAvailability, ProProfile } from '../../api/types';
import { ErrorText } from '../../components/ErrorText';
import { useAction } from '../../lib/useAction';

/** Whether new offers come in right now (D94): the switch, unless working hours, a day off or a holiday say no. */
export function isOnlineNow(profile: ProProfile): boolean {
  return profile.availability ? profile.availability.onlineNow : profile.online !== false;
}

/**
 * Saves the switch and returns the profile as it is now, with the availability the server worked out (D94).
 */
export async function saveOnline(api: Api, profile: ProProfile, online: boolean): Promise<ProProfile> {
  const result = await api.put<{ online: boolean; availability?: ProAvailability }>('/pro/online', { online });
  return { ...profile, online: result.online, ...(result.availability ? { availability: result.availability } : {}) };
}

/**
 * The Online switch in the pro header (D86), the same on Jobs and My week (D99): a real switch saved on the
 * server. `onChange` saves it and returns the new profile; the result is announced to screen readers.
 */
export function OnlineSwitch({ profile, onChange }: { profile: ProProfile; onChange: (online: boolean) => Promise<ProProfile> }) {
  const { t } = useTranslation();
  const { run, busy, error } = useAction();
  const [announce, setAnnounce] = useState('');
  const online = isOnlineNow(profile);

  async function toggle() {
    const next = await run(() => onChange(!online));
    if (next) setAnnounce(isOnlineNow(next) ? t('pro.nowOnline') : t('pro.nowOffline'));
  }

  return (
    <span className="right">
      <button
        type="button"
        role="switch"
        aria-checked={online}
        aria-label={t('pro.onlineSwitch')}
        className={`online ${online ? '' : 'off'}`}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {online && <span className="lamp" aria-hidden="true" />}
        {online ? t('pro.online') : t('pro.offline')}
        <span className={`toggle sm ${online ? 'on' : ''}`} aria-hidden="true" />
      </button>
      <ErrorText error={error} />
      <span className="visually-hidden" role="status">
        {announce}
      </span>
    </span>
  );
}
