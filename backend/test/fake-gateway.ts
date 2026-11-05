import { randomUUID } from 'node:crypto';
import type { GatewayEvent, HoldInput, PaymentGateway } from '../src/payments/gateway.js';

export interface FakeIntent {
  id: string;
  amountCents: number;
  status: 'requires_payment_method' | 'held' | 'captured' | 'released' | 'refunded';
  metadata: Record<string, string>;
}

/**
 * An in-memory payment provider for automated tests and the browser-test server. Never used by the
 * real server, which refuses to start without Stripe. `instantHolds` decides whether holds succeed at
 * once (like a saved card) or wait for `webhook()` (like a card form).
 */
export function createFakeGateway(options: { instantHolds?: boolean } = {}) {
  const intents = new Map<string, FakeIntent>();
  const transfers: { id: string; accountId: string; amountCents: number; reversed: boolean }[] = [];
  const failures = new Set<'hold' | 'capture' | 'transfer' | 'subscription'>();
  const subscriptions = new Map<string, { id: string; amountCents: number; status: 'incomplete' | 'active' | 'cancelled'; cancelAtPeriodEnd: boolean; paused: boolean; metadata: Record<string, string> }>();
  let instantHolds = options.instantHolds ?? true;

  function hold(input: HoldInput) {
    if (failures.has('hold')) {
      throw new Error('fake hold failure');
    }
    const id = `pi_${randomUUID()}`;
    intents.set(id, {
      id,
      amountCents: input.amountCents,
      status: instantHolds ? 'held' : 'requires_payment_method',
      metadata: input.metadata,
    });
    return { intentId: id, clientSecret: instantHolds ? null : `${id}_secret`, held: instantHolds };
  }

  const gateway: PaymentGateway = {
    publishableKey: null,
    ensureCustomer: async ({ userId, existing }) => existing ?? `cus_${userId}`,
    createHold: async (input) => hold(input),
    holdOnSavedCard: async (input) => hold(input),
    clientSecretFor: async (intentId) =>
      intents.get(intentId)?.status === 'requires_payment_method' ? `${intentId}_secret` : null,
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
      const id = `sub_${randomUUID()}`;
      subscriptions.set(id, {
        id,
        amountCents: input.amountCents,
        status: instantHolds ? 'active' : 'incomplete',
        cancelAtPeriodEnd: false,
        paused: false,
        metadata: input.metadata,
      });
      return { subscriptionId: id, clientSecret: instantHolds ? null : `${id}_secret`, active: instantHolds };
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
    async setBillingPaused(subscriptionId, paused) {
      const subscription = subscriptions.get(subscriptionId);
      if (subscription) {
        subscription.paused = paused;
      }
    },
    onboardingLink: async ({ returnUrl }) => returnUrl,
    accountStatus: async () => ({ payoutsEnabled: true }),
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
      failures.clear();
      instantHolds = options.instantHolds ?? true;
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
