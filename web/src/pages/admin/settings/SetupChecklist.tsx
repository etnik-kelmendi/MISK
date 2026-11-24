import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi, useAppConfig } from '../../../api/ApiContext';
import type { SetupStatus } from '../../../api/types';
import { useResource } from '../../../api/useResource';
import { DEFAULT_TILE_URL, tileUrlTemplate } from '../../../components/LiveMap';

/** Settings the control panel's own build knows about; the API reports the server's (D98). */
type WebSetupKey = 'privacy_url' | 'map_tiles';

/**
 * Settings → Team & access: a warning when a pro's issue report cannot be emailed to anyone, and the read-only
 * Setup checklist of optional production settings, yes or no only, never a value (D98).
 */
export function SetupChecklist() {
  const { t } = useTranslation();
  const api = useApi();
  const config = useAppConfig();
  const load = useCallback(() => api.get<SetupStatus>('/admin/team/setup'), [api]);
  const { state } = useResource(load);
  // Only helpful extra information: when it cannot be loaded, the rest of the page stays as it is.
  if (state.status !== 'ready') return null;

  const { checklist, issueAlertsEmailable } = state.data;
  const web: { key: WebSetupKey; set: boolean }[] = [
    { key: 'privacy_url', set: config.privacyUrl !== null },
    { key: 'map_tiles', set: tileUrlTemplate() !== DEFAULT_TILE_URL },
  ];
  const items = [...checklist, ...web];

  return (
    <>
      {!issueAlertsEmailable && (
        <p className="note warn-note" role="alert">
          {t('admin.settings.setup.alertsNotEmailed')}
        </p>
      )}
      <section className="panel stack" aria-labelledby="setup-heading">
        <h2 id="setup-heading">{t('admin.settings.setup.title')}</h2>
        <p className="small muted">{t('admin.settings.setup.intro')}</p>
        <ul className="setup-list">
          {items.map((item) => (
            <li key={item.key}>
              <div>
                <span className="b">{t(`admin.settings.setup.items.${item.key}.label`)}</span>
                {!item.set && <div className="small muted">{t(`admin.settings.setup.items.${item.key}.effect`)}</div>}
              </div>
              <span className={`badge ${item.set ? 'g' : 'a'}`}>{item.set ? t('admin.settings.setup.set') : t('admin.settings.setup.notSet')}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
