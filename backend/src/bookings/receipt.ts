import type { FastifyBaseLogger } from 'fastify';
import type { Queryable } from '../db.js';
import type { PaymentGateway, PaymentMethodInfo } from '../payments/gateway.js';
import { CHARGE_DELAY_HOURS } from './lifecycle.js';
import { renderPdf, type PdfLine } from './pdf.js';

/** How the money for a booking stands, as the receipt names it. */
export type ReceiptState = 'paid' | 'charging' | 'on_hold' | 'refunded' | 'released' | 'unpaid';

export interface Receipt {
  number: string;
  bookingNumber: string;
  date: string;
  serviceName: string;
  proName: string | null;
  address: string;
  lines: { label: string; cents: number; kind: 'job' | 'discount' | 'extra' | 'fee' | 'tip' }[];
  totalCents: number;
  state: ReceiptState;
  chargeAt: string | null;
  /** How the customer paid (D83), e.g. "Visa •••• 4242" or "Apple Pay · Visa •••• 4242"; null when not known. */
  paymentMethod: (PaymentMethodInfo & { label: string }) | null;
}

const SIZES: Record<string, string> = { S: 'small', M: 'medium', L: 'large' };

function euro(cents: number): string {
  return `${cents < 0 ? '-' : ''}€${(Math.abs(cents) / 100).toFixed(2)}`;
}

function day(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: timezone }).format(new Date(iso));
}

/**
 * The receipt of one finished (or late-cancelled) booking, for its customer only: the job, every approved
 * extra, the service fee and a tip that went through, with how the money stands (D67). Null when the
 * booking is not the customer's or has nothing to receipt yet.
 */
export async function loadReceipt(
  db: Queryable,
  bookingId: string,
  customerId: string,
  provider?: { gateway: PaymentGateway; log: FastifyBaseLogger },
): Promise<Receipt | null> {
  const found = await db.query<{
    number: number;
    service_name: string;
    size: string;
    address: string;
    postcode: string;
    price_cents: number;
    fee_cents: number;
    status: string;
    late_cancel: boolean;
    payment_status: string;
    problem_open: boolean;
    charge_at: Date | null;
    when: Date;
    pro_name: string | null;
    package_discount_cents: number;
    payment_intent_id: string | null;
    payment_method_brand: string | null;
    payment_method_last4: string | null;
    payment_method_wallet: string | null;
  }>(
    `SELECT b.number, b.service_name, b.size, b.address, b.postcode, b.price_cents, b.fee_cents, b.status, b.late_cancel,
       b.payment_status, (b.problem_reported_at IS NOT NULL AND b.problem_resolved_at IS NULL) AS problem_open,
       CASE WHEN b.status = 'completed' THEN b.completed_at + make_interval(hours => $3) END AS charge_at,
       COALESCE(b.completed_at, b.starts_at) AS "when", pu.first_name AS pro_name, b.package_discount_cents,
       b.payment_intent_id, b.payment_method_brand, b.payment_method_last4, b.payment_method_wallet
     FROM bookings b LEFT JOIN users pu ON pu.id = b.pro_id
     WHERE b.id = $1 AND b.customer_id = $2`,
    [bookingId, customerId, CHARGE_DELAY_HOURS],
  );
  const b = found.rows[0];
  if (!b || !(b.status === 'completed' || (b.status === 'cancelled' && b.late_cancel))) {
    return null;
  }
  const [services, extras, tip] = await Promise.all([
    db.query<{ name: string; price_cents: number }>(
      'SELECT name, price_cents FROM booking_services WHERE booking_id = $1 ORDER BY position',
      [bookingId],
    ),
    db.query<{ description: string; amount_cents: number }>(
      `SELECT description, price_cents AS amount_cents FROM extra_requests
       WHERE booking_id = $1 AND status = 'approved' AND payment_status IN ('held', 'captured', 'refunded') ORDER BY created_at`,
      [bookingId],
    ),
    db.query<{ amount_cents: number }>("SELECT amount_cents FROM tips WHERE booking_id = $1 AND status = 'captured'", [bookingId]),
  ]);
  // A package lists each service and the discount (D68); a single service is one line.
  const jobLines: Receipt['lines'] =
    services.rows.length > 1
      ? [
          ...services.rows.map((x) => ({ label: `${x.name}, ${SIZES[b.size] ?? b.size} job`, cents: x.price_cents, kind: 'job' as const })),
          { label: 'Package discount (10%)', cents: -b.package_discount_cents, kind: 'discount' as const },
        ]
      : [{ label: `${b.service_name}, ${SIZES[b.size] ?? b.size} job`, cents: b.price_cents, kind: 'job' as const }];
  const lines: Receipt['lines'] = [
    ...jobLines,
    ...extras.rows.map((x) => ({ label: `${x.description} (approved in the app)`, cents: x.amount_cents, kind: 'extra' as const })),
  ];
  // A late cancellation is charged the job price only.
  if (!b.late_cancel) lines.push({ label: 'Service fee', cents: b.fee_cents, kind: 'fee' });
  if (tip.rows[0]) lines.push({ label: 'Tip', cents: tip.rows[0].amount_cents, kind: 'tip' });
  const state: ReceiptState =
    b.payment_status === 'refunded'
      ? 'refunded'
      : b.payment_status === 'released'
        ? 'released'
        : b.payment_status === 'captured'
          ? 'paid'
          : b.problem_open
            ? 'on_hold'
            : b.payment_status === 'held'
              ? 'charging'
              : 'unpaid';
  let method: PaymentMethodInfo | null = b.payment_method_brand
    ? { brand: b.payment_method_brand, last4: b.payment_method_last4, wallet: b.payment_method_wallet }
    : null;
  if (!method && b.payment_intent_id && provider) {
    method = await fetchPaymentMethod(db, bookingId, b.payment_intent_id, provider);
  }
  return {
    number: `R-${b.number}`,
    bookingNumber: `B-${b.number}`,
    date: b.when.toISOString(),
    serviceName: b.service_name,
    proName: b.pro_name,
    address: `${b.address}, ${b.postcode}`,
    lines,
    totalCents: lines.reduce((sum, line) => sum + line.cents, 0),
    state,
    chargeAt: b.charge_at?.toISOString() ?? null,
    paymentMethod: method ? { ...method, label: paymentMethodLabel(method) } : null,
  };
}

/**
 * Asks the payment provider how a booking was paid and keeps the answer on the booking, so later receipts
 * do not ask again (D83). A provider that cannot answer leaves the receipt without a payment method.
 */
async function fetchPaymentMethod(
  db: Queryable,
  bookingId: string,
  intentId: string,
  provider: { gateway: PaymentGateway; log: FastifyBaseLogger },
): Promise<PaymentMethodInfo | null> {
  try {
    const found = await provider.gateway.paymentMethodOf(intentId);
    if (!found || !found.brand) return null;
    const method: PaymentMethodInfo = {
      brand: found.brand.slice(0, 40),
      last4: found.last4 && /^[0-9]{4}$/.test(found.last4) ? found.last4 : null,
      wallet: found.wallet ? found.wallet.slice(0, 40) : null,
    };
    await db.query(
      'UPDATE bookings SET payment_method_brand = $2, payment_method_last4 = $3, payment_method_wallet = $4 WHERE id = $1',
      [bookingId, method.brand, method.last4, method.wallet],
    );
    return method;
  } catch (error) {
    provider.log.warn({ event: 'payment_method_lookup_failed', bookingId, err: error });
    return null;
  }
}

const BRAND_NAMES: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  cartes_bancaires: 'Cartes Bancaires',
  eftpos_au: 'eftpos',
};

const WALLET_NAMES: Record<string, string> = {
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  samsung_pay: 'Samsung Pay',
  link: 'Link',
};

/** "visa" → "Visa"; an unknown name with its words capitalised. */
function displayName(names: Record<string, string>, value: string): string {
  return names[value] ?? value.split(/[_\s]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** "Visa •••• 4242", or "Apple Pay · Visa •••• 4242" for a wallet (D83). */
export function paymentMethodLabel(method: PaymentMethodInfo): string {
  const card = `${displayName(BRAND_NAMES, method.brand)}${method.last4 ? ` •••• ${method.last4}` : ''}`;
  return method.wallet ? `${displayName(WALLET_NAMES, method.wallet)} · ${card}` : card;
}

const STATE_TEXT: Record<ReceiptState, string> = {
  paid: 'Paid',
  charging: 'Charged 24 hours after the job, unless you report a problem',
  on_hold: 'On hold while MISK support looks into your report',
  refunded: 'Refunded',
  released: 'Not charged: the hold on your card was released',
  unpaid: 'Not paid yet',
};

/** The receipt as plain text, for the email body. */
export function receiptText(receipt: Receipt, timezone: string): string {
  return [
    `MISK receipt ${receipt.number} (booking ${receipt.bookingNumber})`,
    `${day(receipt.date, timezone)}${receipt.proName ? ` · ${receipt.proName}` : ''} · ${receipt.address}`,
    '',
    ...receipt.lines.map((line) => `${line.label}: ${euro(line.cents)}`),
    `Total: ${euro(receipt.totalCents)}`,
    ...(receipt.paymentMethod ? [`Payment method: ${receipt.paymentMethod.label}`] : []),
    '',
    STATE_TEXT[receipt.state],
    'Prices include VAT.',
  ].join('\n');
}

/** One A4 page per receipt. */
function receiptPage(receipt: Receipt, timezone: string): PdfLine[] {
  const left = 56;
  const right = 539;
  const lines: PdfLine[] = [
    { text: 'MISK', x: left, y: 80, size: 22, bold: true },
    { text: `Receipt ${receipt.number}`, x: right, y: 74, size: 11, align: 'right' },
    { text: `Booking ${receipt.bookingNumber}`, x: right, y: 90, size: 10, align: 'right' },
    { text: receipt.serviceName, x: left, y: 130, size: 14, bold: true },
    { text: `${day(receipt.date, timezone)}${receipt.proName ? ` · ${receipt.proName}` : ''}`, x: left, y: 150, size: 10 },
    { text: receipt.address, x: left, y: 166, size: 10 },
    { text: '', x: left, y: 186, rule: true },
  ];
  let y = 212;
  for (const line of receipt.lines) {
    lines.push({ text: line.label, x: left, y, size: 11 }, { text: euro(line.cents), x: right, y, size: 11, align: 'right' });
    y += 22;
  }
  lines.push(
    { text: '', x: left, y: y - 8, rule: true },
    { text: 'Total', x: left, y: y + 14, size: 13, bold: true },
    { text: euro(receipt.totalCents), x: right, y: y + 14, size: 13, bold: true, align: 'right' },
    ...(receipt.paymentMethod ? [{ text: `Payment method: ${receipt.paymentMethod.label}`, x: left, y: y + 38, size: 10 }] : []),
    { text: STATE_TEXT[receipt.state], x: left, y: y + 56, size: 10 },
    { text: 'Prices include VAT. Questions? Write to us in the MISK app.', x: left, y: y + 72, size: 9 },
  );
  return lines;
}

/** The PDF of one or more receipts, one page each. */
export function receiptsPdf(receipts: Receipt[], timezone: string, title: string): Buffer {
  return renderPdf(
    receipts.map((receipt) => receiptPage(receipt, timezone)),
    title,
  );
}
