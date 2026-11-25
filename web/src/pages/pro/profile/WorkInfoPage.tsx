import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../../api/ApiContext';
import { useMarket } from '../../../api/MarketContext';
import type { Postcode, ProProfile } from '../../../api/types';
import { useResource } from '../../../api/useResource';
import { ErrorText } from '../../../components/ErrorText';
import { FieldError } from '../../../components/FieldError';
import { Icon } from '../../../components/Icon';
import { ResourceState } from '../../../components/ResourceState';
import { useAction } from '../../../lib/useAction';
import { useValidation } from '../../../lib/useValidation';
import { AppHeader } from '../../../shells/Shells';
import { MAX_RADIUS_KM, MIN_RADIUS_KM } from '../ApplicationForm';
import { PRO_PROFILE_PATHS } from './types';

/** The API's limits for Work information (D100). */
export const MAX_YEARS = 60;
export const ABOUT_MAX_LENGTH = 400;
const ADDRESS_MIN_LENGTH = 3;

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** The form, filled from the saved profile; only what changed is sent. */
function WorkForm({ profile, onSaved }: { profile: ProProfile; onSaved: (p: ProProfile) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const market = useMarket();
  const loadPostcodes = useCallback(() => api.get<{ postcodes: Postcode[] }>('/postcodes'), [api]);
  const postcodes = useResource(loadPostcodes);
  const save = useAction();
  const [trades, setTrades] = useState<string[]>(profile.trades);
  const [years, setYears] = useState(profile.yearsExperience?.toString() ?? '');
  const [about, setAbout] = useState(profile.about ?? '');
  const [address, setAddress] = useState(profile.homeAddress ?? '');
  const [postcode, setPostcode] = useState(profile.homePostcode ?? '');
  const [radius, setRadius] = useState(profile.radiusKm);
  const [saved, setSaved] = useState(false);
  const pending = profile.pendingTrades ?? [];
  const yearsNumber = years === '' ? null : Number(years);

  const form = useValidation(
    {
      trades: trades.length === 0 && t('work.tradesMissing'),
      years: yearsNumber !== null && (!Number.isInteger(yearsNumber) || yearsNumber < 0 || yearsNumber > MAX_YEARS) && t('work.yearsInvalid', { max: MAX_YEARS }),
      about: about.length > ABOUT_MAX_LENGTH && t('work.aboutTooLong', { max: ABOUT_MAX_LENGTH }),
      address: address.trim().length < ADDRESS_MIN_LENGTH && t('work.addressMissing'),
      postcode: !postcode && t('work.postcodeMissing'),
    },
    { trades: 'work-trades', years: 'work-years', about: 'work-about', address: 'work-address', postcode: 'work-postcode' },
  );

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    setSaved(false);
    if (!form.check()) return;
    const body: Record<string, unknown> = {};
    if (!sameSet(trades, profile.trades)) body.trades = trades;
    if (yearsNumber !== (profile.yearsExperience ?? null)) body.yearsExperience = yearsNumber;
    if (about.trim() !== (profile.about ?? '')) body.about = about.trim() || null;
    if (address.trim() !== (profile.homeAddress ?? '')) body.homeAddress = address.trim();
    if (postcode !== (profile.homePostcode ?? '')) body.homePostcode = postcode;
    if (radius !== profile.radiusKm) body.radiusKm = radius;
    if (Object.keys(body).length === 0) {
      setSaved(true);
      return;
    }
    const result = await save.run(() => api.patch<{ profile: ProProfile }>('/pro/profile', body));
    if (result) {
      onSaved(result.profile);
      setTrades(result.profile.trades);
      setAbout(result.profile.about ?? '');
      setSaved(true);
    }
  }

  const toggleTrade = (id: string) => setTrades((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <section aria-labelledby="work-trades-heading" className="stack tight">
        <h2 id="work-trades-heading" className="h-sm first">
          {t('work.trades')}
        </h2>
        <div
          id="work-trades"
          className="chips"
          role="group"
          tabIndex={-1}
          aria-labelledby="work-trades-heading"
          aria-describedby={`work-trades-hint${form.message('trades') ? ' work-trades-error' : ''}`}
        >
          {market.categories.map((category) => {
            const on = trades.includes(category.id);
            const checking = on && pending.includes(category.id);
            return (
              <button
                key={category.id}
                type="button"
                className={`chip dark ${on ? 'on' : ''}`}
                aria-pressed={on}
                onClick={() => toggleTrade(category.id)}
              >
                {category.name}
                {checking && <span className="chip-note"> · {t('work.checking')}</span>}
              </button>
            );
          })}
        </div>
        <p id="work-trades-hint" className="tiny muted">
          {t('work.tradesHint')}
        </p>
        <FieldError id="work-trades" message={form.message('trades')} />
      </section>

      <section aria-labelledby="work-experience-heading" className="stack tight">
        <h2 id="work-experience-heading" className="h-sm">
          {t('work.experience')}
        </h2>
        <div className="field">
          <label htmlFor="work-years">{t('work.years')}</label>
          <input
            id="work-years"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={2}
            value={years}
            {...form.describe('years')}
            onChange={(event) => setYears(event.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, ''))}
          />
          <FieldError id="work-years" message={form.message('years')} />
        </div>
        <div className="field">
          <label htmlFor="work-about">{t('work.about')}</label>
          <textarea
            id="work-about"
            rows={3}
            maxLength={ABOUT_MAX_LENGTH}
            value={about}
            aria-invalid={form.describe('about')['aria-invalid']}
            aria-describedby={`work-about-hint${form.message('about') ? ' work-about-error' : ''}`}
            onChange={(event) => setAbout(event.target.value)}
          />
          <span id="work-about-hint" className="hint row between">
            <span>{t('work.aboutHint')}</span>
            <span aria-hidden="true">
              {about.length}/{ABOUT_MAX_LENGTH}
            </span>
          </span>
          <FieldError id="work-about" message={form.message('about')} />
        </div>
      </section>

      <section aria-labelledby="work-home-heading" className="stack tight">
        <h2 id="work-home-heading" className="h-sm">
          {t('apply.homeTitle')}
        </h2>
        <div className="field">
          <label htmlFor="work-address">{t('apply.street')}</label>
          <input
            id="work-address"
            autoComplete="street-address"
            maxLength={200}
            value={address}
            aria-invalid={form.describe('address')['aria-invalid']}
            aria-describedby={`work-home-private${form.message('address') ? ' work-address-error' : ''}`}
            onChange={(event) => setAddress(event.target.value)}
          />
          <FieldError id="work-address" message={form.message('address')} />
        </div>
        <ResourceState state={postcodes.state} reload={postcodes.reload}>
          {({ postcodes: list }) => (
            <div className="field">
              <label htmlFor="work-postcode">{t('apply.postcode')}</label>
              <select
                id="work-postcode"
                autoComplete="postal-code"
                value={postcode}
                {...form.describe('postcode')}
                onChange={(event) => setPostcode(event.target.value)}
              >
                <option value="">{t('book.choosePostcode')}</option>
                {list.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
              <FieldError id="work-postcode" message={form.message('postcode')} />
            </div>
          )}
        </ResourceState>
        <p id="work-home-private" className="small row gap4">
          <Icon name="lock" /> {t('work.homePrivate')}
        </p>
      </section>

      <section aria-labelledby="work-travel-heading" className="stack tight">
        <h2 id="work-travel-heading" className="h-sm">
          {t('apply.travelTitle')}
        </h2>
        <div className="card">
          <div className="row between">
            <label htmlFor="work-radius" className="small muted">
              {t('apply.fromHome')}
            </label>
            <b aria-hidden="true">{t('apply.radiusValue', { km: radius })}</b>
          </div>
          <input
            id="work-radius"
            className="range"
            type="range"
            min={MIN_RADIUS_KM}
            max={MAX_RADIUS_KM}
            step={1}
            value={radius}
            aria-valuetext={t('apply.radiusValue', { km: radius })}
            aria-describedby="work-radius-range"
            onChange={(event) => setRadius(Number(event.target.value))}
          />
          <p id="work-radius-range" className="tiny muted">
            {t('apply.radiusRange')}
          </p>
        </div>
      </section>

      <ErrorText error={save.error} />
      {saved && (
        <p className="small brand-text" role="status">
          {pending.length > 0 ? t('work.savedChecking') : t('work.saved')}
        </p>
      )}
      <button className="cta dark" type="submit" disabled={save.busy}>
        {t('work.save')}
      </button>
    </form>
  );
}

/**
 * Work information (D100): trades as on/off buttons (a new one is checked by MISK before jobs come in it), years
 * of experience, "About you" that customers see, the private home address and the travel distance (3 to 30 km).
 */
export function WorkInfoPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ profile: ProProfile }>('/pro/profile'), [api]);
  const { state, reload, update } = useResource(load);
  return (
    <>
      <AppHeader title={t('proProfile.workInfo')} back={PRO_PROFILE_PATHS.profile} />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ profile }) => <WorkForm profile={profile} onSaved={(next) => update(() => ({ profile: next }))} />}
        </ResourceState>
      </div>
    </>
  );
}
