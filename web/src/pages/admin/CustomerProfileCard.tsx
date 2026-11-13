import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useMarket } from '../../api/MarketContext';
import type { CustomerProfile } from '../../api/types';
import { dateTime, euro, longDate } from '../../lib/format';

/** Who the customer is and how they have used MISK so far, in the booking and plan visit panels. */
export function CustomerProfileCard({ profile }: { profile: CustomerProfile }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const headingId = useId();
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || t('admin.customer.noName');
  const b = profile.bookings;
  return (
    <section id="customer-profile" className="stack customer-card" aria-labelledby={headingId} tabIndex={-1}>
      <div className="row between gap8 wrap">
        <h3 id={headingId}>{t('admin.customer.title')}</h3>
        {profile.disabled && <span className="badge r">{t('admin.customer.disabled')}</span>}
      </div>
      <dl className="kv">
        <dt>{t('admin.customer.name')}</dt>
        <dd className="b">{name}</dd>
        <dt>{t('admin.customer.phone')}</dt>
        <dd>{profile.phone ? <a href={`tel:${profile.phone}`}>{profile.phone}</a> : '–'}</dd>
        <dt>{t('admin.customer.email')}</dt>
        <dd>
          {profile.email ? <a href={`mailto:${profile.email}`}>{profile.email}</a> : '–'}
          {profile.email && profile.signIn === 'email' && !profile.emailConfirmed && (
            <span className="badge a"> {t('admin.customer.unconfirmed')}</span>
          )}
        </dd>
        <dt>{t('admin.customer.signIn')}</dt>
        <dd>{t(`admin.customer.signInWith.${profile.signIn}`)}</dd>
        <dt>{t('admin.customer.since')}</dt>
        <dd>{longDate(profile.memberSince, timezone)}</dd>
        <dt>{t('admin.customer.bookings')}</dt>
        <dd>
          {t('admin.customer.bookingsLine', { total: b.total, completed: b.completed, upcoming: b.upcoming, cancelled: b.cancelled })}
        </dd>
        <dt>{t('admin.customer.lastBooking')}</dt>
        <dd>{profile.lastBookingAt ? dateTime(profile.lastBookingAt, timezone) : '–'}</dd>
        <dt>{t('admin.customer.spent')}</dt>
        <dd>
          {euro(profile.spentCents)}
          {profile.tipsCents > 0 && <span className="muted"> {t('admin.customer.tips', { amount: euro(profile.tipsCents) })}</span>}
        </dd>
        <dt>{t('admin.customer.plans')}</dt>
        <dd>{profile.activePlans.length ? profile.activePlans.join(', ') : t('admin.customer.noPlans')}</dd>
        <dt>{t('admin.customer.ratings')}</dt>
        <dd>
          {profile.ratingsGiven === 0
            ? t('admin.customer.noRatings')
            : t('admin.customer.ratingsLine', { count: profile.ratingsGiven, average: profile.averageStarsGiven?.toFixed(1) ?? '–' })}
        </dd>
        <dt>{t('admin.customer.problems')}</dt>
        <dd className={profile.problemsReported > 0 ? 'b' : undefined}>{profile.problemsReported}</dd>
        <dt>{t('admin.customer.lateCancels')}</dt>
        <dd className={profile.lateCancellations > 0 ? 'b' : undefined}>{profile.lateCancellations}</dd>
      </dl>
    </section>
  );
}
