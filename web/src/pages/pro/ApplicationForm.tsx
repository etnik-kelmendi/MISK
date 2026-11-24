import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import { EXPIRING_KINDS, UPLOAD_KINDS, type Postcode, type ProProfile, type UploadKind } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { DOCUMENT_TYPES, FileButton } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { longDate } from '../../lib/format';
import { useAction } from '../../lib/useAction';

export { UPLOAD_KINDS };
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
/** Changes are saved this long after the last one, so typing or sliding sends one request, not many. */
export const AUTOSAVE_DELAY_MS = 400;
export const MIN_RADIUS_KM = 3;
export const MAX_RADIUS_KM = 30;

/** What the pro can change on the application; each change is saved by itself (D93). */
export interface ApplicationDraft {
  trades: string[];
  homeAddress: string;
  homePostcode: string;
  radiusKm: number;
  workingDays: number[];
  backgroundConsent: boolean;
}

type PatchBody = Partial<Omit<ApplicationDraft, 'homeAddress' | 'homePostcode'>> & { homeAddress?: string; homePostcode?: string };

function draftOf(profile: ProProfile): ApplicationDraft {
  return {
    trades: profile.trades,
    homeAddress: profile.homeAddress ?? '',
    homePostcode: profile.homePostcode ?? '',
    radiusKm: profile.radiusKm,
    workingDays: profile.workingDays,
    backgroundConsent: Boolean(profile.backgroundConsentAt),
  };
}

export type SaveStatus = 'idle' | 'saving' | 'saved';

/**
 * Keeps the pro's answers on screen at once and saves them in the background: changes made within
 * AUTOSAVE_DELAY_MS go out together, one request at a time, so nothing is lost when the pro leaves halfway.
 * `flush` sends what is still waiting, e.g. before the application is sent.
 */
export function useApplicationDraft(profile: ProProfile, onChange: (p: ProProfile) => void) {
  const api = useApi();
  const [draft, setDraft] = useState<ApplicationDraft>(() => draftOf(profile));
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<unknown>(null);
  const pending = useRef<PatchBody>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const send = useCallback(async (): Promise<void> => {
    if (running.current) {
      await running.current;
    }
    const body = pending.current;
    if (Object.keys(body).length === 0) {
      return;
    }
    pending.current = {};
    setStatus('saving');
    const work = api
      .patch<{ profile: ProProfile }>('/pro/profile', body)
      .then((result) => {
        setError(null);
        onChangeRef.current(result.profile);
        setStatus(Object.keys(pending.current).length ? 'saving' : 'saved');
      })
      .catch((caught: unknown) => {
        console.error('Saving the application failed', caught);
        setError(caught);
        setStatus('idle');
      });
    running.current = work;
    await work;
    running.current = null;
  }, [api]);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    await send();
    return !Object.keys(pending.current).length;
  }, [send]);

  const change = useCallback(
    (next: Partial<ApplicationDraft>, save: PatchBody = next) => {
      setDraft((current) => ({ ...current, ...next }));
      if (Object.keys(save).length === 0) {
        return;
      }
      pending.current = { ...pending.current, ...save };
      setStatus('saving');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void send();
      }, AUTOSAVE_DELAY_MS);
    },
    [send],
  );

  // Leaving the page still saves the last change.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void send();
      }
    },
    [send],
  );

  return { draft, change, flush, status, error };
}

type Draft = ReturnType<typeof useApplicationDraft>;

/** The four parts of the application and whether each is done, for the progress bar. */
export function applicationParts(profile: ProProfile, draft: ApplicationDraft) {
  return [
    { key: 'trades', done: draft.trades.length > 0 },
    { key: 'documents', done: requiredDocuments(profile).every((kind) => uploaded(profile, kind)) },
    { key: 'background', done: draft.backgroundConsent },
    { key: 'days', done: draft.workingDays.length > 0 },
  ] as const;
}

export function requiredDocuments(profile: ProProfile): UploadKind[] {
  return profile.certificateRequired === false ? ['id', 'insurance'] : ['id', 'certificate', 'insurance'];
}

function uploaded(profile: ProProfile, kind: UploadKind): boolean {
  // A document the API does not list yet counts as not uploaded, the same as null.
  const doc = profile.documents[kind];
  return doc != null && doc.state !== 'rejected' && doc.state !== 'expired';
}

/** The progress bar at the top of the Application page: trades, documents, background check, working days. */
export function ApplicationProgress({ profile, draft }: { profile: ProProfile; draft: ApplicationDraft }) {
  const { t } = useTranslation();
  const parts = applicationParts(profile, draft);
  const done = parts.filter((p) => p.done).length;
  const next = parts.find((p) => !p.done)?.key;
  return (
    <ol className="flow" aria-label={t('apply.progress', { done })}>
      {parts.map((part) => (
        <li key={part.key} className={part.done ? 'on' : ''} aria-current={part.key === next ? 'step' : undefined}>
          <span className="visually-hidden">
            {t(part.done ? 'apply.partDone' : 'apply.partOpen', { part: t(`apply.part.${part.key}`) })}
          </span>
        </li>
      ))}
    </ol>
  );
}

const toggle = <T,>(list: readonly T[], value: T) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

export function TradesSection({ profile, draft }: { profile: ProProfile; draft: Draft }) {
  const { t } = useTranslation();
  const market = useMarket();
  const locked = !profile.editable;
  return (
    <section aria-labelledby="trades-heading" className="stack tight">
      <h2 id="trades-heading" className="h-sm">
        {t('apply.trades')}
      </h2>
      <div className="chips" role="group" aria-labelledby="trades-heading" aria-describedby="trades-hint">
        {market.categories.map((category) => {
          const on = draft.draft.trades.includes(category.id);
          return (
            <button
              key={category.id}
              type="button"
              className={`chip dark ${on ? 'on' : ''}`}
              aria-pressed={on}
              disabled={locked}
              onClick={() => draft.change({ trades: toggle(draft.draft.trades, category.id) })}
            >
              {category.name}
            </button>
          );
        })}
      </div>
      <p id="trades-hint" className="tiny muted">
        {locked ? t('apply.tradesLocked') : t('apply.tradesHint')}
      </p>
    </section>
  );
}

export function AddressSection({ draft }: { draft: Draft }) {
  const { t } = useTranslation();
  const api = useApi();
  const loadPostcodes = useCallback(() => api.get<{ postcodes: Postcode[] }>('/postcodes'), [api]);
  const postcodes = useResource(loadPostcodes);
  const { homeAddress, homePostcode } = draft.draft;
  return (
    <section aria-labelledby="home-heading" className="stack tight">
      <h2 id="home-heading" className="h-sm">
        {t('apply.homeTitle')}
      </h2>
      <p className="small muted">{t('apply.addressHint')}</p>
      <div className="field">
        <label htmlFor="home-address">{t('apply.street')}</label>
        <input
          id="home-address"
          autoComplete="street-address"
          maxLength={200}
          value={homeAddress}
          aria-describedby="home-private"
          onChange={(event) => {
            const value = event.target.value;
            // Too short to be an address: kept on screen, saved once it is one.
            draft.change({ homeAddress: value }, value.trim().length >= 3 ? { homeAddress: value } : {});
          }}
        />
      </div>
      <ResourceState state={postcodes.state} reload={postcodes.reload}>
        {({ postcodes: list }) => (
          <div className="field">
            <label htmlFor="home-postcode">{t('apply.postcode')}</label>
            <select
              id="home-postcode"
              autoComplete="postal-code"
              value={homePostcode}
              onChange={(event) => event.target.value && draft.change({ homePostcode: event.target.value })}
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
      <p id="home-private" className="small row gap4">
        <Icon name="lock" /> {t('apply.addressPrivate')}
      </p>
    </section>
  );
}

export function TravelSection({ draft }: { draft: Draft }) {
  const { t } = useTranslation();
  const km = draft.draft.radiusKm;
  return (
    <section aria-labelledby="travel-heading" className="stack tight">
      <h2 id="travel-heading" className="h-sm">
        {t('apply.travelTitle')}
      </h2>
      <div className="card">
        <div className="row between">
          <label htmlFor="radius" className="small muted">
            {t('apply.fromHome')}
          </label>
          <b aria-hidden="true">{t('apply.radiusValue', { km })}</b>
        </div>
        <input
          id="radius"
          type="range"
          min={MIN_RADIUS_KM}
          max={MAX_RADIUS_KM}
          step={1}
          value={km}
          aria-valuetext={t('apply.radiusValue', { km })}
          aria-describedby="radius-range"
          onChange={(event) => draft.change({ radiusKm: Number(event.target.value) })}
        />
        <p id="radius-range" className="tiny muted">
          {t('apply.radiusRange')}
        </p>
      </div>
    </section>
  );
}

/** One document with its own upload button, and the expiry date for one that runs out. */
export function DocumentItem({
  profile,
  kind,
  onChange,
  optional = false,
  label,
}: {
  profile: ProProfile;
  kind: UploadKind;
  onChange: (p: ProProfile) => void;
  optional?: boolean;
  /** The button text; "Upload" or "Replace" when left out. */
  label?: string;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const market = useMarket();
  const docs = useAction();
  const [date, setDate] = useState('');
  const doc = profile.documents[kind];
  const needsDate = EXPIRING_KINDS.includes(kind);
  const state = doc?.state ?? 'missing';
  const ok = state === 'valid' || state === 'expiring' || state === 'waiting_review';
  const bad = state === 'rejected' || state === 'expired';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: market.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
  const dateId = `expiry-${kind}`;
  // Today still counts as valid; the day is judged in the market's time zone.
  const datePassed = needsDate && date !== '' && date < today;
  const line = (() => {
    switch (state) {
      case 'rejected':
        return t('apply.docState.rejected', { note: doc?.reviewNote ?? '' });
      case 'expired':
      case 'expiring':
        return t(`apply.docState.${state}`, { date: doc?.expiresOn ? longDate(doc.expiresOn, market.timezone) : '' });
      case 'missing':
        return optional ? t('apply.certificateNotNeeded') : t('apply.docState.missing');
      default:
        return t(`apply.docState.${state}`);
    }
  })();

  return (
    <div className={`doc ${ok ? 'ok' : ''} ${bad ? 'bad' : ''}`}>
      <span className="di">
        <Icon name={ok ? 'check' : kind === 'id' ? 'user' : kind === 'insurance' ? 'shield' : 'file'} />
      </span>
      <span className="grow stack tight">
        <span className="b small block">{t(`apply.doc.${kind}`)}</span>
        {doc?.fileName && <span className="tiny">{doc.fileName}</span>}
        <span className={`tiny ${bad ? 'error-text' : 'muted'}`}>{line}</span>
        {needsDate && (
          <span className="field compact">
            <label htmlFor={dateId} className="tiny">
              {t('apply.expiresOn')}
            </label>
            <input
              id={dateId}
              type="date"
              value={date}
              aria-invalid={datePassed || undefined}
              aria-describedby={`${dateId}-hint${datePassed ? ` ${dateId}-passed` : ''}`}
              onChange={(event) => {
                setDate(event.target.value);
                docs.clearError();
              }}
            />
            <span id={`${dateId}-hint`} className="tiny muted">
              {t('apply.expiresOnHint')}
            </span>
            {datePassed && (
              <span id={`${dateId}-passed`} role="alert" className="tiny error-text">
                {t('apply.expiredDate')}
              </span>
            )}
          </span>
        )}
        <ErrorText error={docs.error} />
      </span>
      <FileButton
        label={label ?? (doc ? t('apply.replace') : t('apply.upload'))}
        target={label ? undefined : t(`apply.doc.${kind}`)}
        accept={DOCUMENT_TYPES}
        disabled={!profile.editable && profile.status === 'rejected' ? true : needsDate && (!date || datePassed)}
        onFile={async (file) => {
          const query = needsDate ? `?expiresOn=${encodeURIComponent(date)}` : '';
          const result = await docs.run(() => api.upload<{ profile: ProProfile }>(`/pro/documents/${kind}${query}`, file));
          if (result) {
            onChange(result.profile);
            setDate('');
          }
        }}
      />
    </div>
  );
}

export function DocumentsSection({ profile, onChange }: { profile: ProProfile; onChange: (p: ProProfile) => void }) {
  const { t } = useTranslation();
  const required = requiredDocuments(profile);
  const done = required.filter((kind) => uploaded(profile, kind)).length;
  return (
    <section aria-labelledby="docs-heading">
      <h2 id="docs-heading" className="h-sm">
        {t('apply.documents', { done, total: required.length })}
      </h2>
      {UPLOAD_KINDS.map((kind) => (
        <DocumentItem key={kind} profile={profile} kind={kind} onChange={onChange} optional={!required.includes(kind)} />
      ))}
    </section>
  );
}

export function DaysSection({ draft }: { draft: Draft }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="days-heading" className="stack tight">
      <h2 id="days-heading" className="h-sm">
        {t('apply.days')}
      </h2>
      <div className="wk dark" role="group" aria-labelledby="days-heading">
        {WEEKDAYS.map((day) => {
          const on = draft.draft.workingDays.includes(day);
          return (
            <button
              key={day}
              type="button"
              className={on ? 'on' : ''}
              aria-pressed={on}
              onClick={() => draft.change({ workingDays: toggle(draft.draft.workingDays, day).sort((a, b) => a - b) })}
            >
              {t(`weekday.${day}`)}
            </button>
          );
        })}
      </div>
      <p className="small muted row gap4">
        <Icon name="clock" /> {t('apply.daysHint')}
      </p>
    </section>
  );
}

/** "Saving…" while a change is on its way, then "Saved". */
export function SaveState({ draft }: { draft: Draft }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="tiny muted save-state" role="status">
        {draft.status === 'saving' ? t('apply.saving') : draft.status === 'saved' ? t('apply.saved') : ''}
      </p>
      <ErrorText error={draft.error} />
    </>
  );
}

/**
 * The pro's trades, area, documents and working days on their Profile. Every change is saved by itself.
 * Trades are locked once the team has checked them.
 */
export function ApplicationForm({ profile, onChange }: { profile: ProProfile; onChange: (p: ProProfile) => void }) {
  const { t } = useTranslation();
  const draft = useApplicationDraft(profile, onChange);
  const background = profile.documents.background;
  const id = useId();
  return (
    <div className="stack">
      {profile.status === 'draft' && (
        <Link to="/pro/apply" className="btn btn-primary wide">
          {t('apply.continue')}
        </Link>
      )}
      {(profile.status === 'submitted' || profile.status === 'info_requested' || profile.status === 'rejected') && (
        <Link to="/pro/application" className="btn btn-ghost wide">
          {t('apply.seeStatus')}
        </Link>
      )}
      <TradesSection profile={profile} draft={draft} />
      <AddressSection draft={draft} />
      <TravelSection draft={draft} />
      <DocumentsSection profile={profile} onChange={onChange} />
      <section aria-labelledby={id} className="stack tight">
        <h2 id={id} className="h-sm">
          {t('apply.backgroundTitle')}
        </h2>
        <p className="small muted">
          {t(`apply.backgroundState.${background?.state ?? (profile.backgroundConsentAt ? 'waiting_review' : 'missing')}`)}
        </p>
      </section>
      <DaysSection draft={draft} />
      <SaveState draft={draft} />
    </div>
  );
}
