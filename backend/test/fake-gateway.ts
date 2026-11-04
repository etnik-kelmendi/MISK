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
  const failures = new Set<'hold' | 'capture' | 'transfer'>();
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
    failures,
    /** Forgets everything, for a clean start in each test. */
    reset() {
      intents.clear();
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
