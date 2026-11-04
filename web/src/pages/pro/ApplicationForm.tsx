import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { DocumentKind, Postcode, ProProfile } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { DOCUMENT_TYPES, FileButton } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { useAction } from '../../lib/useAction';

export const DOCUMENT_KINDS: DocumentKind[] = ['id', 'certificate', 'insurance'];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * Trades, area, working days and documents. Every change is saved at once, so nothing is lost if the
 * pro leaves halfway. Trades are locked once the team has the application.
 */
export function ApplicationForm({ profile, onChange }: { profile: ProProfile; onChange: (p: ProProfile) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const market = useMarket();
  const save = useAction();
  const docs = useAction();
  const submit = useAction();
  const loadPostcodes = useCallback(() => api.get<{ postcodes: Postcode[] }>('/postcodes'), [api]);
  const postcodes = useResource(loadPostcodes);
  const [radius, setRadius] = useState(profile.radiusKm);
  const tradesLocked = profile.status !== 'draft' && profile.status !== 'rejected';
  const canSubmit = profile.status === 'draft' || profile.status === 'rejected';
  const docsDone = DOCUMENT_KINDS.filter((kind) => profile.documents[kind]).length;

  async function patch(body: Partial<Pick<ProProfile, 'trades' | 'homePostcode' | 'radiusKm' | 'workingDays'>>) {
    const result = await save.run(() => api.patch<{ profile: ProProfile }>('/pro/profile', body));
    if (result) {
      onChange(result.profile);
    }
  }

  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  return (
    <div className="stack">
      <fieldset disabled={tradesLocked || save.busy}>
        <legend className="h-sm">{t('apply.trades')}</legend>
        <div className="chips">
          {market.categories.map((category) => (
            <label key={category.id} className={`chip dark ${profile.trades.includes(category.id) ? 'on' : ''}`}>
              <input
                type="checkbox"
                className="visually-hidden"
                checked={profile.trades.includes(category.id)}
                onChange={() => void patch({ trades: toggle(profile.trades, category.id) })}
              />
              {category.name}
            </label>
          ))}
        </div>
        {tradesLocked && <p className="tiny muted">{t('apply.tradesLocked')}</p>}
      </fieldset>

      <section aria-labelledby="docs-heading">
        <h2 id="docs-heading" className="h-sm">
          {t('apply.documents', { done: docsDone })}
        </h2>
        {DOCUMENT_KINDS.map((kind) => {
          const doc = profile.documents[kind];
          return (
            <div key={kind} className={`doc ${doc ? 'ok' : ''}`}>
              <span className="di">
                <Icon name={doc ? 'check' : 'file'} />
              </span>
              <span className="grow">
                <span className="b small block">{t(`apply.doc.${kind}`)}</span>
                <span className="tiny muted">{doc ? t('apply.uploaded') : t('apply.fileTypes')}</span>
              </span>
              <FileButton
                label={doc ? t('apply.replace') : t('apply.upload')}
                accept={DOCUMENT_TYPES}
                onFile={async (file) => {
                  const result = await docs.run(() => api.upload<{ profile: ProProfile }>(`/pro/documents/${kind}`, file));
                  if (result) {
                    onChange(result.profile);
                  }
                }}
              />
            </div>
          );
        })}
        <ErrorText error={docs.error} />
      </section>

      <section aria-labelledby="area-heading" className="card stack">
        <h2 id="area-heading" className="h-sm">
          {t('apply.area')}
        </h2>
        <ResourceState state={postcodes.state} reload={postcodes.reload}>
          {({ postcodes: list }) => (
            <div className="field">
              <label htmlFor="home-postcode">{t('apply.homePostcode')}</label>
              <select
                id="home-postcode"
                value={profile.homePostcode ?? ''}
                disabled={save.busy}
                onChange={(event) => event.target.value && void patch({ homePostcode: event.target.value })}
              >
                <option value="">{t('book.choosePostcode')}</option>
                {list.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </ResourceState>
        <div className="field">
          <label htmlFor="radius">{t('apply.radius', { km: radius })}</label>
          <input
            id="radius"
            type="range"
            min={3}
            max={30}
            value={radius}
            onChange={(event) => setRadius(Number(event.target.value))}
            onPointerUp={() => radius !== profile.radiusKm && void patch({ radiusKm: radius })}
            onKeyUp={() => radius !== profile.radiusKm && void patch({ radiusKm: radius })}
          />
        </div>
      </section>

      <fieldset disabled={save.busy}>
        <legend className="h-sm">{t('apply.days')}</legend>
        <div className="wk dark">
          {WEEKDAYS.map((day) => (
            <label key={day} className={profile.workingDays.includes(day) ? 'on' : ''}>
              <input
                type="checkbox"
                className="visually-hidden"
                checked={profile.workingDays.includes(day)}
                onChange={() => void patch({ workingDays: toggle(profile.workingDays, day) })}
              />
              {t(`weekday.${day}`)}
            </label>
          ))}
        </div>
        <p className="small muted row gap4">
          <Icon name="clock" /> {t('apply.hours')}
        </p>
      </fieldset>
      <ErrorText error={save.error} />

      {canSubmit && (
        <>
          <ErrorText error={submit.error} />
          <button
            type="button"
            className="cta dark"
            disabled={submit.busy}
            onClick={() =>
              void submit.run(() => api.post<{ profile: ProProfile }>('/pro/submit')).then((result) => result && onChange(result.profile))
            }
          >
            {t('apply.submit')}
          </button>
        </>
      )}
    </div>
  );
}
