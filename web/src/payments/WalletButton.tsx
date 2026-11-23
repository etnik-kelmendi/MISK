import { Elements, ExpressCheckoutElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { stripeFor } from './CardPayment';

export type Wallet = 'apple_pay' | 'google_pay';

interface Props {
  publishableKey: string;
  wallet: Wallet;
  amountCents: number;
  /** Makes the booking once the customer has approved the payment in the wallet; returns the payment secret. */
  onApproved: () => Promise<string | null>;
  onDone: () => void;
  /** The wallet cannot be used in this browser or on this device. */
  onUnavailable: () => void;
  /**
   * 'hold' reserves the amount for a booking, taken 24 hours after the job (D73); 'subscription' pays a monthly
   * plan's first month at once and keeps the card for the next months (D90).
   */
  purpose?: 'hold' | 'subscription';
}

function Button({ wallet, onApproved, onDone, onUnavailable }: Omit<Props, 'publishableKey' | 'amountCents' | 'purpose'>) {
  const { t } = useTranslation();
  const stripe = useStripe();
  const elements = useElements();
  const [message, setMessage] = useState<string | null>(null);

  async function confirm() {
    if (!stripe || !elements) return;
    setMessage(null);
    const submitted = await elements.submit();
    if (submitted.error) {
      setMessage(submitted.error.message ?? t('errors.payment_failed'));
      return;
    }
    try {
      const clientSecret = await onApproved();
      if (clientSecret) {
        // A booking's payment only reserves the money (manual capture); a plan's first month is paid at once.
        const { error } = await stripe.confirmPayment({
          elements,
          clientSecret,
          redirect: 'if_required',
          confirmParams: { return_url: window.location.href },
        });
        if (error) {
          setMessage(error.message ?? t('errors.payment_failed'));
          return;
        }
      }
      onDone();
    } catch (caught) {
      setMessage(caught instanceof Error && caught.message ? caught.message : t('errors.payment_failed'));
    }
  }

  return (
    <>
      <ExpressCheckoutElement
        options={{
          buttonHeight: 52,
          paymentMethods: {
            applePay: wallet === 'apple_pay' ? 'always' : 'never',
            googlePay: wallet === 'google_pay' ? 'always' : 'never',
            link: 'never',
            paypal: 'never',
            amazonPay: 'never',
            klarna: 'never',
          },
        }}
        onReady={(event) => {
          const available = event.availablePaymentMethods;
          if (!available || !(wallet === 'apple_pay' ? available.applePay : available.googlePay)) onUnavailable();
        }}
        onConfirm={() => void confirm()}
      />
      {message && (
        <p className="error-text" role="alert">
          {message}
        </p>
      )}
    </>
  );
}

/**
 * The Apple Pay or Google Pay button for Review & pay (D73) and the Plan builder (D90). For a booking the amount
 * is reserved on the card the customer picks in their wallet, and only taken 24 hours after the job; for a plan
 * the first month is paid and the card is kept for the monthly charges.
 */
export function WalletButton({ publishableKey, amountCents, purpose = 'hold', ...rest }: Props) {
  return (
    <Elements
      stripe={stripeFor(publishableKey)}
      options={
        purpose === 'subscription'
          ? { mode: 'subscription', amount: amountCents, currency: 'eur' }
          : { mode: 'payment', amount: amountCents, currency: 'eur', captureMethod: 'manual', setupFutureUsage: 'on_session' }
      }
    >
      <Button {...rest} />
    </Elements>
  );
}
