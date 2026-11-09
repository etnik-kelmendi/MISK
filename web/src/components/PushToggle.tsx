import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../api/ApiContext';
import { pushState, turnPushOff, turnPushOn, type PushState } from '../lib/push';
import { useAction } from '../lib/useAction';
import { ErrorText } from './ErrorText';

/** "Notifications on this device": turns Web Push on or off for the signed-in person in this browser. */
export function PushToggle({ onChange, buttonClass = 'btn btn-ghost' }: { onChange?: (state: PushState) => void; buttonClass?: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const [state, setState] = useState<PushState | null>(null);

  useEffect(() => {
    let current = true;
    pushState(api).then(
      (value) => current && setState(value),
      (error: unknown) => {
        console.warn('Could not check push notifications', error);
        if (current) setState('unsupported');
      },
    );
    return () => {
      current = false;
    };
  }, [api]);

  async function toggle(on: boolean) {
    const next = await action.run(() => (on ? turnPushOn(api) : turnPushOff(api)));
    if (next) {
      setState(next);
      onChange?.(next);
    }
  }

  if (state === null) return null;
  const text = {
    unsupported: t('push.unsupported'),
    not_set_up: t('push.notSetUp'),
    denied: t('push.denied'),
    off: t('push.isOff'),
    on: t('push.isOn'),
  }[state];
  return (
    <section className="stack tight" aria-labelledby="push-heading">
      <h2 id="push-heading" className="h-sm">
        {t('push.title')}
      </h2>
      <p className="small muted">{text}</p>
      {(state === 'off' || state === 'on') && (
        <button type="button" className={buttonClass} disabled={action.busy} onClick={() => void toggle(state === 'off')}>
          {state === 'off' ? t('push.on') : t('push.off')}
        </button>
      )}
      <ErrorText error={action.error} />
    </section>
  );
}
