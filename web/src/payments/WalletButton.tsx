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
}

function Button({ wallet, onApproved, onDone, onUnavailable }: Omit<Props, 'publishableKey' | 'amountCents'>) {
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
        // Reserves the money: the payment was made with manual capture, so nothing is taken yet.
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
 * The Apple Pay or Google Pay button for Review & pay (D73). The amount is reserved on the card the
 * customer picks in their wallet, and only taken 24 hours after the job.
 */
export function WalletButton({ publishableKey, amountCents, ...rest }: Props) {
  return (
    <Elements
      stripe={stripeFor(publishableKey)}
      options={{ mode: 'payment', amount: amountCents, currency: 'eur', captureMethod: 'manual', setupFutureUsage: 'on_session' }}
    >
      <Button {...rest} />
    </Elements>
  );
}
