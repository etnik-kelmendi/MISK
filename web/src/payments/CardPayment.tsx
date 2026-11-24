import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PaymentStep } from '../api/types';
import { Icon } from '../components/Icon';

const stripes = new Map<string, Promise<Stripe | null>>();

/** Loads Stripe.js once per key. Card details go straight to Stripe and never reach MISK's servers. */
export function stripeFor(publishableKey: string): Promise<Stripe | null> {
  let stripe = stripes.get(publishableKey);
  if (!stripe) {
    stripe = loadStripe(publishableKey);
    stripes.set(publishableKey, stripe);
  }
  return stripe;
}

function PaymentForm({
  label,
  setup,
  onConfirmed,
}: {
  label: string;
  /** Only saves the card, for a plan first charged on its first visit day (D91); nothing is paid now. */
  setup: boolean;
  onConfirmed: () => void;
}) {
  const { t } = useTranslation();
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!stripe || !elements) {
      return;
    }
    setBusy(true);
    setMessage(null);
    const params = { elements, redirect: 'if_required' as const, confirmParams: { return_url: window.location.href } };
    const { error } = setup ? await stripe.confirmSetup(params) : await stripe.confirmPayment(params);
    setBusy(false);
    if (error) {
      // Stripe's own message explains card problems ("Your card was declined.") better than a code could.
      setMessage(error.message ?? t('errors.payment_failed'));
      return;
    }
    onConfirmed();
  }

  return (
    <form onSubmit={submit} className="stack">
      <PaymentElement />
      {message && (
        <p className="error-text" role="alert">
          {message}
        </p>
      )}
      <div className="info">
        <Icon name="shield" />
        <p>{t('pay.protected')}</p>
      </div>
      <button className="cta" type="submit" disabled={!stripe || busy}>
        <Icon name="lock" /> {busy ? t('pay.paying') : label}
      </button>
    </form>
  );
}

/**
 * The card form for a payment the API started. Calls `onConfirmed` once Stripe has the card. A 'setup' step (D91)
 * only saves the card; `setupLabel` then says on the button when it is first charged.
 */
export function CardPayment({
  payment,
  amountLabel,
  setupLabel,
  onConfirmed,
}: {
  payment: PaymentStep;
  amountLabel: string;
  setupLabel?: string;
  onConfirmed: () => void;
}) {
  const { t } = useTranslation();
  const setup = payment.confirm === 'setup';
  if (!payment.publishableKey) {
    return (
      <p className="error-text" role="alert">
        {t('errors.payment_unavailable')}
      </p>
    );
  }
  return (
    <Elements stripe={stripeFor(payment.publishableKey)} options={{ clientSecret: payment.clientSecret }}>
      <PaymentForm
        setup={setup}
        label={setup ? (setupLabel ?? t('pay.saveCard')) : t('pay.payNow', { amount: amountLabel })}
        onConfirmed={onConfirmed}
      />
    </Elements>
  );
}

/** Finishes a hold on a saved card when the bank asks the customer to confirm it (3-D Secure). */
export async function confirmSavedCard(payment: PaymentStep): Promise<void> {
  if (!payment.publishableKey) {
    throw new Error('No Stripe key for a payment that needs the customer');
  }
  const stripe = await stripeFor(payment.publishableKey);
  if (!stripe) {
    throw new Error('Stripe.js failed to load');
  }
  const { error } = await stripe.handleNextAction({ clientSecret: payment.clientSecret });
  if (error) {
    throw new Error(error.message ?? 'Card confirmation failed');
  }
}
