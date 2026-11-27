import { useTranslation } from 'react-i18next';
import type { Wallet } from './WalletButton';

/** The ways to pay (D73): a saved card, Apple Pay, Google Pay or another card. */
export type PaymentChoice = 'card' | 'new_card' | 'apple_pay' | 'google_pay';

export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** What `GET /payment-methods` answers: the customer's saved cards and how they paid last time. */
export interface PaymentMethods {
  cards: SavedCard[];
  cardsAvailable: boolean;
  last: { choice: PaymentChoice; cardId: string | null } | null;
  publishableKey: string | null;
}

/** The option a value of the payment list stands for: a saved card by id, or a kind. */
export type PaymentOption = { choice: 'card'; cardId: string } | { choice: Exclude<PaymentChoice, 'card'> };
export const optionKey = (option: PaymentOption) => (option.choice === 'card' ? `card:${option.cardId}` : option.choice);

/** The wallet an option stands for, or null for cards. */
export const walletOf = (option: PaymentOption): Wallet | null =>
  option.choice === 'apple_pay' || option.choice === 'google_pay' ? option.choice : null;

/** What the API takes as `paymentMethod` for an option. */
export const paymentMethodBody = (option: PaymentOption) =>
  option.choice === 'card' ? { type: 'card' as const, cardId: option.cardId } : { type: option.choice };

const BRAND: Record<string, { label: string; bg: string }> = {
  visa: { label: 'VISA', bg: '#1A1F71' },
  mastercard: { label: 'MC', bg: '#EB001B' },
  amex: { label: 'AMEX', bg: '#2E77BC' },
};

/** The small coloured logo of a card brand, e.g. "VISA" on blue. */
export function brandBadge(brand: string): { label: string; bg: string } {
  return BRAND[brand] ?? { label: brand.toUpperCase().slice(0, 4), bg: '#3A4A43' };
}

/** "Visa", "Mastercard" for a card brand as the payment provider names it. */
export function brandName(brand: string): string {
  return BRAND[brand]?.label === 'MC' ? 'Mastercard' : brand.charAt(0).toUpperCase() + brand.slice(1);
}

/**
 * The option that starts selected: the way the customer paid last time while it is still possible, else
 * their newest saved card, else a new card (D73).
 */
export function initialOption(methods: PaymentMethods): PaymentOption {
  const last = methods.last;
  if (last?.choice === 'card' && last.cardId && methods.cards.some((card) => card.id === last.cardId)) {
    return { choice: 'card', cardId: last.cardId };
  }
  if (last && last.choice !== 'card') return { choice: last.choice };
  const first = methods.cards[0];
  return first ? { choice: 'card', cardId: first.id } : { choice: 'new_card' };
}

/** The list of ways to pay as radio buttons, used by Review & pay (D73) and the Plan builder (D90). */
export function PaymentOptionList({
  methods,
  option,
  onChange,
  unavailable,
  legend,
}: {
  methods: PaymentMethods;
  option: PaymentOption;
  onChange: (option: PaymentOption) => void;
  /** Wallets this device cannot use. */
  unavailable: Wallet[];
  legend: string;
}) {
  const { t } = useTranslation();
  const options: { option: PaymentOption; title: string; detail: string; badge: { label: string; bg: string } }[] = [
    ...methods.cards.map((card) => ({
      option: { choice: 'card', cardId: card.id } as PaymentOption,
      title: t('review.card', { brand: brandName(card.brand), last4: card.last4 }),
      detail: t('review.expires', { date: `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}` }),
      badge: BRAND[card.brand] ?? { label: card.brand.toUpperCase().slice(0, 4), bg: '#3A4A43' },
    })),
    { option: { choice: 'apple_pay' }, title: t('review.applePay'), detail: '', badge: { label: 'Pay', bg: '#000' } },
    { option: { choice: 'google_pay' }, title: t('review.googlePay'), detail: '', badge: { label: 'G Pay', bg: '#1967D2' } },
    { option: { choice: 'new_card' }, title: t('review.newCard'), detail: t('review.newCardText'), badge: { label: '+', bg: '#3A4A43' } },
  ];
  return (
    <fieldset className="stack tight">
      <legend className="h-sm">{legend}</legend>
      {!methods.cardsAvailable && <p className="small muted">{t('review.cardsUnavailable')}</p>}
      {options.map(({ option: o, title, detail, badge }) => {
        const k = optionKey(o);
        const chosen = optionKey(option) === k;
        const wallet = walletOf(o);
        const notHere = wallet !== null && unavailable.includes(wallet);
        return (
          <label key={k} className={`paym ${chosen ? 'on' : ''}`}>
            <input type="radio" name="payment" className="visually-hidden" checked={chosen} onChange={() => onChange(o)} />
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
  );
}
