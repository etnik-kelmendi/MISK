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
  /** A plan billed from its first visit day has the customer's card set up (D91): nothing is charged yet. */
  | { kind: 'subscription_ready'; subscriptionId: string }
  | { kind: 'ignored' };

/**
 * What the customer's browser does with a plan's secret (D91): 'payment' pays the first month now; 'setup' only
 * saves the card, which is first charged on the first visit day.
 */
export type SubscriptionConfirm = 'payment' | 'setup';

export interface SubscriptionStart {
  subscriptionId: string;
  /** Secret the customer's browser needs to pay the first month or set up the card; null when nothing is left to do. */
  clientSecret: string | null;
  confirm: SubscriptionConfirm;
  /** True when nothing is left for the customer: the first month is paid, or the card is set up for a later first charge. */
  active: boolean;
  /** True when the first month is already paid (billing started at once). */
  paid: boolean;
  /** The provider's first invoice, so the immediate payment and its paid-invoice webhook are recorded once. */
  invoiceId: string | null;
}

export interface PaymentGateway {
  /** Key the browser uses to show the card form; null when the gateway needs no browser step. */
  readonly publishableKey: string | null;
  /** Returns the provider's customer id for a MISK user, creating it when `existing` is null. */
  ensureCustomer(input: { userId: string; existing: string | null }): Promise<string>;
  /** Authorises the amount without taking it, and saves the card for approved extra work. */
  createHold(input: HoldInput): Promise<HoldResult>;
  /** The cards a customer saved, newest first; wallet cards (Apple Pay, Google Pay) are left out. */
  listCards(customerRef: string): Promise<SavedCard[]>;
  /**
   * Starts adding a card on Payment methods (D92): the browser sends the card straight to the provider with the
   * returned secret, and the card is saved for later payments without charging anything.
   */
  createCardSetup(input: { customerRef: string; idempotencyKey: string }): Promise<{ clientSecret: string }>;
  /** The customer's default card for future payments and plan bills, or null when none is set (D92). */
  defaultCardId(customerRef: string): Promise<string | null>;
  /** Makes one of the customer's saved cards their default for future payments and plan bills (D92). */
  setDefaultCard(customerRef: string, cardId: string): Promise<void>;
  /** Removes a saved card from the customer (D92). Throws when the card is not theirs. */
  detachCard(customerRef: string, cardId: string): Promise<void>;
  /**
   * The id of the card a plan is billed to while the plan is still billing (D92); null when it has no card of
   * its own (its bills then go to the customer's default card) or no longer bills.
   */
  subscriptionCardId(subscriptionId: string): Promise<string | null>;
  /** Bills a plan to another of the customer's saved cards from its next bill on (D92). */
  setSubscriptionCard(subscriptionId: string, cardId: string): Promise<void>;
  /** Authorises another amount on the card used for `fromIntentId`, e.g. approved extra work. */
  holdOnSavedCard(input: HoldInput & { fromIntentId: string }): Promise<HoldResult>;
  /**
   * Reserves the same amount again on the card of `fromIntentId` while the customer is away, before the
   * first reservation runs out (D74). Throws when the bank refuses or wants the customer to confirm.
   */
  renewHold(input: HoldInput & { fromIntentId: string }): Promise<HoldResult>;
  /** The browser secret of an unfinished payment, so the customer can finish it after a reload. */
  clientSecretFor(intentId: string): Promise<string | null>;
  /**
   * How a payment was made, for the receipt (D83): the card brand and last four digits, and the wallet
   * (Apple Pay, Google Pay) when a wallet was used. Null when the payment has no payment method yet.
   */
  paymentMethodOf(intentId: string): Promise<PaymentMethodInfo | null>;
  /**
   * Takes held money. Returns the charge id that a transfer to the pro can be paid from. With `amountCents` only
   * that part is taken and the rest of the hold is released, e.g. a call-out fee (D94).
   */
  capture(intentId: string, amountCents?: number): Promise<{ chargeId: string }>;
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
  /**
   * Starts monthly billing. With `firstChargeAt` (D91) nothing is charged until then: the card is only set up now,
   * the first full month is charged at that moment and every month on that date after. Without it the first month
   * is charged at once.
   */
  createSubscription(input: {
    customerRef: string;
    productId: string;
    amountCents: number;
    idempotencyKey: string;
    metadata: Record<string, string>;
    /** A card the customer saved before (D90): it becomes the plan's card, charged at once or on `firstChargeAt`. */
    paymentMethodId?: string;
    firstChargeAt?: Date;
  }): Promise<SubscriptionStart>;
  /**
   * The browser secret of a plan still waiting for the customer: its unpaid first month, or its card set-up for a
   * later first charge (D91), so the customer can finish after a reload. Null when nothing is waiting.
   */
  subscriptionClientSecret(subscriptionId: string): Promise<{ clientSecret: string; confirm: SubscriptionConfirm } | null>;
  /** True when a plan billed from a later day has its card set up, so it can start (D91). */
  subscriptionCardReady(subscriptionId: string): Promise<boolean>;
  /** Stops billing, either now or once the paid month ends. */
  cancelSubscription(subscriptionId: string, atPeriodEnd: boolean): Promise<void>;
  /**
   * Stops billing at a given moment, e.g. after the customer's 30 days' notice (D77). The last part-month
   * up to that moment is charged pro rata.
   */
  cancelSubscriptionAt(subscriptionId: string, at: Date): Promise<void>;
  /** Takes back a planned end (cancelSubscriptionAt), so billing simply goes on: "Keep my plan" (D90). */
  resumeSubscription(subscriptionId: string): Promise<void>;
  /** The card or wallet a plan is billed to, for My plan (D90); null when it has none yet. */
  subscriptionPaymentMethod(subscriptionId: string): Promise<PaymentMethodInfo | null>;
  /** Pauses or resumes monthly charges, e.g. for a seasonal plan in winter. */
  setBillingPaused(subscriptionId: string, paused: boolean): Promise<void>;
  /**
   * Credits the customer's balance, which comes off their next monthly bill, e.g. for plan visits called off
   * by a pause (D78). Returns the provider's balance transaction id.
   */
  creditCustomer(input: BalanceInput): Promise<{ transactionId: string }>;
  /** Takes back (part of) such a credit: the amount is added to the customer's next bill. */
  reverseCustomerCredit(input: BalanceInput): Promise<{ transactionId: string }>;
  onboardingLink(input: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<string>;
  accountStatus(accountId: string): Promise<{ payoutsEnabled: boolean }>;
  /** The pro's bank account (last 4 digits only) and their next payout, as their Stripe account shows it. */
  payoutDetails(accountId: string): Promise<PayoutDetails>;
  /**
   * How often Stripe pays the pro's balance to their bank: weekly (Fridays) or monthly (the 1st).
   * 'manual' means MISK starts each payout itself, for every two weeks.
   */
  setPayoutSchedule(accountId: string, schedule: 'weekly' | 'monthly' | 'manual'): Promise<void>;
  /** Pays the pro's available balance to their bank now; returns the amount, 0 when there is nothing. */
  payOutBalance(accountId: string, idempotencyKey: string): Promise<number>;
  /** Verifies a webhook's signature and reads it. Throws when the signature is wrong. */
  parseWebhook(rawBody: Buffer, signature: string): { eventId: string; event: GatewayEvent };
}

export interface HoldInput {
  customerRef: string;
  amountCents: number;
  description: string;
  idempotencyKey: string;
  metadata: Record<string, string>;
  /** A card the customer saved before: the hold is placed on it at once (D73). */
  paymentMethodId?: string;
}

/** A change to a customer's balance with the provider; `amountCents` is always positive. */
export interface BalanceInput {
  customerRef: string;
  amountCents: number;
  description: string;
  idempotencyKey: string;
}

/** A card saved with the payment provider, as Review & pay lists it (D73). */
export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** The card behind a payment (D83). `wallet` is the provider's wallet name, e.g. "apple_pay" or "google_pay". */
export interface PaymentMethodInfo {
  brand: string;
  last4: string | null;
  wallet: string | null;
}

export interface PayoutDetails {
  bankLast4: string | null;
  nextPayout: { amountCents: number; arrivesOn: Date } | null;
}
