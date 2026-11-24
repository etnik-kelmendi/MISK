import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../components/Icon';
import { stripeFor } from './CardPayment';

function SetupForm({ onSaved }: { onSaved: (cardId: string | null) => void }) {
  const { t } = useTranslation();
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setMessage(null);
    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: 'if_required',
      confirmParams: { return_url: window.location.href },
    });
    setBusy(false);
    if (error) {
      // Stripe's own message explains card problems ("Your card was declined.") better than a code could.
      setMessage(error.message ?? t('errors.payment_failed'));
      return;
    }
    const method = setupIntent?.payment_method;
    onSaved(typeof method === 'string' ? method : (method?.id ?? null));
  }

  return (
    <form onSubmit={submit} className="stack">
      <PaymentElement />
      {message && (
        <p className="error-text" role="alert">
          {message}
        </p>
      )}
      <button className="cta" type="submit" disabled={!stripe || busy}>
        <Icon name="lock" /> {busy ? t('cards.saving') : t('cards.saveCard')}
      </button>
    </form>
  );
}

/**
 * The card form for saving a card without paying (D92). The card goes straight to the payment provider; MISK
 * never sees its number. Calls `onSaved` with the new card's id once the provider has it.
 */
export function CardSetup({
  clientSecret,
  publishableKey,
  onSaved,
}: {
  clientSecret: string;
  publishableKey: string;
  onSaved: (cardId: string | null) => void;
}) {
  return (
    <Elements stripe={stripeFor(publishableKey)} options={{ clientSecret }}>
      <SetupForm onSaved={onSaved} />
    </Elements>
  );
}
