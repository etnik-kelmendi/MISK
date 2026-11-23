import type { TFunction } from 'i18next';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { Category, CustomerBooking, HomePro, PaymentStep, Service } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { dateTime, dayName, euro, packagePrice, PACKAGE_DISCOUNT_PCT } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { CardPayment, confirmSavedCard } from '../../payments/CardPayment';
import {
  initialOption,
  paymentMethodBody,
  PaymentOptionList,
  walletOf,
  type PaymentMethods,
  type PaymentOption as Option,
} from '../../payments/PaymentOptions';
import { WalletButton, type Wallet } from '../../payments/WalletButton';
import type { When } from './ChooseTimeStep';
import { CATEGORY_COLORS } from './categoryColors';
import { sizeGroup, type Details } from './JobDetailsStep';


/** "about 2 h 30 min" for a visit length. */
function lengthText(minutes: number, t: TFunction): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return t('review.minutes', { minutes: rest });
  return rest === 0 ? t('review.hours', { count: hours }) : t('review.hoursMinutes', { hours, minutes: rest });
}

export { initialOption };

function PayForm({
  methods,
  category,
  services,
  details,
  when,
  picked = null,
}: {
  methods: PaymentMethods;
  category: Category;
  services: Service[];
  details: Details;
  when: When;
  /** The pro picked on Home, who gets the job first (D89). */
  picked?: HomePro | null;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const { feeCents, timezone } = useMarket();
  // The booking a wallet payment made, so it opens once the wallet has confirmed.
  const walletBooking = useRef<string | null>(null);
  const [option, setOption] = useState<Option>(() => initialOption(methods));
  const [unavailable, setUnavailable] = useState<Wallet[]>([]);
  const [cardStep, setCardStep] = useState<{ booking: CustomerBooking; payment: PaymentStep } | null>(null);
  const { run, busy, error } = useAction();
  const price = packagePrice(services, details.size);
  const total = price.jobCents + feeCents;
  const key = methods.publishableKey;
  const wallet: Wallet | null = walletOf(option);
  const open = (id: string) => navigate(`/bookings/${id}`, { replace: true });

  /** Makes the booking with the chosen way to pay, then sends the photos. */
  async function createBooking(): Promise<{ booking: CustomerBooking; payment: PaymentStep | null }> {
    const result = await api.post<{ booking: CustomerBooking; payment: PaymentStep | null }>('/bookings', {
      serviceIds: services.map((service) => service.id),
      size: details.size,
      address: details.address,
      postcode: details.postcode,
      notes: details.notes,
      ...(when.kind === 'slot' ? { startsAt: when.slot.startsAt } : { flexibleWindow: when.window, day: when.day }),
      paymentMethod: paymentMethodBody(option),
      ...(picked ? { preferredProId: picked.id } : {}),
    });
    // The booking is made; its photos follow. One that fails can be added again on the booking page.
    for (const photo of details.photos) {
      try {
        await api.upload(`/bookings/${result.booking.id}/photos`, photo);
      } catch (caught) {
        console.warn('A booking photo could not be sent', caught);
      }
    }
    return result;
  }

  async function book() {
    const result = await run(async () => {
      const created = await createBooking();
      if (created.payment && option.choice === 'card') {
        // The bank wants the customer to confirm the saved card (3-D Secure). If that fails, the booking page
        // shows how to finish paying.
        try {
          await confirmSavedCard(created.payment);
        } catch (caught) {
          console.warn('Saved card confirmation did not finish', caught);
        }
        return { ...created, payment: null };
      }
      return created;
    });
    if (!result) return;
    if (result.payment) setCardStep({ booking: result.booking, payment: result.payment });
    else open(result.booking.id);
  }

  const color = CATEGORY_COLORS[category.icon];
  const group = sizeGroup(category);
  const hourlyOnly = services.every((service) => service.pricing === 'hourly');
  const names = services.map((service) => service.name).join(' + ');

  if (cardStep) {
    return (
      <div className="body">
        <section aria-label={t('pay.title')}>
          <h2 className="h-sm">{t('pay.title')}</h2>
          <CardPayment payment={cardStep.payment} amountLabel={euro(cardStep.booking.totalCents)} onConfirmed={() => open(cardStep.booking.id)} />
        </section>
      </div>
    );
  }

  return (
    <>
      <div className="body">
        <section className="card" aria-label={t('book.summary')}>
          <div className="row">
            <span className="ci review-ci" style={{ background: color.bg, color: color.fg }} aria-hidden="true">
              <Icon name={category.icon} />
            </span>
            <div className="grow">
              <p className="b">{names}</p>
              <p className="small muted">
                {hourlyOnly ? t('review.hourly') : t(`details.sizeName.${group}.${details.size}`)} · {lengthText(price.durationMinutes, t)}
              </p>
            </div>
          </div>
          <div className="review-rule" />
          <p className="row small">
            <Icon name="calendar" />{' '}
            {when.kind === 'slot'
              ? dateTime(when.slot.startsAt, timezone)
              : t('time.flexibleSummary', { day: dayName(when.anyIso, timezone), window: t(`time.window.${when.window}`).toLowerCase() })}
          </p>
          <p className="row small">
            <Icon name="pin" /> {details.address}, {details.postcode}
          </p>
          {picked && (
            <p className="row small">
              <Icon name="heart" /> {t('picked.summary', { name: picked.firstName ?? t('home.yourPro') })}
            </p>
          )}
          <p className="row small">
            <Icon name="camera" />{' '}
            {details.photos.length > 0 ? t('details.photosAttached', { count: details.photos.length }) : t('review.noPhotos')}
          </p>
        </section>

        <section className="card" aria-label={t('book.price')}>
          <p className="line">
            <span>{names}</span>
            <span>{euro(price.jobCents)}</span>
          </p>
          <p className="line">
            <span className="muted">{t('book.fee')}</span>
            <span>{euro(feeCents)}</span>
          </p>
          <p className="line total">
            <span>{t('book.total')}</span>
            <span>{euro(total)}</span>
          </p>
          {price.discountCents > 0 && (
            <p className="tiny muted row gap4">
              <Icon name="tag" /> {t('review.packageIncluded', { pct: PACKAGE_DISCOUNT_PCT })}
            </p>
          )}
        </section>

        <PaymentOptionList methods={methods} option={option} onChange={setOption} unavailable={unavailable} legend={t('review.payment')} />

        <p className="info">
          <Icon name="shield" />
          <span>
            <b>{t('review.protectedTitle')}</b> {t('review.protectedText')}
          </span>
        </p>
        <p className="info amber">
          <Icon name="clock" />
          <span>
            <b>{t('review.cancelTitle')}</b> {t('review.cancelText')}
          </span>
        </p>
        <ErrorText error={error} />
      </div>
      <div className="cta-bar">
        {wallet && key ? (
          unavailable.includes(wallet) ? (
            <button className="cta" type="button" disabled>
              {t('review.walletUnavailable')}
            </button>
          ) : (
            <WalletButton
              key={wallet}
              publishableKey={key}
              wallet={wallet}
              amountCents={total}
              onApproved={async () => {
                const created = await createBooking();
                walletBooking.current = created.booking.id;
                return created.payment?.clientSecret ?? null;
              }}
              onDone={() => {
                if (walletBooking.current) open(walletBooking.current);
              }}
              onUnavailable={() => setUnavailable((current) => (current.includes(wallet) ? current : [...current, wallet]))}
            />
          )
        ) : (
          <button className="cta" type="button" disabled={busy} onClick={() => void book()}>
            <Icon name="lock" /> {busy ? t('book.booking') : t('review.bookAndPay', { amount: euro(total) })}
          </button>
        )}
      </div>
    </>
  );
}

/** Review & pay (D73): what was chosen, the price from the control panel's fee, and how to pay. */
export function ReviewPayStep(props: { category: Category; services: Service[]; details: Details; when: When; picked?: HomePro | null }) {
  const api = useApi();
  const load = useCallback(() => api.get<PaymentMethods>('/payment-methods'), [api]);
  const { state, reload } = useResource(load);
  return (
    <ResourceState state={state} reload={reload}>
      {(methods) => <PayForm methods={methods} {...props} />}
    </ResourceState>
  );
}
