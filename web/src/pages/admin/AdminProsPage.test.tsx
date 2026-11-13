import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminProDetail, AdminProListItem, AdminProSummary, ProCheck } from '../../api/types';
import { fakeApi, renderAt, users } from '../../test/harness';

const user = () => userEvent.setup();
const PRO_ID = '33333333-3333-4333-8333-333333333333';

const summary: AdminProSummary = {
  kpis: { activePros: 6, onlineNow: 2, avgAcceptancePct: 91, documentsExpiring: 1 },
  counts: { applications: 2, active: 6, pending_approval: 1, suspended: 1 },
  inviteUrl: 'http://localhost:5173/signin?as=pro&method=phone',
};

function listItem(overrides: Partial<AdminProListItem> = {}): AdminProListItem {
  return {
    id: PRO_ID,
    firstName: 'Erion',
    lastName: 'Krasniqi',
    status: 'submitted',
    trades: ['Gardening'],
    submittedAt: '2026-11-07T10:00:00.000Z',
    suspendedAt: null,
    suspendedReason: null,
    reviewNote: null,
    jobsPaused: false,
    watchList: false,
    checksDone: 4,
    checksTotal: 4,
    ready: true,
    expiringDocument: false,
    expiredDocument: false,
    waitingDocuments: 0,
    jobs30: 0,
    acceptancePct: null,
    onTimePct: null,
    regularCustomers: 0,
    ratingAverage: null,
    ratingCount: 0,
    qualityReasons: [],
    ...overrides,
  };
}

function check(kind: ProCheck['kind'], overrides: Partial<ProCheck> = {}): ProCheck {
  return {
    kind,
    ok: true,
    state: 'valid',
    document: {
      uploadId: `file-${kind}`,
      fileName: `${kind}.pdf`,
      uploadedAt: '2026-11-07T10:00:00.000Z',
      expiresOn: kind === 'insurance' ? '2027-11-01' : null,
      reviewStatus: 'accepted',
      reviewNote: null,
      reviewedAt: '2026-11-08T10:00:00.000Z',
      validUntil: kind === 'insurance' ? '2027-11-01' : 'infinity',
    },
    ...overrides,
  };
}

function docOf(kind: ProCheck['kind']) {
  const doc = check(kind).document;
  if (!doc) throw new Error('test document missing');
  return doc;
}

function detail(overrides: Partial<AdminProDetail> = {}): AdminProDetail {
  return {
    id: PRO_ID,
    firstName: 'Erion',
    lastName: 'Krasniqi',
    phone: '+4915200000010',
    email: null,
    status: 'submitted',
    homePostcode: '10961',
    postcodeName: 'Kreuzberg',
    radiusKm: 12,
    workingDays: [1, 2, 3, 4, 5, 6],
    trades: ['Gardening'],
    submittedAt: '2026-11-07T10:00:00.000Z',
    reviewNote: null,
    suspendedAt: null,
    suspendedReason: null,
    jobsPausedAt: null,
    watchListAt: null,
    coachingCallAt: null,
    payoutsEnabled: false,
    hasPayoutAccount: false,
    earnedThisMonthCents: 0,
    checks: [check('id'), check('certificate'), check('insurance'), check('background')],
    allChecksOk: true,
    regulars: [],
    reviews: [],
    payouts: [],
    bank: null,
    actions: [],
    jobs30: 0,
    acceptancePct: null,
    onTimePct: null,
    regularCustomers: 0,
    ratingAverage: null,
    ratingCount: 0,
    qualityReasons: [],
    ...overrides,
  };
}

function setUp(pros: AdminProListItem[] = [listItem()]) {
  const api = fakeApi(users.admin);
  api.on('GET /admin/pros/summary', { body: summary });
  api.on('GET /admin/pros', { body: { pros } });
  api.on(`GET /admin/pros/${PRO_ID}`, { body: { pro: detail() } });
  api.on('GET /admin/badges', { body: { applications: 2 } });
  return api;
}

function lastListQuery() {
  const urls = vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([input]) => new URL(String(input)))
    .filter((url) => url.pathname === '/admin/pros');
  return urls.at(-1)?.searchParams;
}

describe('providers page', () => {
  it('shows the four key numbers, tabs with counts, and a red menu badge for waiting applications', async () => {
    setUp();
    renderAt('/admin/providers');
    for (const [label, value] of [
      ['Active pros', '6'],
      ['Online right now', '2'],
      ['Avg. acceptance', '91%'],
      ['Documents expiring', '1'],
    ] as const) {
      const kpi = (await screen.findByText(label)).parentElement as HTMLElement;
      await waitFor(() => expect(kpi).toHaveTextContent(value));
    }
    const tabs = screen.getByRole('group', { name: 'Show providers' });
    await waitFor(() =>
      expect(within(tabs).getAllByRole('button').map((b) => b.textContent)).toEqual([
        'Applications (2)',
        'Active (6)',
        'Pending approval (1)',
        'Suspended (1)',
      ]),
    );
    const nav = screen.getByRole('navigation', { name: 'Control panel' });
    expect(await within(nav).findByText('2 applications waiting')).toBeInTheDocument();
  });

  it('copies the invite link', async () => {
    setUp();
    // user-event puts its own clipboard in place, which keeps what the page copies.
    const u = user();
    renderAt('/admin/providers');
    const invite = await screen.findByRole('button', { name: 'Invite pro' });
    await waitFor(() => expect(invite).toBeEnabled());
    await u.click(invite);
    expect(await navigator.clipboard.readText()).toBe(summary.inviteUrl);
    expect(await screen.findByText('Invite link copied. Send it to the pro.')).toBeInTheDocument();
  });

  it('lists applications with trade, date applied and checks done, marking complete ones Ready', async () => {
    setUp([listItem(), listItem({ id: 'p2', firstName: 'Luan', lastName: null, checksDone: 2, ready: false, status: 'info_requested' })]);
    renderAt('/admin/providers');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Trade', 'Applied', 'Checks']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Erion Krasniqi');
    expect(rows[0]).toHaveTextContent('Ready');
    expect(rows[0]).toHaveTextContent('7 Nov 2026');
    expect(rows[0]).toHaveTextContent('4 of 4 done');
    expect(rows[1]).toHaveTextContent('Info requested');
    expect(rows[1]).toHaveTextContent('2 of 4 done');
    expect(rows[1]).not.toHaveTextContent('Ready');
  });

  it('shows active pros with numbers, low ones in red, and icons for warnings and expiring documents', async () => {
    setUp([
      listItem({
        status: 'approved',
        jobs30: 12,
        acceptancePct: 70,
        onTimePct: 95,
        regularCustomers: 3,
        qualityReasons: ['low_acceptance'],
        expiringDocument: true,
        watchList: true,
      }),
    ]);
    renderAt('/admin/providers?tab=active');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Name',
      'Trade',
      'Jobs (30 days)',
      'Acceptance',
      'On time',
      'Regular customers',
      'Status',
    ]);
    expect(within(table).getByText('70%')).toHaveClass('low');
    expect(within(table).getByText('95%')).not.toHaveClass('low');
    expect(within(table).getByRole('img', { name: 'Quality warning' })).toBeInTheDocument();
    expect(within(table).getByRole('img', { name: 'Document expiring' })).toBeInTheDocument();
    expect(within(table).getByText('Watch list')).toBeInTheDocument();
    expect(lastListQuery()?.get('tab')).toBe('active');
  });

  it('lists suspended pros with reason and date', async () => {
    setUp([listItem({ status: 'suspended', suspendedAt: '2026-11-04T10:00:00.000Z', suspendedReason: 'Damage reports' })]);
    renderAt('/admin/providers?tab=suspended');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Trade', 'Reason', 'Suspended on']);
    expect(within(table).getByText('Damage reports')).toBeInTheDocument();
    expect(within(table).getByText('4 Nov 2026')).toBeInTheDocument();
  });
});

describe('pro side panel', () => {
  it('opens on a click and closes with ×, Esc and a click outside', async () => {
    setUp();
    renderAt('/admin/providers');
    await user().click(await screen.findByRole('button', { name: 'Open Erion Krasniqi' }));
    let dialog = await screen.findByRole('dialog', { name: 'Erion Krasniqi' });
    await user().click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user().click(screen.getByRole('button', { name: 'Open Erion Krasniqi' }));
    await screen.findByRole('dialog');
    await user().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user().click(screen.getByRole('button', { name: 'Open Erion Krasniqi' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows travel distance, working days and the four checks with OK or Open and an explanation', async () => {
    const api = setUp();
    api.on(`GET /admin/pros/${PRO_ID}`, {
      body: {
        pro: detail({
          allChecksOk: false,
          checks: [
            check('id'),
            check('certificate', { ok: false, state: 'rejected', document: { ...docOf('certificate'), reviewStatus: 'rejected', reviewNote: 'Blurry' } }),
            check('insurance'),
            check('background', { ok: false, state: 'missing', document: null }),
          ],
        }),
      },
    });
    renderAt(`/admin/providers?open=${PRO_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'Erion Krasniqi' });
    expect(within(dialog).getByText('12 km')).toBeInTheDocument();
    expect(within(dialog).getByText('Mon, Tue, Wed, Thu, Fri, Sat')).toBeInTheDocument();
    const checks = within(dialog).getAllByRole('listitem').filter((li) => li.closest('.check-list'));
    expect(checks.map((li) => within(li).getByText(/ID verified|Trade certificate|Liability insurance|Background check/).textContent)).toEqual([
      'ID verified',
      'Trade certificate',
      'Liability insurance',
      'Background check',
    ]);
    expect(checks[0]).toHaveTextContent('OK');
    expect(checks[0]).toHaveTextContent('Checked. Does not run out.');
    expect(checks[1]).toHaveTextContent('Open');
    expect(checks[1]).toHaveTextContent('New copy asked for: Blurry');
    expect(checks[2]).toHaveTextContent('Valid until 1 Nov 2027');
    expect(checks[3]).toHaveTextContent('Not uploaded yet.');
    expect(within(checks[3] as HTMLElement).getByRole('button', { name: 'Send reminder about Background check' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('approves a pro whose checks are all OK', async () => {
    const api = setUp();
    api.on(`POST /admin/pros/${PRO_ID}/approve`, { body: { pro: detail({ status: 'approved' }) } });
    renderAt(`/admin/providers?open=${PRO_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'Erion Krasniqi' });
    await user().click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(api.calls).toContain(`POST /admin/pros/${PRO_ID}/approve`);
    expect(await within(dialog).findByRole('heading', { name: 'Actions' })).toBeInTheDocument();
  });

  it('sends a request for more information with the message', async () => {
    const api = setUp();
    api.on(`POST /admin/pros/${PRO_ID}/request-info`, {
      body: { pro: detail({ status: 'info_requested', reviewNote: 'Send the back of your ID.' }) },
    });
    renderAt(`/admin/providers?open=${PRO_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'Erion Krasniqi' });
    await user().click(within(dialog).getByRole('button', { name: 'Request more info' }));
    const send = within(dialog).getByRole('button', { name: 'Send request' });
    await user().click(send);
    expect(within(dialog).getByText('Write a short note.')).toBeInTheDocument();
    expect(api.calls).not.toContain(`POST /admin/pros/${PRO_ID}/request-info`);
    await user().type(within(dialog).getByLabelText(/What do you need/), 'Send the back of your ID.');
    await user().click(send);
    expect(api.bodies[`POST /admin/pros/${PRO_ID}/request-info`]).toEqual({ message: 'Send the back of your ID.' });
    expect(await within(dialog).findByText('You asked: Send the back of your ID.')).toBeInTheDocument();
  });

  it('shows a quality warning with its reason and lets the team pause jobs and suspend', async () => {
    const api = setUp();
    const active = detail({
      status: 'approved',
      acceptancePct: 62,
      onTimePct: 97,
      qualityReasons: ['low_acceptance'],
      ratingAverage: 4.3,
      ratingCount: 12,
      jobs30: 9,
      earnedThisMonthCents: 41250,
      hasPayoutAccount: true,
      bank: { bankLast4: '3000', nextPayout: { amountCents: 12450, arrivesOn: '2026-11-13T00:00:00.000Z' } },
      regulars: [{ id: 's1', firstName: 'Sara', planName: 'Weekly lawn care', since: '2026-09-01T00:00:00.000Z' }],
    });
    api.on(`GET /admin/pros/${PRO_ID}`, { body: { pro: active } });
    api.on(`POST /admin/pros/${PRO_ID}/pause`, {
      body: {
        pro: {
          ...active,
          jobsPausedAt: '2026-11-09T10:00:00.000Z',
          actions: [{ id: '1', action: 'jobs_paused', details: {}, createdAt: '2026-11-09T10:00:00.000Z', adminName: 'admin' }],
        },
      },
    });
    api.on(`POST /admin/pros/${PRO_ID}/suspend`, {
      body: {
        pro: { ...active, status: 'suspended', suspendedAt: '2026-11-09T10:00:00.000Z', suspendedReason: 'Repeated no-shows' },
        handOver: { bookings: 2, plans: 1, plansWithoutPro: 0 },
      },
    });
    renderAt(`/admin/providers?tab=active&open=${PRO_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'Erion Krasniqi' });
    const warning = within(dialog).getByRole('region', { name: 'Quality warning' });
    expect(warning).toHaveTextContent('Accepts only 62% of job offers (target 85%).');
    expect(within(dialog).getByText('62%')).toHaveClass('low');
    expect(within(dialog).getByText('€412.50')).toBeInTheDocument();
    await user().click(within(dialog).getByRole('button', { name: /^Payouts/ }));
    expect(within(dialog).getByText('Ending in 3000')).toBeInTheDocument();
    expect(within(dialog).getByText('€124.50 on 13 Nov 2026')).toBeInTheDocument();
    await user().click(within(dialog).getByRole('button', { name: /^Regular customers/ }));
    expect(within(dialog).getByText('Sara · Weekly lawn care')).toBeInTheDocument();

    await user().click(within(dialog).getByRole('button', { name: 'Pause jobs' }));
    expect(await within(dialog).findByText('Paused new jobs')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Resume jobs' })).toBeInTheDocument();

    await user().click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await user().type(within(dialog).getByLabelText(/Why is the pro suspended/), 'Repeated no-shows');
    await user().click(within(dialog).getByRole('button', { name: 'Suspend and give their jobs to other pros' }));
    expect(api.bodies[`POST /admin/pros/${PRO_ID}/suspend`]).toEqual({ reason: 'Repeated no-shows' });
    expect(await within(dialog).findByText(/2 booked jobs went back to the search, 1 plans got a new pro/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Reinstate' })).toBeInTheDocument();
  });

  it('accepts a new document and sends a reminder for one running out', async () => {
    const api = setUp();
    const waiting = check('insurance', {
      ok: false,
      state: 'waiting_review',
      document: { ...docOf('insurance'), reviewStatus: 'pending', fileName: 'insurance-2027.pdf', expiresOn: '2027-12-01' },
    });
    const expiring = check('id', {
      state: 'expiring',
      document: { ...docOf('id'), expiresOn: '2026-11-20' },
    });
    const pending = detail({ status: 'pending_approval', checks: [expiring, check('certificate'), waiting, check('background')], allChecksOk: false });
    api.on(`GET /admin/pros/${PRO_ID}`, { body: { pro: pending } });
    api.on(`POST /admin/pros/${PRO_ID}/documents/insurance/accept`, {
      body: { pro: { ...pending, status: 'approved', checks: [expiring, check('certificate'), check('insurance'), check('background')] }, backToActive: true },
    });
    api.on(`POST /admin/pros/${PRO_ID}/documents/id/remind`, { body: { pro: pending } });
    renderAt(`/admin/providers?tab=pending_approval&open=${PRO_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'Erion Krasniqi' });
    expect(within(dialog).getByText(/insurance-2027\.pdf · uploaded 7 Nov 2026/)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/Valid until 1 Dec 2027/).length).toBeGreaterThan(0);

    await user().click(within(dialog).getByRole('button', { name: 'Send reminder about ID verified' }));
    expect(await within(dialog).findByText('Reminder sent by text.')).toBeInTheDocument();

    await user().click(within(dialog).getByRole('button', { name: 'Accept Liability insurance' }));
    expect(api.bodies[`POST /admin/pros/${PRO_ID}/documents/insurance/accept`]).toEqual({});
    expect(await within(dialog).findByText('All documents are fine again: the pro is back in Active.')).toBeInTheDocument();
  });

  it('turns Send reminder green once the reminder is sent, and keeps it so for an hour', async () => {
    const api = setUp();
    const expired = check('insurance', {
      ok: false,
      state: 'expired',
      document: { ...docOf('insurance'), expiresOn: '2026-10-01' },
    });
    const active = detail({ status: 'pending_approval', checks: [check('id'), check('certificate'), expired, check('background')], allChecksOk: false });
    const sentAt = new Date().toISOString();
    const reminded = {
      ...active,
      actions: [{ id: 'a1', action: 'reminder_sent' as const, details: { document: 'insurance' as const }, createdAt: sentAt, adminName: 'admin' }],
    };
    api.on(`GET /admin/pros/${PRO_ID}`, { body: { pro: active } });
    api.on(`POST /admin/pros/${PRO_ID}/documents/insurance/remind`, { body: { pro: reminded } });
    renderAt(`/admin/providers?tab=pending_approval&open=${PRO_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'Erion Krasniqi' });
    const send = within(dialog).getByRole('button', { name: 'Send reminder about Liability insurance' });
    expect(send).not.toHaveClass('sent');
    await user().click(send);

    const sent = await within(dialog).findByRole('button', { name: /^Reminder about the Liability insurance sent at \d{2}:\d{2}$/ });
    expect(sent).toHaveClass('sent');
    expect(sent).toBeDisabled();
    expect(sent).toHaveTextContent(/Reminder sent at \d{2}:\d{2}/);
    expect(api.calls.filter((c) => c === `POST /admin/pros/${PRO_ID}/documents/insurance/remind`)).toHaveLength(1);
  });

  it('puts documents, payouts, recent payouts, reviews and regular customers behind buttons, one open at a time', async () => {
    const api = setUp();
    const pro = detail({
      status: 'approved',
      hasPayoutAccount: true,
      bank: { bankLast4: '4321', nextPayout: { amountCents: 12000, arrivesOn: '2026-11-20' } },
      payouts: [{ amountCents: 3731, source: 'job', status: 'sent', createdAt: '2026-11-05T09:00:00.000Z' }],
      reviews: [
        { stars: 5, tags: [], service: 'Lawn mowing', customerName: 'Sara', createdAt: '2026-11-04T09:00:00.000Z' },
        { stars: 4, tags: [], service: 'Hedge trimming', customerName: 'Tom', createdAt: '2026-11-03T09:00:00.000Z' },
      ],
      regulars: [{ id: 's1', firstName: 'Sara', planName: 'Weekly lawn care', since: '2026-09-01T00:00:00.000Z' }],
    });
    api.on(`GET /admin/pros/${PRO_ID}`, { body: { pro } });
    renderAt(`/admin/providers?tab=active&open=${PRO_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'Erion Krasniqi' });
    const group = within(dialog).getByRole('group', { name: 'Profile sections' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'DocumentsOK',
      'Payouts€120',
      'Recent payouts1',
      'Reviews2',
      'Regular customers1',
    ]);
    // Everything is fine, so nothing is open and the panel stays short.
    for (const button of buttons) expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(within(dialog).queryByText('Lawn mowing', { exact: false })).not.toBeInTheDocument();

    const reviews = within(group).getByRole('button', { name: /^Reviews/ });
    await user().click(reviews);
    expect(reviews).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByRole('region', { name: /^Reviews/ })).toHaveTextContent('Lawn mowing');

    const payouts = within(group).getByRole('button', { name: /^Recent payouts/ });
    await user().click(payouts);
    expect(reviews).toHaveAttribute('aria-expanded', 'false');
    expect(within(dialog).getByRole('region', { name: /^Recent payouts/ })).toHaveTextContent('€37.31');
    await user().click(payouts);
    expect(within(dialog).queryByRole('region', { name: /^Recent payouts/ })).not.toBeInTheDocument();

    // The change log stays folded on its own.
    const log = within(dialog).getByRole('heading', { name: 'Activity log' }).closest('details') as HTMLDetailsElement;
    expect(log).not.toHaveAttribute('open');
  });

  it('opens Documents by itself when a document needs attention, and marks the button red', async () => {
    const api = setUp();
    const expired = check('insurance', { ok: false, state: 'expired', document: { ...docOf('insurance'), expiresOn: '2026-10-01' } });
    const pro = detail({ status: 'approved', checks: [check('id'), check('certificate'), expired, check('background')], allChecksOk: false });
    api.on(`GET /admin/pros/${PRO_ID}`, { body: { pro } });
    renderAt(`/admin/providers?tab=active&open=${PRO_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'Erion Krasniqi' });
    const documents = within(dialog).getByRole('button', { name: /^Documents/ });
    expect(documents).toHaveAttribute('aria-expanded', 'true');
    expect(documents.querySelector('.badge')).toHaveClass('r');
    expect(documents).toHaveTextContent('1 to check');
    expect(within(dialog).getByRole('button', { name: 'Send reminder about Liability insurance' })).toBeInTheDocument();
  });

  it('colours Send reminder green the moment it is clicked, before the answer arrives', async () => {
    const api = setUp();
    const expired = check('insurance', { ok: false, state: 'expired', document: { ...docOf('insurance'), expiresOn: '2026-10-01' } });
    const pro = detail({ status: 'pending_approval', checks: [check('id'), check('certificate'), expired, check('background')], allChecksOk: false });
    api.on(`GET /admin/pros/${PRO_ID}`, { body: { pro } });
    let answer: (value: { body: unknown }) => void = () => undefined;
    api.on(`POST /admin/pros/${PRO_ID}/documents/insurance/remind`, () => new Promise((resolve) => (answer = resolve)));
    renderAt(`/admin/providers?tab=pending_approval&open=${PRO_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'Erion Krasniqi' });
    const send = within(dialog).getByRole('button', { name: 'Send reminder about Liability insurance' });
    expect(send).toHaveClass('ghost');
    await user().click(send);
    expect(send).toHaveClass('sending');
    expect(send).not.toHaveClass('ghost');
    answer({ body: { pro } });
    await waitFor(() => expect(send).not.toHaveClass('sending'));
  });

  it('reinstates a suspended pro', async () => {
    const api = setUp();
    const suspended = detail({ status: 'suspended', suspendedAt: '2026-11-04T10:00:00.000Z', suspendedReason: 'Damage reports' });
    api.on(`GET /admin/pros/${PRO_ID}`, { body: { pro: suspended } });
    api.on(`POST /admin/pros/${PRO_ID}/reinstate`, { body: { pro: { ...suspended, status: 'approved', suspendedAt: null, suspendedReason: null } } });
    renderAt(`/admin/providers?tab=suspended&open=${PRO_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'Erion Krasniqi' });
    expect(within(dialog).getByText('Suspended on 4 Nov 2026: Damage reports')).toBeInTheDocument();
    await user().click(within(dialog).getByRole('button', { name: 'Reinstate' }));
    expect(await within(dialog).findByText('The pro is active again.')).toBeInTheDocument();
  });
});
