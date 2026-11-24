import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../../api/ApiContext';
import { ApiError } from '../../../api/client';
import { useMarket } from '../../../api/MarketContext';
import { useResource } from '../../../api/useResource';
import { ErrorText } from '../../../components/ErrorText';
import { FieldError } from '../../../components/FieldError';
import { Icon } from '../../../components/Icon';
import { ResourceState } from '../../../components/ResourceState';
import { Sheet } from '../../../components/Sheet';
import { dateTime, longDate } from '../../../lib/format';
import { useAction } from '../../../lib/useAction';
import { useValidation } from '../../../lib/useValidation';
import { useAccountSettings } from './PersonalPage';

/** What an account without a password types to confirm; the API checks the same word. */
export const DELETE_WORD = 'DELETE';

/** Something that has to end before the account can be deleted (D97). */
export interface DeleteBlocker {
  kind: 'plan' | 'booking_in_progress' | 'booking_soon' | 'problem_open' | 'money_held' | 'payment_due';
  id: string;
  name: string;
  /** When the plan ends or the booking starts; null for a plan that is not cancelled yet. */
  at: string | null;
}

/** What `GET /account/deletion` answers. */
export interface DeletionCheck {
  pro: boolean;
  allowed: boolean;
  confirmWith: 'password' | 'typed';
  blockers: DeleteBlocker[];
  upcomingBookings: number;
}

/** One reason the account cannot be deleted yet, linking to where it can be dealt with. */
function BlockerLine({ blocker }: { blocker: DeleteBlocker }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const isPlan = blocker.kind === 'plan';
  const text = isPlan
    ? blocker.at
      ? t('deleteAccount.blockers.planEnding', { name: blocker.name, date: longDate(blocker.at, timezone) })
      : t('deleteAccount.blockers.plan', { name: blocker.name })
    : t(`deleteAccount.blockers.${blocker.kind}`, { name: blocker.name, date: blocker.at ? dateTime(blocker.at, timezone) : '' });
  return (
    <li className="row gap8 blocker-line">
      <Icon name="alert" />
      <span className="grow">
        {text}{' '}
        <Link to={isPlan ? `/my-plans/${encodeURIComponent(blocker.id)}` : `/bookings/${encodeURIComponent(blocker.id)}`}>
          {isPlan ? t('deleteAccount.openPlan') : t('deleteAccount.openBooking')}
        </Link>
      </span>
    </li>
  );
}

/**
 * "Delete account" (D97, design sheet "Delete account"): what happens, then the password (or DELETE typed by an
 * account without one). While a plan runs, a booking is under way or close, a problem report is open or money is
 * held, it lists those instead. A pro who also books is sent to support.
 */
export function DeleteAccountSheet({ onClose, onDeleted }: { onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<DeletionCheck>('/account/deletion'), [api]);
  const check = useResource(load);
  const settings = useAccountSettings();
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const { run, busy, error } = useAction();
  const data = check.state.status === 'ready' ? check.state.data : null;
  const byPassword = data?.confirmWith === 'password';
  const form = useValidation(
    {
      password: byPassword && !password && t('errors.password_required'),
      typed: !byPassword && typed.trim() !== DELETE_WORD && t('errors.delete_not_confirmed'),
    },
    { password: 'delete-password', typed: 'delete-typed' },
  );
  // Something opened since the sheet loaded: the API's answer lists it.
  const lateBlockers =
    error instanceof ApiError && error.code === 'account_has_open_items' ? ((error.body?.blockers as DeleteBlocker[] | undefined) ?? null) : null;
  const blockers = lateBlockers ?? data?.blockers ?? [];
  const canDelete = Boolean(data?.allowed) && !lateBlockers;
  const support = settings.state.status === 'ready' ? settings.state.data.support : null;
  const supportWays = [support?.email, support?.phone].filter(Boolean).join(t('deleteAccount.or'));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canDelete || !form.check()) return;
    const result = await run(() =>
      api.post<{ deleted: true }>('/account/delete', byPassword ? { password } : { confirmText: typed.trim() }),
    );
    if (result) onDeleted();
  }

  return (
    <Sheet
      title={t('deleteAccount.title')}
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cta ghost" onClick={onClose}>
            {t('deleteAccount.keep')}
          </button>
          {canDelete && (
            <button type="submit" form="delete-account-form" className="cta red" disabled={busy}>
              {t('deleteAccount.confirm')}
            </button>
          )}
        </>
      }
    >
      <ResourceState state={check.state} reload={check.reload}>
        {(loaded) =>
          loaded.pro ? (
            <div className="stack">
              <p className="info amber">
                <Icon name="shield" />
                <span>{t('deleteAccount.pro')}</span>
              </p>
              <p className="small">{supportWays ? t('deleteAccount.proContact', { ways: supportWays }) : t('deleteAccount.proContactHelp')}</p>
              <Link to="/profile/help" className="small">
                {t('profile.help')}
              </Link>
            </div>
          ) : (
            <form id="delete-account-form" className="stack" onSubmit={submit} noValidate aria-describedby="delete-account-warning">
              <div id="delete-account-warning" className="info red">
                <Icon name="alert" />
                <div>
                  <b>{t('deleteAccount.cannotUndo')}</b> {t('deleteAccount.whatGoes')}
                </div>
              </div>
              {blockers.length > 0 ? (
                <section className="stack" aria-labelledby="delete-blockers-title">
                  <h3 id="delete-blockers-title" className="h-sm">
                    {t('deleteAccount.blockedTitle')}
                  </h3>
                  <ul className="stack small blocker-list">
                    {blockers.map((blocker) => (
                      <BlockerLine key={`${blocker.kind}-${blocker.id}`} blocker={blocker} />
                    ))}
                  </ul>
                </section>
              ) : (
                <>
                  <ul className="stack small blocker-list" aria-label={t('deleteAccount.whatHappens')}>
                    <li className="row gap8">
                      <Icon name="check" /> <span>{t('deleteAccount.noPlans')}</span>
                    </li>
                    <li className="row gap8">
                      <Icon name="check" />{' '}
                      <span>
                        {loaded.upcomingBookings > 0
                          ? t('deleteAccount.upcoming', { count: loaded.upcomingBookings })
                          : t('deleteAccount.noUpcoming')}
                      </span>
                    </li>
                    <li className="row gap8">
                      <Icon name="check" /> <span>{t('deleteAccount.signUpAgain')}</span>
                    </li>
                  </ul>
                  {loaded.confirmWith === 'password' ? (
                    <div className="field">
                      <label htmlFor="delete-password">{t('deleteAccount.passwordLabel')}</label>
                      <input
                        id="delete-password"
                        type="password"
                        autoComplete="current-password"
                        maxLength={1024}
                        required
                        value={password}
                        {...form.describe('password')}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                      <FieldError id="delete-password" message={form.message('password')} />
                    </div>
                  ) : (
                    <div className="field">
                      <label htmlFor="delete-typed">{t('deleteAccount.typedLabel', { word: DELETE_WORD })}</label>
                      <input
                        id="delete-typed"
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        maxLength={20}
                        required
                        value={typed}
                        {...form.describe('typed')}
                        onChange={(event) => setTyped(event.target.value)}
                      />
                      <FieldError id="delete-typed" message={form.message('typed')} />
                    </div>
                  )}
                </>
              )}
              {!lateBlockers && <ErrorText error={error} />}
            </form>
          )
        }
      </ResourceState>
    </Sheet>
  );
}
