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
import { WalletButton, type Wallet } from '../../payments/WalletButton';
import type { When } from './ChooseTimeStep';
import { CATEGORY_COLORS } from './categoryColors';
import { sizeGroup, type Details } from './JobDetailsStep';

type Choice = 'card' | 'new_card' | 'apple_pay' | 'google_pay';

interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

interface PaymentMethods {
  cards: SavedCard[];
  cardsAvailable: boolean;
  last: { choice: Choice; cardId: string | null } | null;
  publishableKey: string | null;
}

/** The option a value of the payment list stands for: a saved card by id, or a kind. */
type Option = { choice: 'card'; cardId: string } | { choice: Exclude<Choice, 'card'> };
const optionKey = (option: Option) => (option.choice === 'card' ? `card:${option.cardId}` : option.choice);

const BRAND: Record<string, { label: string; bg: string }> = {
  visa: { label: 'VISA', bg: '#1A1F71' },
  mastercard: { label: 'MC', bg: '#EB001B' },
  amex: { label: 'AMEX', bg: '#2E77BC' },
};

/** "about 2 h 30 min" for a visit length. */
function lengthText(minutes: number, t: TFunction): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return t('review.minutes', { minutes: rest });
  return rest === 0 ? t('review.hours', { count: hours }) : t('review.hoursMinutes', { hours, minutes: rest });
}

/**
 * The option that starts selected: the way the customer paid last time while it is still possible, else
 * their newest saved card, else a new card (D73).
 */
export function initialOption(methods: PaymentMethods): Option {
  const last = methods.last;
  if (last?.choice === 'card' && last.cardId && methods.cards.some((card) => card.id === last.cardId)) {
    return { choice: 'card', cardId: last.cardId };
  }
  if (last && last.choice !== 'card') return { choice: last.choice };
  const first = methods.cards[0];
  return first ? { choice: 'card', cardId: first.id } : { choice: 'new_card' };
}

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
  const wallet: Wallet | null = option.choice === 'apple_pay' || option.choice === 'google_pay' ? option.choice : null;
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
      paymentMethod: option.choice === 'card' ? { type: 'card', cardId: option.cardId } : { type: option.choice },
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
  const options: { option: Option; title: string; detail: string; badge: { label: string; bg: string } }[] = [
    ...methods.cards.map((card) => ({
      option: { choice: 'card', cardId: card.id } as Option,
      title: t('review.card', { brand: BRAND[card.brand]?.label === 'MC' ? 'Mastercard' : card.brand.charAt(0).toUpperCase() + card.brand.slice(1), last4: card.last4 }),
      detail: t('review.expires', { date: `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}` }),
      badge: BRAND[card.brand] ?? { label: card.brand.toUpperCase().slice(0, 4), bg: '#3A4A43' },
    })),
    { option: { choice: 'apple_pay' }, title: t('review.applePay'), detail: '', badge: { label: 'Pay', bg: '#000' } },
    { option: { choice: 'google_pay' }, title: t('review.googlePay'), detail: '', badge: { label: 'G Pay', bg: '#4285F4' } },
    { option: { choice: 'new_card' }, title: t('review.newCard'), detail: t('review.newCardText'), badge: { label: '+', bg: '#3A4A43' } },
  ];

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

        <fieldset className="stack tight">
          <legend className="h-sm">{t('review.payment')}</legend>
          {!methods.cardsAvailable && <p className="small muted">{t('review.cardsUnavailable')}</p>}
          {options.map(({ option: o, title, detail, badge }) => {
            const k = optionKey(o);
            const chosen = optionKey(option) === k;
            const notHere = (o.choice === 'apple_pay' || o.choice === 'google_pay') && unavailable.includes(o.choice);
            return (
              <label key={k} className={`paym ${chosen ? 'on' : ''}`}>
                <input type="radio" name="payment" className="visually-hidden" checked={chosen} onChange={() => setOption(o)} />
                <span className="logo-b" style={{ background: badge.bg }} aria-hidden="true">
                  {badge.label}
                </span>
                <span className="grow">
                  <span className="b small block">{title}</span>
                  {(detail || notHere) && <span className="tiny muted block">{notHere ? t('review.walletUnavailable') : detail}</span>}
                </span>
                <span className="radio" aria-hidden="true" />
              </label>
            );
          })}
        </fieldset>

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
