import Stripe from 'stripe';
import type { StripeConfig } from '../config.js';
import type { GatewayEvent, HoldInput, HoldResult, PaymentGateway } from './gateway.js';

const CURRENCY = 'eur';

function toHoldResult(intent: Stripe.PaymentIntent): HoldResult {
  return {
    intentId: intent.id,
    clientSecret: intent.status === 'requires_capture' ? null : intent.client_secret,
    held: intent.status === 'requires_capture',
  };
}

function chargeIdOf(intent: Stripe.PaymentIntent): string {
  const charge = intent.latest_charge;
  const id = typeof charge === 'string' ? charge : charge?.id;
  if (!id) {
    throw new Error(`PaymentIntent ${intent.id} has no charge after capture`);
  }
  return id;
}

export function createStripeGateway(config: StripeConfig): PaymentGateway {
  const stripe = new Stripe(config.secretKey, { maxNetworkRetries: 2, timeout: 20_000 });

  return {
    publishableKey: config.publishableKey,

    async ensureCustomer({ userId, existing }) {
      if (existing) {
        return existing;
      }
      const customer = await stripe.customers.create(
        { metadata: { userId } },
        { idempotencyKey: `customer-${userId}` },
      );
      return customer.id;
    },

    async createHold(input: HoldInput) {
      const intent = await stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: CURRENCY,
          customer: input.customerRef,
          capture_method: 'manual',
          // Saved so approved extra work can be held on the same card without asking again.
          setup_future_usage: 'on_session',
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          description: input.description,
          metadata: input.metadata,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return toHoldResult(intent);
    },

    async holdOnSavedCard(input) {
      const original = await stripe.paymentIntents.retrieve(input.fromIntentId);
      const paymentMethod =
        typeof original.payment_method === 'string' ? original.payment_method : original.payment_method?.id;
      if (!paymentMethod) {
        throw new Error(`PaymentIntent ${input.fromIntentId} has no saved payment method`);
      }
      const intent = await stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: CURRENCY,
          customer: input.customerRef,
          payment_method: paymentMethod,
          capture_method: 'manual',
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          description: input.description,
          metadata: input.metadata,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return toHoldResult(intent);
    },

    async clientSecretFor(intentId) {
      const intent = await stripe.paymentIntents.retrieve(intentId);
      return ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(intent.status)
        ? intent.client_secret
        : null;
    },

    async reverseTransfer(transferId) {
      await stripe.transfers.createReversal(transferId, {}, { idempotencyKey: `reverse-${transferId}` });
    },

    async capture(intentId) {
      const intent = await stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: `capture-${intentId}` });
      return { chargeId: chargeIdOf(intent) };
    },

    async release(intentId) {
      await stripe.paymentIntents.cancel(intentId, {}, { idempotencyKey: `release-${intentId}` });
    },

    async refund(intentId) {
      await stripe.refunds.create({ payment_intent: intentId }, { idempotencyKey: `refund-${intentId}` });
    },

    async transfer(input) {
      const transfer = await stripe.transfers.create(
        {
          amount: input.amountCents,
          currency: CURRENCY,
          destination: input.accountId,
          source_transaction: input.sourceChargeId,
          transfer_group: input.transferGroup,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { transferId: transfer.id };
    },

    async createConnectedAccount({ userId, idempotencyKey }) {
      const account = await stripe.accounts.create(
        {
          type: 'express',
          capabilities: { transfers: { requested: true } },
          settings: { payouts: { schedule: { interval: 'weekly', weekly_anchor: 'friday' } } },
          metadata: { userId },
        },
        { idempotencyKey },
      );
      return account.id;
    },

    async onboardingLink({ accountId, returnUrl, refreshUrl }) {
      const link = await stripe.accountLinks.create({
        account: accountId,
        type: 'account_onboarding',
        return_url: returnUrl,
        refresh_url: refreshUrl,
      });
      return link.url;
    },

    async accountStatus(accountId) {
      const account = await stripe.accounts.retrieve(accountId);
      return { payoutsEnabled: Boolean(account.payouts_enabled) };
    },

    parseWebhook(rawBody, signature) {
      const event = stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
      let parsed: GatewayEvent = { kind: 'ignored' };
      if (event.type === 'payment_intent.amount_capturable_updated') {
        parsed = { kind: 'hold_confirmed', intentId: event.data.object.id };
      } else if (event.type === 'payment_intent.payment_failed') {
        parsed = { kind: 'payment_failed', intentId: event.data.object.id };
      }
      return { eventId: event.id, event: parsed };
    },
  };
}
