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

/** Balance changes are whole, positive cent amounts; the sign is set by the method. */
function positiveCents(amountCents: number): number {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`Invalid balance amount: ${amountCents}`);
  }
  return amountCents;
}

function chargeIdOf(intent: Stripe.PaymentIntent): string {
  const charge = intent.latest_charge;
  const id = typeof charge === 'string' ? charge : charge?.id;
  if (!id) {
    throw new Error(`PaymentIntent ${intent.id} has no charge after capture`);
  }
  return id;
}

/** The card set-up Stripe made for a plan billed from a later day (D91), when it was expanded. */
function setupIntentOf(subscription: Stripe.Subscription): Stripe.SetupIntent | null {
  const setup = subscription.pending_setup_intent;
  return setup && typeof setup !== 'string' ? setup : null;
}

/**
 * Whether a plan billed from a later day (D91) has its card: still in its free period before the first charge,
 * with a card on the plan and no card set-up left for the customer to confirm.
 */
function isCardReady(subscription: Stripe.Subscription): boolean {
  if (subscription.status !== 'trialing' && subscription.status !== 'active') {
    return false;
  }
  const setup = subscription.pending_setup_intent;
  const setupDone = !setup || (typeof setup !== 'string' && setup.status === 'succeeded');
  return setupDone && Boolean(subscription.default_payment_method);
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
          // Saved so approved extra work can be held on the same card without asking again, and the
          // reservation renewed for a job more than a week ahead while the customer is away (D74).
          setup_future_usage: 'off_session',
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          description: input.description,
          metadata: input.metadata,
          // A saved card is held at once; the bank may still ask the customer to confirm (D73).
          ...(input.paymentMethodId ? { payment_method: input.paymentMethodId, confirm: true } : {}),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return toHoldResult(intent);
    },

    async listCards(customerRef) {
      const methods = await stripe.customers.listPaymentMethods(customerRef, { type: 'card', limit: 10 });
      return methods.data
        .filter((method) => method.card && !method.card.wallet)
        .map((method) => ({
          id: method.id,
          brand: method.card?.brand ?? 'card',
          last4: method.card?.last4 ?? '',
          expMonth: method.card?.exp_month ?? 0,
          expYear: method.card?.exp_year ?? 0,
        }));
    },

    async createCardSetup({ customerRef, idempotencyKey }) {
      const setup = await stripe.setupIntents.create(
        {
          customer: customerRef,
          usage: 'off_session',
          // Like the booking payments (D73); Payment methods then lists the saved cards (D92).
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: { purpose: 'saved_card' },
        },
        { idempotencyKey },
      );
      if (!setup.client_secret) {
        throw new Error(`SetupIntent ${setup.id} has no client secret`);
      }
      return { clientSecret: setup.client_secret };
    },

    async defaultCardId(customerRef) {
      const customer = await stripe.customers.retrieve(customerRef);
      if (customer.deleted) {
        return null;
      }
      const method = customer.invoice_settings.default_payment_method;
      return typeof method === 'string' ? method : (method?.id ?? null);
    },

    async setDefaultCard(customerRef, cardId) {
      await stripe.customers.update(customerRef, { invoice_settings: { default_payment_method: cardId } });
    },

    async detachCard(customerRef, cardId) {
      // Only a card of this customer may be removed; another customer's card answers like a missing one.
      const method = await stripe.paymentMethods.retrieve(cardId);
      const owner = typeof method.customer === 'string' ? method.customer : method.customer?.id;
      if (owner !== customerRef) {
        throw new Error(`Payment method ${cardId} does not belong to ${customerRef}`);
      }
      await stripe.paymentMethods.detach(cardId);
    },

    async subscriptionCardId(subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      if (!['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status)) {
        return null;
      }
      const method = subscription.default_payment_method;
      return typeof method === 'string' ? method : (method?.id ?? null);
    },

    async setSubscriptionCard(subscriptionId, cardId) {
      await stripe.subscriptions.update(subscriptionId, { default_payment_method: cardId });
    },

    async renewHold(input) {
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
          off_session: true,
          description: input.description,
          metadata: input.metadata,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      const result = toHoldResult(intent);
      if (!result.held) {
        throw new Error(`Renewed hold ${intent.id} is not held: ${intent.status}`);
      }
      return result;
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

    async paymentMethodOf(intentId) {
      const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ['payment_method'] });
      const method = intent.payment_method;
      if (!method || typeof method === 'string' || !method.card) {
        return null;
      }
      return { brand: method.card.brand, last4: method.card.last4 || null, wallet: method.card.wallet?.type ?? null };
    },

    async reverseTransfer(transferId) {
      await stripe.transfers.createReversal(transferId, {}, { idempotencyKey: `reverse-${transferId}` });
    },

    async capture(intentId, amountCents) {
      const intent = await stripe.paymentIntents.capture(
        intentId,
        amountCents === undefined ? {} : { amount_to_capture: amountCents },
        { idempotencyKey: amountCents === undefined ? `capture-${intentId}` : `capture-${intentId}-${amountCents}` },
      );
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
          // A saved card is used straight away (the bank may still ask the customer to confirm); otherwise the
          // customer pays the first month, or sets up the card for a later first charge, in the browser.
          ...(input.paymentMethodId
            ? { default_payment_method: input.paymentMethodId, payment_behavior: 'allow_incomplete' as const }
            : { payment_behavior: 'default_incomplete' as const }),
          // Billing from the first visit day (D91): a free period until then, after which the first full month is
          // charged and the billing date stays on that day of the month. Without a card by then, the plan ends.
          ...(input.firstChargeAt
            ? {
                trial_end: Math.floor(input.firstChargeAt.getTime() / 1000),
                trial_settings: { end_behavior: { missing_payment_method: 'cancel' as const } },
              }
            : {}),
          // The card the customer pays or sets up with becomes the plan's card for every month.
          payment_settings: { save_default_payment_method: 'on_subscription' },
          metadata: input.metadata,
          expand: ['latest_invoice.confirmation_secret', 'pending_setup_intent'],
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (subscription.status === 'trialing') {
        const setup = setupIntentOf(subscription);
        const ready = isCardReady(subscription);
        if (!ready && !setup?.client_secret) {
          throw new Error(`Subscription ${subscription.id} has neither a card nor a card set-up`);
        }
        return {
          subscriptionId: subscription.id,
          clientSecret: ready ? null : (setup?.client_secret ?? null),
          confirm: 'setup',
          active: ready,
          paid: false,
          invoiceId: null,
        };
      }
      const invoice = subscription.latest_invoice;
      const active = subscription.status === 'active';
      return {
        subscriptionId: subscription.id,
        clientSecret: active || typeof invoice === 'string' ? null : (invoice?.confirmation_secret?.client_secret ?? null),
        confirm: 'payment',
        active,
        paid: active,
        invoiceId: typeof invoice === 'string' ? invoice : (invoice?.id ?? null),
      };
    },

    async subscriptionCardReady(subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['pending_setup_intent'] });
      return isCardReady(subscription);
    },

    async resumeSubscription(subscriptionId) {
      await stripe.subscriptions.update(subscriptionId, { cancel_at: '', cancel_at_period_end: false });
    },

    async subscriptionPaymentMethod(subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['default_payment_method'] });
      const method = subscription.default_payment_method;
      if (!method || typeof method === 'string' || !method.card) {
        return null;
      }
      return { brand: method.card.brand, last4: method.card.last4 || null, wallet: method.card.wallet?.type ?? null };
    },

    async subscriptionClientSecret(subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['latest_invoice.confirmation_secret', 'pending_setup_intent'],
      });
      if (subscription.status === 'trialing') {
        const secret = isCardReady(subscription) ? null : setupIntentOf(subscription)?.client_secret;
        return secret ? { clientSecret: secret, confirm: 'setup' } : null;
      }
      const invoice = subscription.latest_invoice;
      if (subscription.status !== 'incomplete' || !invoice || typeof invoice === 'string') {
        return null;
      }
      const secret = invoice.confirmation_secret?.client_secret;
      return secret ? { clientSecret: secret, confirm: 'payment' } : null;
    },

    async cancelSubscription(subscriptionId, atPeriodEnd) {
      if (atPeriodEnd) {
        await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      } else {
        await stripe.subscriptions.cancel(subscriptionId);
      }
    },

    async cancelSubscriptionAt(subscriptionId, at) {
      await stripe.subscriptions.update(subscriptionId, {
        cancel_at: Math.floor(at.getTime() / 1000),
        proration_behavior: 'create_prorations',
      });
    },

    async setBillingPaused(subscriptionId, paused) {
      await stripe.subscriptions.update(subscriptionId, { pause_collection: paused ? { behavior: 'void' } : '' });
    },

    // A negative customer balance is a credit Stripe takes off the next invoice; a positive one is added to it.
    async creditCustomer(input) {
      const transaction = await stripe.customers.createBalanceTransaction(
        input.customerRef,
        { amount: -positiveCents(input.amountCents), currency: CURRENCY, description: input.description },
        { idempotencyKey: input.idempotencyKey },
      );
      return { transactionId: transaction.id };
    },

    async reverseCustomerCredit(input) {
      const transaction = await stripe.customers.createBalanceTransaction(
        input.customerRef,
        { amount: positiveCents(input.amountCents), currency: CURRENCY, description: input.description },
        { idempotencyKey: input.idempotencyKey },
      );
      return { transactionId: transaction.id };
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

    async bankAccount(accountId) {
      const account = await stripe.accounts.retrieve(accountId);
      const banks = (account.external_accounts?.data ?? []).filter((external) => external.object === 'bank_account');
      const bank = banks.find((external) => external.default_for_currency) ?? banks[0];
      if (!bank || bank.object !== 'bank_account') {
        return null;
      }
      // Stripe stops payouts while it checks a new account; a failed or errored account gets no payouts either.
      const failed = bank.status === 'verification_failed' || bank.status === 'errored';
      return { last4: bank.last4, holderName: bank.account_holder_name ?? null, active: Boolean(account.payouts_enabled) && !failed };
    },

    async bankChangeLink(accountId) {
      // Express accounts change their bank account in Stripe's Express dashboard; Stripe checks it there.
      const link = await stripe.accounts.createLoginLink(accountId);
      return link.url;
    },

    parseWebhook(rawBody, signature) {
      const event = stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
      let parsed: GatewayEvent = { kind: 'ignored' };
      if (event.type === 'payment_intent.amount_capturable_updated') {
        parsed = { kind: 'hold_confirmed', intentId: event.data.object.id };
      } else if (event.type === 'payment_intent.payment_failed') {
        parsed = { kind: 'payment_failed', intentId: event.data.object.id };
      } else if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
        // A plan billed from its first visit day (D91) whose card is now set up. The subscription in the event is
        // not expanded, so a set-up still pending is only known by its id: the plan is not ready then.
        const subscription = event.data.object;
        if (subscription.status === 'trialing' && !subscription.pending_setup_intent && subscription.default_payment_method) {
          parsed = { kind: 'subscription_ready', subscriptionId: subscription.id };
        }
      } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
        const invoice = event.data.object;
        const owner = invoice.parent?.subscription_details?.subscription;
        const subscriptionId = typeof owner === 'string' ? owner : owner?.id;
        // The free period before the first visit day is a €0 invoice Stripe marks paid at sign-up (D91): it is no
        // paid month. (A month paid with credit still has a subtotal; only its amount paid is 0.)
        const freePeriod = invoice.billing_reason === 'subscription_create' && invoice.subtotal === 0;
        if (subscriptionId && invoice.id && !freePeriod) {
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
