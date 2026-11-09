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
          ...(input.sourceChargeId ? { source_transaction: input.sourceChargeId } : {}),
          transfer_group: input.transferGroup,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { transferId: transfer.id };
    },

    async ensureProduct({ planId, name, existing }) {
      if (existing) {
        return existing;
      }
      const product = await stripe.products.create({ name: `MISK ${name}`, metadata: { planId } }, { idempotencyKey: `product-${planId}` });
      return product.id;
    },

    async createSubscription(input) {
      const subscription = await stripe.subscriptions.create(
        {
          customer: input.customerRef,
          items: [{ price_data: { currency: CURRENCY, product: input.productId, unit_amount: input.amountCents, recurring: { interval: 'month' } } }],
          payment_behavior: 'default_incomplete',
          payment_settings: { save_default_payment_method: 'on_subscription' },
          metadata: input.metadata,
          expand: ['latest_invoice.confirmation_secret'],
        },
        { idempotencyKey: input.idempotencyKey },
      );
      const invoice = subscription.latest_invoice;
      const active = subscription.status === 'active';
      return {
        subscriptionId: subscription.id,
        clientSecret: active || typeof invoice === 'string' ? null : (invoice?.confirmation_secret?.client_secret ?? null),
        active,
      };
    },

    async subscriptionClientSecret(subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice.confirmation_secret'] });
      const invoice = subscription.latest_invoice;
      if (subscription.status !== 'incomplete' || !invoice || typeof invoice === 'string') {
        return null;
      }
      return invoice.confirmation_secret?.client_secret ?? null;
    },

    async cancelSubscription(subscriptionId, atPeriodEnd) {
      if (atPeriodEnd) {
        await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      } else {
        await stripe.subscriptions.cancel(subscriptionId);
      }
    },

    async setBillingPaused(subscriptionId, paused) {
      await stripe.subscriptions.update(subscriptionId, { pause_collection: paused ? { behavior: 'void' } : '' });
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

    async setPayoutSchedule(accountId, schedule) {
      const settings =
        schedule === 'weekly'
          ? { interval: 'weekly' as const, weekly_anchor: 'friday' as const }
          : schedule === 'monthly'
            ? { interval: 'monthly' as const, monthly_anchor: 1 }
            : { interval: 'manual' as const };
      await stripe.accounts.update(accountId, { settings: { payouts: { schedule: settings } } });
    },

    async payOutBalance(accountId, idempotencyKey) {
      const balance = await stripe.balance.retrieve({}, { stripeAccount: accountId });
      const available = balance.available.find((b) => b.currency === 'eur')?.amount ?? 0;
      if (available <= 0) {
        return 0;
      }
      await stripe.payouts.create({ amount: available, currency: 'eur' }, { stripeAccount: accountId, idempotencyKey });
      return available;
    },

    async payoutDetails(accountId) {
      const [account, payouts] = await Promise.all([
        stripe.accounts.retrieve(accountId),
        stripe.payouts.list({ limit: 1, status: 'pending' }, { stripeAccount: accountId }),
      ]);
      const bank = account.external_accounts?.data.find((external) => external.object === 'bank_account');
      const next = payouts.data[0];
      return {
        bankLast4: bank?.last4 ?? null,
        nextPayout: next ? { amountCents: next.amount, arrivesOn: new Date(next.arrival_date * 1000) } : null,
      };
    },

    parseWebhook(rawBody, signature) {
      const event = stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
      let parsed: GatewayEvent = { kind: 'ignored' };
      if (event.type === 'payment_intent.amount_capturable_updated') {
        parsed = { kind: 'hold_confirmed', intentId: event.data.object.id };
      } else if (event.type === 'payment_intent.payment_failed') {
        parsed = { kind: 'payment_failed', intentId: event.data.object.id };
      } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
        const invoice = event.data.object;
        const owner = invoice.parent?.subscription_details?.subscription;
        const subscriptionId = typeof owner === 'string' ? owner : owner?.id;
        if (subscriptionId && invoice.id) {
          parsed =
            event.type === 'invoice.paid'
              ? {
                  kind: 'invoice_paid',
                  subscriptionId,
                  invoiceId: invoice.id,
                  amountCents: invoice.amount_paid,
                  periodEnd: new Date((invoice.lines.data[0]?.period.end ?? invoice.period_end) * 1000),
                }
              : { kind: 'invoice_failed', subscriptionId };
        }
      }
      return { eventId: event.id, event: parsed };
    },
  };
}
