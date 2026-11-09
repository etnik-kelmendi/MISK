/**
 * Everything MISK asks of its payment provider. Production uses Stripe (`stripe-gateway.ts`);
 * automated tests inject a fake from `test/`. Amounts are euro cents.
 */
export interface HoldResult {
  intentId: string;
  /** Secret the customer's browser needs to finish the payment; null when no customer step is needed. */
  clientSecret: string | null;
  /** True when the money is already held and no webhook needs to be awaited. */
  held: boolean;
}

export type GatewayEvent =
  | { kind: 'hold_confirmed'; intentId: string }
  | { kind: 'payment_failed'; intentId: string }
  /** A monthly plan invoice was paid; `periodEnd` is when the paid month ends. */
  | { kind: 'invoice_paid'; subscriptionId: string; invoiceId: string; amountCents: number; periodEnd: Date }
  | { kind: 'invoice_failed'; subscriptionId: string }
  | { kind: 'ignored' };

export interface SubscriptionStart {
  subscriptionId: string;
  /** Secret the customer's browser needs to pay the first month; null when nothing is left to do. */
  clientSecret: string | null;
  /** True when the first month is already paid. */
  active: boolean;
}

export interface PaymentGateway {
  /** Key the browser uses to show the card form; null when the gateway needs no browser step. */
  readonly publishableKey: string | null;
  /** Returns the provider's customer id for a MISK user, creating it when `existing` is null. */
  ensureCustomer(input: { userId: string; existing: string | null }): Promise<string>;
  /** Authorises the amount without taking it, and saves the card for approved extra work. */
  createHold(input: HoldInput): Promise<HoldResult>;
  /** Authorises another amount on the card used for `fromIntentId`, e.g. approved extra work. */
  holdOnSavedCard(input: HoldInput & { fromIntentId: string }): Promise<HoldResult>;
  /** The browser secret of an unfinished payment, so the customer can finish it after a reload. */
  clientSecretFor(intentId: string): Promise<string | null>;
  /** Takes held money. Returns the charge id that a transfer to the pro can be paid from. */
  capture(intentId: string): Promise<{ chargeId: string }>;
  /** Releases held money that was never taken. */
  release(intentId: string): Promise<void>;
  /** Gives captured money back in full. */
  refund(intentId: string): Promise<void>;
  /** Takes a payout back from the pro's account, e.g. after a refund. */
  reverseTransfer(transferId: string): Promise<void>;
  transfer(input: {
    accountId: string;
    amountCents: number;
    /** The charge the money came from; without one it is paid from the available balance. */
    sourceChargeId?: string;
    transferGroup: string;
    idempotencyKey: string;
  }): Promise<{ transferId: string }>;
  createConnectedAccount(input: { userId: string; idempotencyKey: string }): Promise<string>;
  /** The provider's product a plan is billed under, created once per plan. */
  ensureProduct(input: { planId: string; name: string; existing: string | null }): Promise<string>;
  /** Starts monthly billing; the first month is paid by the customer in the browser. */
  createSubscription(input: {
    customerRef: string;
    productId: string;
    amountCents: number;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<SubscriptionStart>;
  /** The browser secret of an unpaid first month, so the customer can finish paying after a reload. */
  subscriptionClientSecret(subscriptionId: string): Promise<string | null>;
  /** Stops billing, either now or once the paid month ends. */
  cancelSubscription(subscriptionId: string, atPeriodEnd: boolean): Promise<void>;
  /** Pauses or resumes monthly charges, e.g. for a seasonal plan in winter. */
  setBillingPaused(subscriptionId: string, paused: boolean): Promise<void>;
  onboardingLink(input: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<string>;
  accountStatus(accountId: string): Promise<{ payoutsEnabled: boolean }>;
  /** The pro's bank account (last 4 digits only) and their next payout, as their Stripe account shows it. */
  payoutDetails(accountId: string): Promise<PayoutDetails>;
  /** Verifies a webhook's signature and reads it. Throws when the signature is wrong. */
  parseWebhook(rawBody: Buffer, signature: string): { eventId: string; event: GatewayEvent };
}

export interface HoldInput {
  customerRef: string;
  amountCents: number;
  description: string;
  idempotencyKey: string;
  metadata: Record<string, string>;
}

export interface PayoutDetails {
  bankLast4: string | null;
  nextPayout: { amountCents: number; arrivesOn: Date } | null;
}
