import { randomUUID } from 'node:crypto';
import type { BalanceInput, GatewayEvent, HoldInput, PaymentGateway, PaymentMethodInfo, SavedCard } from '../src/payments/gateway.js';

/** A change to a customer's balance: a credit off the next bill, or a credit taken back (D78). */
export interface FakeBalanceChange {
  id: string;
  kind: 'credit' | 'reversal';
  customerRef: string;
  amountCents: number;
  description: string;
  idempotencyKey: string;
}

export interface FakeIntent {
  id: string;
  amountCents: number;
  status: 'requires_payment_method' | 'held' | 'captured' | 'released' | 'refunded';
  metadata: Record<string, string>;
  /** The saved card the hold was placed on, if any (D73). */
  paymentMethodId?: string;
}

/**
 * An in-memory payment provider for automated tests and the browser-test server. Never used by the
 * real server, which refuses to start without Stripe. `instantHolds` decides whether holds succeed at
 * once (like a saved card) or wait for `webhook()` (like a card form).
 */
export function createFakeGateway(options: { instantHolds?: boolean } = {}) {
  const intents = new Map<string, FakeIntent>();
  const transfers: { id: string; accountId: string; amountCents: number; reversed: boolean }[] = [];
  const failures = new Set<
    'hold' | 'capture' | 'transfer' | 'subscription' | 'payoutDetails' | 'payoutSchedule' | 'renew' | 'credit' | 'paymentMethod'
  >();
  /** Payment methods set by a test, e.g. Apple Pay, per payment (D83). */
  const paymentMethods = new Map<string, PaymentMethodInfo>();
  /** Every payment whose method was asked for, to check the receipt caches it. */
  const methodLookups: string[] = [];
  const balance: FakeBalanceChange[] = [];

  /** Like Stripe: the same idempotency key returns the first result instead of changing the balance twice. */
  function changeBalance(kind: FakeBalanceChange['kind'], input: BalanceInput) {
    if (failures.has('credit')) {
      throw new Error('fake balance change failure');
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new Error(`fake: invalid balance amount ${input.amountCents}`);
    }
    const earlier = balance.find((change) => change.idempotencyKey === input.idempotencyKey);
    if (earlier) {
      return { transactionId: earlier.id };
    }
    const id = `cbtxn_${randomUUID()}`;
    balance.push({ id, kind, ...input });
    return { transactionId: id };
  }
  const schedules = new Map<string, 'weekly' | 'monthly' | 'manual'>();
  const manualPayouts: string[] = [];
  const subscriptions = new Map<
    string,
    {
      id: string;
      amountCents: number;
      status: 'incomplete' | 'active' | 'cancelled';
      cancelAtPeriodEnd: boolean;
      cancelAt: Date | null;
      paused: boolean;
      metadata: Record<string, string>;
      /** The saved card the plan is billed to (D90), when the customer chose one. */
      paymentMethodId: string | null;
    }
  >();
  let instantHolds = options.instantHolds ?? true;
  // Every customer has one saved test card, like a returning customer (D73).
  const defaultCards = (): SavedCard[] => [{ id: 'pm_card_visa', brand: 'visa', last4: '4242', expMonth: 8, expYear: 2030 }];
  let cards: SavedCard[] = defaultCards();

  function hold(input: HoldInput) {
    if (failures.has('hold')) {
      throw new Error('fake hold failure');
    }
    if (input.paymentMethodId && !cards.some((card) => card.id === input.paymentMethodId)) {
      throw new Error(`fake: no saved card ${input.paymentMethodId}`);
    }
    const id = `pi_${randomUUID()}`;
    intents.set(id, {
      id,
      amountCents: input.amountCents,
      status: instantHolds ? 'held' : 'requires_payment_method',
      metadata: input.metadata,
      ...(input.paymentMethodId ? { paymentMethodId: input.paymentMethodId } : {}),
    });
    return { intentId: id, clientSecret: instantHolds ? null : `${id}_secret`, held: instantHolds };
  }

  const gateway: PaymentGateway = {
    publishableKey: null,
    ensureCustomer: async ({ userId, existing }) => existing ?? `cus_${userId}`,
    createHold: async (input) => hold(input),
    listCards: async () => cards,
    async renewHold(input) {
      if (failures.has('renew')) throw new Error('fake renewal refused');
      const id = `pi_${randomUUID()}`;
      intents.set(id, { id, amountCents: input.amountCents, status: 'held', metadata: input.metadata });
      return { intentId: id, clientSecret: null, held: true };
    },
    holdOnSavedCard: async (input) => hold(input),
    clientSecretFor: async (intentId) =>
      intents.get(intentId)?.status === 'requires_payment_method' ? `${intentId}_secret` : null,
    async paymentMethodOf(intentId) {
      methodLookups.push(intentId);
      if (failures.has('paymentMethod')) {
        throw new Error('fake payment method failure');
      }
      const intent = intents.get(intentId);
      if (!intent || intent.status === 'requires_payment_method') {
        return null;
      }
      const override = paymentMethods.get(intentId);
      if (override) {
        return override;
      }
      // A hold on a saved card is on that card; a card form used the default test card.
      const card = cards.find((c) => c.id === intent.paymentMethodId) ?? defaultCards()[0];
      return card ? { brand: card.brand, last4: card.last4, wallet: null } : null;
    },
    async capture(intentId) {
      const intent = intents.get(intentId);
      if (failures.has('capture') || !intent || (intent.status !== 'held' && intent.status !== 'captured')) {
        throw new Error(`fake capture failure for ${intentId}`);
      }
      intent.status = 'captured';
      return { chargeId: `ch_${intentId}` };
    },
    async release(intentId) {
      const intent = intents.get(intentId);
      if (intent && intent.status !== 'captured') {
        intent.status = 'released';
      }
    },
    async refund(intentId) {
      const intent = intents.get(intentId);
      if (!intent || intent.status !== 'captured') {
        throw new Error(`fake refund failure for ${intentId}`);
      }
      intent.status = 'refunded';
    },
    async reverseTransfer(transferId) {
      const transfer = transfers.find((t) => t.id === transferId);
      if (transfer) {
        transfer.reversed = true;
      }
    },
    async transfer(input) {
      if (failures.has('transfer')) {
        throw new Error('fake transfer failure');
      }
      const id = `tr_${randomUUID()}`;
      transfers.push({ id, accountId: input.accountId, amountCents: input.amountCents, reversed: false });
      return { transferId: id };
    },
    createConnectedAccount: async ({ userId }) => `acct_${userId.slice(0, 8)}`,
    ensureProduct: async ({ planId, existing }) => existing ?? `prod_${planId.slice(0, 8)}`,
    async createSubscription(input) {
      if (failures.has('subscription')) {
        throw new Error('fake subscription failure');
      }
      if (input.paymentMethodId && !cards.some((card) => card.id === input.paymentMethodId)) {
        throw new Error(`fake: no saved card ${input.paymentMethodId}`);
      }
      const id = `sub_${randomUUID()}`;
      subscriptions.set(id, {
        id,
        amountCents: input.amountCents,
        status: instantHolds ? 'active' : 'incomplete',
        cancelAtPeriodEnd: false,
        cancelAt: null,
        paused: false,
        metadata: input.metadata,
        paymentMethodId: input.paymentMethodId ?? null,
      });
      return { subscriptionId: id, clientSecret: instantHolds ? null : `${id}_secret`, active: instantHolds, invoiceId: `in_first_${id}` };
    },
    async resumeSubscription(subscriptionId) {
      const subscription = subscriptions.get(subscriptionId);
      if (subscription) {
        subscription.cancelAt = null;
        subscription.cancelAtPeriodEnd = false;
      }
    },
    async subscriptionPaymentMethod(subscriptionId) {
      if (failures.has('paymentMethod')) {
        throw new Error('fake payment method failure');
      }
      const subscription = subscriptions.get(subscriptionId);
      if (!subscription || subscription.status === 'incomplete') {
        return null;
      }
      // Billed to the saved card chosen, or the card form's default test card.
      const card = cards.find((c) => c.id === subscription.paymentMethodId) ?? defaultCards()[0];
      return card ? { brand: card.brand, last4: card.last4, wallet: null } : null;
    },
    subscriptionClientSecret: async (subscriptionId) =>
      subscriptions.get(subscriptionId)?.status === 'incomplete' ? `${subscriptionId}_secret` : null,
    async cancelSubscription(subscriptionId, atPeriodEnd) {
      const subscription = subscriptions.get(subscriptionId);
      if (subscription) {
        if (atPeriodEnd) {
          subscription.cancelAtPeriodEnd = true;
        } else {
          subscription.status = 'cancelled';
        }
      }
    },
    async cancelSubscriptionAt(subscriptionId, at) {
      const subscription = subscriptions.get(subscriptionId);
      if (subscription) {
        subscription.cancelAt = at;
      }
    },
    async setBillingPaused(subscriptionId, paused) {
      const subscription = subscriptions.get(subscriptionId);
      if (subscription) {
        subscription.paused = paused;
      }
    },
    creditCustomer: async (input) => changeBalance('credit', input),
    reverseCustomerCredit: async (input) => changeBalance('reversal', input),
    onboardingLink: async ({ returnUrl }) => returnUrl,
    accountStatus: async () => ({ payoutsEnabled: true }),
    setPayoutSchedule: async (accountId, schedule) => {
      if (failures.has('payoutSchedule')) {
        throw new Error('fake payout schedule failure');
      }
      schedules.set(accountId, schedule);
    },
    payOutBalance: async (accountId) => {
      manualPayouts.push(accountId);
      return 5_000;
    },
    payoutDetails: async () => {
      if (failures.has('payoutDetails')) {
        throw new Error('fake payout details failure');
      }
      return { bankLast4: '3000', nextPayout: { amountCents: 12_450, arrivesOn: new Date('2026-11-13T00:00:00Z') } };
    },
    parseWebhook(rawBody, signature) {
      if (signature !== 'fake-signature') {
        throw new Error('bad signature');
      }
      return JSON.parse(rawBody.toString('utf8')) as { eventId: string; event: GatewayEvent };
    },
  };

  return {
    gateway,
    intents,
    transfers,
    subscriptions,
    failures,
    /** Credits and reversals on customers' balances, in order (D78). */
    balance,
    schedules,
    manualPayouts,
    /** Makes payments that already exist in seeded data known to the fake. */
    addIntents(seeded: { id: string; amountCents: number; status: FakeIntent['status'] }[]) {
      for (const intent of seeded) {
        intents.set(intent.id, { ...intent, metadata: {} });
      }
    },
    /** Forgets everything, for a clean start in each test. */
    reset() {
      intents.clear();
      subscriptions.clear();
      transfers.length = 0;
      balance.length = 0;
      failures.clear();
      schedules.clear();
      manualPayouts.length = 0;
      instantHolds = options.instantHolds ?? true;
      cards = defaultCards();
      paymentMethods.clear();
      methodLookups.length = 0;
    },
    /** Payments whose method the app asked for, in order (D83). */
    methodLookups,
    /** How one payment was made, e.g. Apple Pay with a Visa card (D83). */
    setPaymentMethod(intentId: string, method: PaymentMethodInfo) {
      paymentMethods.set(intentId, method);
    },
    /** The saved cards every customer has, e.g. none for a first-time customer. */
    setCards(next: SavedCard[]) {
      cards = next;
    },
    setInstantHolds(value: boolean) {
      instantHolds = value;
    },
    /** Marks a waiting intent as held, as the customer's card form plus Stripe's webhook would. */
    authorise(intentId: string) {
      const intent = intents.get(intentId);
      if (intent) {
        intent.status = 'held';
      }
    },
  };
}

export type FakeGateway = ReturnType<typeof createFakeGateway>;
