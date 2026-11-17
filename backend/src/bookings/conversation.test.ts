import {
  approvedPro,
  call,
  createTestContext,
  FILES,
  resetDatabase,
  seedMarket,
  signIn,
  upload,
  type Market,
  type TestContext,
} from '../../test/helpers.js';
import { pdfString, renderPdf } from './pdf.js';

let t: TestContext;
let market: Market;
let customer: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.fake.reset();
  t.emails.length = 0;
  market = await seedMarket(t.pool);
  customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
});

const get = (url: string, cookie = customer) => call(t, 'GET', url, { cookie });
const post = (url: string, body?: unknown, cookie = customer) => call(t, 'POST', url, { cookie, ...(body === undefined ? {} : { body }) });

async function book() {
  const slots = (await get(`/availability?serviceId=${market.mowing}&postcode=10115`)).json().slots as { startsAt: string; available: boolean }[];
  const free = slots.find((s) => s.available);
  if (!free) throw new Error('No free slot');
  const created = await post('/bookings', { serviceId: market.mowing, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt: free.startsAt });
  expect(created.statusCode).toBe(201);
  return created.json().booking.id as string;
}

async function assignedJob() {
  const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
  const bookingId = await book();
  const offer = (await get('/pro/offers', pro.cookie)).json().offers[0] as { id: string };
  expect((await post(`/pro/offers/${offer.id}/accept`, undefined, pro.cookie)).statusCode).toBe(200);
  return { bookingId, pro };
}

async function completedJob() {
  const job = await assignedJob();
  for (const status of ['on_the_way', 'working']) await post(`/pro/jobs/${job.bookingId}/status`, { status }, job.pro.cookie);
  await upload(t, `/pro/jobs/${job.bookingId}/photos`, job.pro.cookie, FILES.png);
  expect((await post(`/pro/jobs/${job.bookingId}/complete`, undefined, job.pro.cookie)).statusCode).toBe(200);
  return job;
}

describe('chat between customer and pro (D67)', () => {
  it('lets both sides write, marks messages read, and tells the other side by push and in the app, not by text', async () => {
    const { bookingId, pro } = await assignedJob();
    const sent = await post(`/bookings/${bookingId}/messages`, { body: '  I\x27ll be home at 12  ' });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().message).toMatchObject({ from: 'customer', body: 'I\x27ll be home at 12', readAt: null });

    const proView = (await get(`/pro/jobs/${bookingId}/messages`, pro.cookie)).json();
    expect(proView).toMatchObject({ canWrite: true, messages: [{ from: 'customer', body: 'I\x27ll be home at 12' }] });
    expect((await post(`/pro/jobs/${bookingId}/messages`, { body: 'See you then!' }, pro.cookie)).statusCode).toBe(201);

    const mine = (await get(`/bookings/${bookingId}/messages`)).json().messages as { from: string; body: string; readAt: string | null }[];
    expect(mine.map((m) => [m.from, m.body])).toEqual([
      ['customer', 'I\x27ll be home at 12'],
      ['pro', 'See you then!'],
    ]);
    expect(mine[0]?.readAt).not.toBeNull();

    const told = await t.pool.query<{ channel: string }>(
      "SELECT DISTINCT channel FROM notifications WHERE kind = 'chat_message'",
    );
    expect(told.rows.map((r) => r.channel)).not.toContain('sms');
    const inbox = await t.pool.query<{ body: string }>("SELECT body FROM inbox WHERE kind = 'chat_message' ORDER BY created_at");
    expect(inbox.rows.map((r) => r.body)).toEqual(['MISK: Sara about Lawn mowing: I\x27ll be home at 12', 'MISK: Daniel about Lawn mowing: See you then!']);
  });

  it('is closed before a pro is assigned, and only open to that customer and that pro', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const bookingId = await book();
    expect((await get(`/bookings/${bookingId}/messages`)).json()).toEqual({ messages: [], canWrite: false });
    expect((await post(`/bookings/${bookingId}/messages`, { body: 'Hello?' })).json()).toEqual({ error: 'chat_closed' });

    const stranger = await signIn(t, '+4915100000002', 'customer');
    expect((await get(`/bookings/${bookingId}/messages`, stranger)).statusCode).toBe(404);
    const otherPro = await approvedPro(t, '+4915100000102', { trades: [market.gardening] });
    expect((await get(`/pro/jobs/${bookingId}/messages`, otherPro.cookie)).statusCode).toBe(404);
    expect((await post(`/bookings/${bookingId}/messages`, { body: '   ' })).statusCode).toBe(400);
  });
});

describe('receipts (D67)', () => {
  it('has none before the job is done', async () => {
    const { bookingId } = await assignedJob();
    expect((await get(`/bookings/${bookingId}/receipt`)).json()).toEqual({ error: 'no_receipt' });
  });

  it('lists the job, fee and total of a finished job, charged 24 hours later', async () => {
    const { bookingId } = await completedJob();
    const receipt = (await get(`/bookings/${bookingId}/receipt`)).json().receipt;
    expect(receipt).toMatchObject({
      number: expect.stringMatching(/^R-\d+$/),
      serviceName: 'Lawn mowing',
      proName: 'Daniel',
      address: '12 Linden Street, 10115',
      state: 'charging',
    });
    expect(receipt.lines.map((l: { kind: string }) => l.kind)).toEqual(['job', 'fee']);
    expect(receipt.totalCents).toBe(receipt.lines.reduce((s: number, l: { cents: number }) => s + l.cents, 0));
    // Another customer cannot see it.
    const stranger = await signIn(t, '+4915100000002', 'customer');
    expect((await get(`/bookings/${bookingId}/receipt`, stranger)).statusCode).toBe(404);
  });

  it('downloads a real PDF, one receipt or every receipt of the year', async () => {
    const { bookingId } = await completedJob();
    const one = await get(`/bookings/${bookingId}/receipt.pdf`);
    expect(one.statusCode).toBe(200);
    expect(one.headers['content-type']).toBe('application/pdf');
    expect(one.headers['content-disposition']).toMatch(/^attachment; filename="misk-receipt-R-\d+\.pdf"$/);
    expect(one.rawPayload.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(one.rawPayload.toString('latin1')).toContain('(Lawn mowing)');
    expect(one.rawPayload.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);

    const all = await get(`/bookings/receipts.pdf?year=${new Date().getUTCFullYear()}`);
    expect(all.statusCode).toBe(200);
    expect(all.rawPayload.toString('latin1')).toContain('/Count 1');
    expect((await get('/bookings/receipts.pdf?year=2020')).json()).toEqual({ error: 'no_receipt' });
  });

  it('emails the receipt with the PDF attached, to the customer\x27s own address only', async () => {
    const { bookingId } = await completedJob();
    expect((await post(`/bookings/${bookingId}/receipt/email`)).json()).toEqual({ error: 'no_email' });
    await t.pool.query("UPDATE users SET email = 'sara@example.com' WHERE phone = '+4915100000001'");
    const sent = await post(`/bookings/${bookingId}/receipt/email`);
    expect(sent.json()).toEqual({ sentTo: 'sara@example.com' });
    const email = t.emails.at(-1) as { to: string; subject: string; text: string; attachments?: { filename: string; contentType: string; content: Buffer }[] };
    expect(email).toMatchObject({ to: 'sara@example.com', subject: expect.stringMatching(/^Your MISK receipt R-\d+$/) });
    expect(email.text).toContain('Lawn mowing');
    expect(email.text).toContain('Prices include VAT.');
    expect(email.attachments?.[0]).toMatchObject({ contentType: 'application/pdf', filename: expect.stringMatching(/\.pdf$/) });
    expect(email.attachments?.[0]?.content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('the bookings list (D67)', () => {
  it('tells each row what it offers: receipt, report, unread chat, and the category to book again', async () => {
    const { bookingId, pro } = await completedJob();
    await post(`/pro/jobs/${bookingId}/messages`, { body: 'All done, have a look!' }, pro.cookie);
    const listed = (await get('/bookings')).json();
    expect(listed.planVisits).toEqual([]);
    expect(listed.bookings[0]).toMatchObject({
      id: bookingId,
      status: 'completed',
      hasReceipt: true,
      canReportProblem: true,
      problemOpen: false,
      unreadMessages: 1,
      paymentStatus: 'held',
      categorySlug: expect.any(String),
      categoryIcon: 'leaf',
    });
    await get(`/bookings/${bookingId}/messages`);
    await post(`/bookings/${bookingId}/problem`, { note: 'Poor quality: edges not cut' });
    expect((await get('/bookings')).json().bookings[0]).toMatchObject({ unreadMessages: 0, canReportProblem: false, problemOpen: true });
    expect((await get(`/bookings/${bookingId}/receipt`)).json().receipt.state).toBe('on_hold');
  });
});

describe('rating with a written review (D67)', () => {
  it('saves stars, tags and the review', async () => {
    const { bookingId } = await completedJob();
    const rated = await post(`/bookings/${bookingId}/rating`, { stars: 5, tags: ['on_time', 'tidy'], review: '  Lovely work.  ' });
    expect(rated.statusCode).toBe(201);
    expect(rated.json().booking.rating).toMatchObject({ stars: 5, tags: ['on_time', 'tidy'], review: 'Lovely work.' });
    expect((await post(`/bookings/${bookingId}/rating`, { stars: 4, review: 'x'.repeat(1001) })).statusCode).toBe(400);
  });
});

describe('the PDF writer', () => {
  it('escapes brackets and maps the euro sign', () => {
    expect(pdfString('Total (incl. VAT): €12')).toBe('(Total \\(incl. VAT\\): \\20012)');
    expect(pdfString('Mähen')).toBe('(M\\344hen)');
  });

  it('points every object at its exact byte offset', () => {
    const pdf = renderPdf([[{ text: 'Hello', x: 50, y: 50 }]], 'Test').toString('latin1');
    const xref = Number(pdf.match(/startxref\n(\d+)/)?.[1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((offset, index) => expect(pdf.slice(offset, offset + 10)).toMatch(new RegExp(`^${index + 1} 0 obj`)));
  });
});
