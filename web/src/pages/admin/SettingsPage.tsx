import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import type { Settings } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { ResourceState } from '../../components/ResourceState';
import { euro, parseEuroToCents } from '../../lib/format';
import { useAction } from '../../lib/useAction';

function SettingsForm({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { run, busy, error } = useAction();
  const [fee, setFee] = useState((settings.serviceFeeCents / 100).toFixed(2));
  const [share, setShare] = useState(settings.proSharePct);
  const [saved, setSaved] = useState(false);
  const feeCents = parseEuroToCents(fee);
  const example = 5000;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (feeCents === null) {
      return;
    }
    setSaved(false);
    const result = await run(() => api.patch<{ settings: Settings }>('/admin/settings', { serviceFeeCents: feeCents, proSharePct: share }));
    if (result) {
      onSaved(result.settings);
      setSaved(true);
    }
  }

  return (
    <form className="panel fgrid" onSubmit={submit}>
      <div className="af">
        <label htmlFor="fee">{t('admin.settings.fee')}</label>
        <input id="fee" inputMode="decimal" required value={fee} onChange={(e) => setFee(e.target.value)} />
        <span className="hint">{t('admin.settings.feeHint')}</span>
      </div>
      <div className="af full">
        <label htmlFor="share">{t('admin.settings.share', { pct: share })}</label>
        <input id="share" type="range" min={50} max={95} value={share} onChange={(e) => setShare(Number(e.target.value))} />
        <span className="hint">
          {t('admin.settings.example', {
            price: euro(example),
            pro: euro(Math.floor((example * share) / 100)),
            misk: euro(example - Math.floor((example * share) / 100)),
          })}
        </span>
      </div>
      <p className="small muted full">{t('admin.settings.onlyNew')}</p>
      <ErrorText error={error} />
      {saved && (
        <p className="small brand-text" role="status">
          {t('common.saved')}
        </p>
      )}
      <button type="submit" className="abtn" disabled={busy || feeCents === null}>
        {t('common.save')}
      </button>
    </form>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ settings: Settings }>('/admin/settings'), [api]);
  const { state, reload, update } = useResource(load);
  return (
    <>
      <h1>{t('admin.settings.title')}</h1>
      <ResourceState state={state} reload={reload}>
        {({ settings }) => <SettingsForm settings={settings} onSaved={(next) => update(() => ({ settings: next }))} />}
      </ResourceState>
    </>
  );
}
