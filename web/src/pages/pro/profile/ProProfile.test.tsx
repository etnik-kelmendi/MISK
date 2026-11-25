import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProAvailability, ProProfile } from '../../../api/types';
import { BASE, fakeApi, renderAt, users, type FakeApi } from '../../../test/harness';
import type { BankSummary, Performance, ProDocumentView, ProfileOverview, ReviewsPage } from './types';

/** D100: the pro Profile and its pages. */

const user = () => userEvent.setup();

const availability: ProAvailability = {
  workStart: '08:00',
  workEnd: '18:00',
  workingDays: [1, 2, 3, 4, 5],
  holidays: [],
  daysOff: [],
  visitsOnDaysOff: [],
  jobsOnDaysOff: [],
  onlineNow: true,
  autoOffline: null,
  overrideUntil: null,
};

const profile: ProProfile = {
  status: 'approved',
  homePostcode: '10115',
  homeAddress: 'Linden Street 4',
  radiusKm: 12,
  workingDays: [1, 2, 3, 4, 5],
  reviewNote: null,
  payoutsEnabled: true,
  hasPayoutAccount: true,
  jobsPaused: false,
  suspendedReason: null,
  ratingAverage: 4.9,
  ratingCount: 212,
  photoId: null,
  trades: ['cat-garden'],
  tradeNames: ['Gardening'],
  pendingTrades: [],
  yearsExperience: 8,
  about: 'Gardener for 8 years.',
  documents: { id: null, certificate: null, insurance: null, background: null },
  availability,
};

const overview: ProfileOverview = { jobsDone: 212, documents: { expiring: 1, expired: 0, checking: 0 }, bankLast4: '1183', topPercent: 10 };

function proApi(changes: Partial<ProProfile> = {}, view: Partial<ProfileOverview> = {}): FakeApi {
  const api = fakeApi({ ...users.pro, lastName: 'Keller' });
  api.on('GET /pro/profile', { body: { profile: { ...profile, ...changes } } });
  api.on('GET /pro/profile/overview', { body: { overview: { ...overview, ...view } } });
  return api;
}

describe('the pro Profile', () => {
  it('shows photo, name, trades, stars, jobs and "Verified pro", then the Work, Performance and App groups with their summaries', async () => {
    proApi();
    renderAt('/pro/profile');
    const name = await screen.findByRole('heading', { level: 1, name: 'Daniel K.' });
    const head = name.closest('header');
    if (!head) throw new Error('No header');
    await waitFor(() => expect(head).toHaveTextContent('Gardening · ★ 4.9 · 212 jobs'));
    expect(within(head).getByText('Verified pro')).toBeInTheDocument();

    const rows = (label: string) =>
      within(screen.getByRole('list', { name: label }))
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]);
    await waitFor(() => expect(screen.getByRole('link', { name: /Documents/ })).toHaveTextContent('1 expiring'));
    expect(rows('Work')).toEqual([
      ['Personal information', '/pro/profile/personal'],
      ['Work information', '/pro/profile/work'],
      ['Availability08:00–18:00', '/pro/availability'],
      ['Documents1 expiring', '/pro/profile/documents'],
      ['Bank account•••• 1183', '/pro/profile/bank'],
    ]);
    expect(rows('Performance')).toEqual([
      ['Ratings & reviews4.9 ★', '/pro/profile/ratings'],
      ['PerformanceTop 10%', '/pro/profile/performance'],
    ]);
    expect(rows('App')).toEqual([
      ['Notifications', '/pro/profile/notifications'],
      ['Help & support', '/pro/profile/help'],
      ['Terms', '/pro/profile/terms'],
      ['Switch to customer app', '/'],
    ]);
  });

  it('shows "Holiday set" while a holiday is planned, and no Verified badge before approval', async () => {
    proApi({ status: 'pending_approval', availability: { ...availability, holidays: [{ id: 'h1', startsOn: '2026-12-20', endsOn: '2026-12-31' }] } });
    renderAt('/pro/profile');
    expect(await screen.findByRole('link', { name: /Availability/ })).toHaveTextContent('Holiday set');
    expect(screen.queryByText('Verified pro')).not.toBeInTheDocument();
  });

  it('opens a section page from its row, switches to the customer Home with the same account, and logs out', async () => {
    const api = proApi();
    api.on('GET /pro/performance', { body: { performance: performanceOf() } });
    api.on('POST /auth/logout', { status: 204 });
    renderAt('/pro/profile');
    await user().click(await screen.findByRole('link', { name: /Performance/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Performance' })).toBeInTheDocument();
    await user().click(screen.getByRole('link', { name: 'Back' }));

    await user().click(await screen.findByRole('link', { name: 'Switch to customer app' }));
    expect(await screen.findByRole('navigation', { name: /menu/i })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Pro menu' })).not.toBeInTheDocument();
  });

  it('logs out and opens Sign in', async () => {
    const api = proApi();
    api.on('POST /auth/logout', { status: 204 });
    renderAt('/pro/profile');
    await user().click(await screen.findByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(api.calls).toContain('POST /auth/logout'));
    expect(await screen.findByRole('heading', { level: 1, name: /Sign in|Log in|Welcome/i })).toBeInTheDocument();
  });
});

describe('Personal information', () => {
  it('has the photo, name, phone number (changed with a texted code), email and language, and "Save changes"', async () => {
    proApi();
    renderAt('/pro/profile/personal');
    expect(await screen.findByRole('region', { name: 'Your photo' })).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('Daniel');
    expect(screen.getByLabelText('Language')).toBeInTheDocument();
    expect(screen.getByText(/\+4915100000002/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/pro/profile');
  });
});

describe('Work information', () => {
  it('saves trades, experience, About you, the private home address and the travel distance', async () => {
    const api = proApi();
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    api.on('PATCH /pro/profile', ({ body }) => ({ body: { profile: { ...profile, ...(body as object), pendingTrades: [] } } }));
    renderAt('/pro/profile/work');
    const trade = await screen.findByRole('button', { name: 'Gardening' });
    expect(trade).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('A new trade is checked by MISK before you get jobs in it')).toBeInTheDocument();
    expect(screen.getByLabelText('Years of experience')).toHaveValue('8');
    const about = screen.getByLabelText('About you');
    expect(about).toHaveValue('Gardener for 8 years.');
    expect(about).toHaveAccessibleDescription(/Customers see this/);
    expect(screen.getByLabelText('Street and house number')).toHaveAccessibleDescription(/Customers never see it/);
    const radius = screen.getByRole('slider');
    expect(radius).toHaveAttribute('min', '3');
    expect(radius).toHaveAttribute('max', '30');

    await user().clear(screen.getByLabelText('Years of experience'));
    await user().type(screen.getByLabelText('Years of experience'), '9');
    await user().type(about, ' Lawns.');
    await user().click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.bodies['PATCH /pro/profile']).toEqual({ yearsExperience: 9, about: 'Gardener for 8 years. Lawns.' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
  });

  it('marks a new trade as being checked and asks for at least one trade', async () => {
    const api = proApi({ trades: ['cat-garden'], pendingTrades: ['cat-garden'] });
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    renderAt('/pro/profile/work');
    const trade = await screen.findByRole('button', { name: /Gardening/ });
    expect(trade).toHaveTextContent('Gardening · being checked');
    await user().click(trade);
    await user().click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Choose at least one trade.')).toBeInTheDocument();
  });
});

function doc(overrides: Partial<ProDocumentView>): ProDocumentView {
  return { kind: 'id', status: 'valid', expiresOn: '2031-05-01', expires: true, fileName: 'passport.jpg', notAccepted: false, reviewNote: null, required: true, ...overrides };
}

describe('Documents', () => {
  it('shows each document with its name, status and date, "Expiring soon" in orange, and uploads a new copy', async () => {
    const api = proApi();
    let insurance = doc({ kind: 'insurance', status: 'expiring', expiresOn: '2026-12-10', fileName: 'insurance.png' });
    api.on('GET /pro/documents', () => ({
      body: { documents: [doc({}), doc({ kind: 'certificate', expiresOn: null, expires: false }), insurance] },
    }));
    api.on('POST /pro/documents/insurance', () => {
      insurance = { ...insurance, status: 'checking', expiresOn: '2027-12-01' };
      return { status: 201, body: { profile } };
    });
    renderAt('/pro/profile/documents');
    const list = await screen.findByRole('list', { name: 'Documents' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('ID card or passport');
    expect(items[0]).toHaveTextContent('Valid until 1 May 2031');
    expect(within(items[0] as HTMLElement).getByText('Valid')).toHaveClass('badge', 'g');
    expect(items[1]).toHaveTextContent('No expiry date');
    const expiring = within(items[2] as HTMLElement).getByText('Expiring soon');
    expect(expiring).toHaveClass('badge', 'a');
    expect(items[2]).toHaveTextContent('Valid until 10 Dec 2026');
    expect(screen.getByText('If a required document runs out, you get no new jobs until MISK has accepted the new one')).toBeInTheDocument();
    expect(screen.getByText(/30 days and 7 days before/)).toBeInTheDocument();

    await user().click(within(items[2] as HTMLElement).getByRole('button', { name: /Upload new/ }));
    const date = within(items[2] as HTMLElement).getByLabelText('Valid until');
    await user().type(date, '2027-12-01');
    await user().upload(within(items[2] as HTMLElement).getByLabelText(/Choose file/), new File(['x'], 'new.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(api.calls).toContain('POST /pro/documents/insurance'));
    expect(await within(list).findByText('Being checked')).toBeInTheDocument();
    expect(list).toHaveTextContent('New copy valid until 1 Dec 2027 · being checked');
  });
});

function bankSummary(overrides: Partial<BankSummary> = {}): BankSummary {
  return {
    hasPayoutAccount: true,
    payoutsEnabled: true,
    bank: { last4: '1183', holderName: 'Daniel Keller', active: true },
    bankError: false,
    interval: 'weekly',
    nextPayoutOn: '2026-11-27',
    nextPayoutCents: 12450,
    statementYears: [2026, 2025],
    defaultStatementYear: 2025,
    ...overrides,
  };
}

describe('Bank account', () => {
  it('shows the account with "Active", the schedule set by MISK, the next payout, the tax statement and the change link', async () => {
    const api = proApi();
    api.on('GET /pro/bank', { body: { bank: bankSummary() } });
    api.on('POST /pro/bank/change-link', { body: { url: 'https://connect.example.com/express/acct_1' } });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    renderAt('/pro/profile/bank');
    const card = await screen.findByRole('region', { name: 'Your bank account' });
    expect(card).toHaveTextContent('•••• •••• 1183');
    expect(card).toHaveTextContent('Daniel Keller');
    expect(card).toHaveTextContent('Active');
    const payouts = screen.getByRole('list', { name: 'Payouts' });
    expect(payouts).toHaveTextContent('Payout scheduleWeekly on Fridays, set by MISK');
    expect(payouts).toHaveTextContent('Next payout27 Nov 2026 · €124.50');
    const statement = screen.getByRole('link', { name: 'Download the yearly statement for taxes 2025 (PDF)' });
    expect(statement).toHaveAttribute('href', `${BASE}/pro/earnings/tax-statement?year=2025`);
    await user().selectOptions(screen.getByLabelText('Year'), '2026');
    expect(screen.getByRole('link', { name: /2026/ })).toHaveAttribute('href', `${BASE}/pro/earnings/tax-statement?year=2026`);
    expect(screen.getByText(/A new account is checked before the next payout/)).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Change bank account' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://connect.example.com/express/acct_1'));
    vi.unstubAllGlobals();
  });

  it('says "Being checked" while the provider checks a new account', async () => {
    const api = proApi();
    api.on('GET /pro/bank', { body: { bank: bankSummary({ bank: { last4: '7788', holderName: 'Daniel Keller', active: false } }) } });
    renderAt('/pro/profile/bank');
    const card = await screen.findByRole('region', { name: 'Your bank account' });
    expect(card).toHaveTextContent('Being checked');
    expect(card).not.toHaveTextContent('Active');
  });
});

function reviewsPage(): ReviewsPage {
  return {
    summary: {
      average: 4.9,
      count: 212,
      stars: [
        { stars: 5, count: 182, pct: 86 },
        { stars: 4, count: 21, pct: 10 },
        { stars: 3, count: 6, pct: 3 },
        { stars: 2, count: 3, pct: 1 },
        { stars: 1, count: 0, pct: 0 },
      ],
      tags: [
        { tag: 'on_time', count: 184 },
        { tag: 'tidy', count: 171 },
      ],
    },
    reviews: [
      { bookingId: 'b1', stars: 5, tags: [], review: 'Lawn looks perfect, very tidy.', customerName: 'Lena', createdAt: '2026-11-20T10:00:00.000Z', reply: null, repliedAt: null },
      { bookingId: 'b2', stars: 4, tags: [], review: 'Good work.', customerName: 'Ana', createdAt: '2026-11-10T10:00:00.000Z', reply: 'Thank you!', repliedAt: '2026-11-11T10:00:00.000Z' },
    ],
    hasMore: false,
    replyMaxLength: 500,
  };
}

describe('Ratings & reviews', () => {
  it('shows the average, the bars per star level, the tags and the latest reviews; a reply goes once', async () => {
    const api = proApi();
    api.on('GET /pro/reviews', { body: reviewsPage() });
    api.on('POST /pro/reviews/b1/reply', ({ body }) => ({
      body: { review: { ...reviewsPage().reviews[0], reply: (body as { text: string }).text, repliedAt: '2026-11-21T10:00:00.000Z' } },
    }));
    renderAt('/pro/profile/ratings');
    const summary = await screen.findByRole('region', { name: 'Your rating' });
    expect(summary).toHaveTextContent('4.9');
    expect(summary).toHaveTextContent('212 ratings');
    const bars = within(summary).getAllByRole('meter');
    expect(bars.map((bar) => [bar.getAttribute('aria-label'), bar.getAttribute('aria-valuenow')])).toEqual([
      ['5 stars', '86'],
      ['4 stars', '10'],
      ['3 stars', '3'],
      ['2 stars', '1'],
      ['1 star', '0'],
    ]);
    const tags = screen.getByRole('list', { name: 'Customers mention' });
    expect(within(tags).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['On time · 184', 'Tidy work · 171']);

    const reviews = within(screen.getByRole('list', { name: 'Latest reviews' })).getAllByRole('listitem');
    expect(reviews[0]).toHaveTextContent('Lena · 20 Nov 2026');
    expect(reviews[0]).toHaveTextContent('Lawn looks perfect, very tidy.');
    expect(within(reviews[0] as HTMLElement).getByRole('img', { name: '5 stars' })).toBeInTheDocument();
    // Already answered: the reply shows, and there is no second Reply.
    expect(reviews[1]).toHaveTextContent('Thank you!');
    expect(within(reviews[1] as HTMLElement).queryByRole('button', { name: /Reply/ })).not.toBeInTheDocument();

    await user().click(within(reviews[0] as HTMLElement).getByRole('button', { name: /Reply/ }));
    await user().click(screen.getByRole('button', { name: 'Send reply' }));
    expect(await screen.findByText('Write your reply first.')).toBeInTheDocument();
    await user().type(screen.getByLabelText('Your reply to Lena'), 'Thanks, Lena!');
    await user().click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(api.bodies['POST /pro/reviews/b1/reply']).toEqual({ text: 'Thanks, Lena!' }));
    expect(await screen.findByText('Thanks, Lena!')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Reply/ })).not.toBeInTheDocument();
  });
});

function performanceOf(overrides: Partial<Performance> = {}): Performance {
  return {
    windowDays: 30,
    acceptance: { value: 96, goal: 85, belowGoal: false, basis: 25 },
    onTime: { value: 84, goal: 90, belowGoal: true, basis: 20 },
    completion: { value: 100, goal: 98, belowGoal: false, basis: 20 },
    lateCancellations: { value: 1, limit: 3, belowGoal: false },
    rating: { value: 4.3, goal: 4.5, belowGoal: true, basis: 1 },
    rank: { trade: 'Gardening', pros: 12, topPercent: 10 },
    ...overrides,
  };
}

describe('Performance', () => {
  it('shows the top message, each number with its bar and goal, and the numbers below goal in red', async () => {
    const api = proApi();
    api.on('GET /pro/performance', { body: { performance: performanceOf() } });
    renderAt('/pro/profile/performance');
    const message = (await screen.findByText(/top 10% of Gardening pros/)).closest('.info');
    expect(message).toHaveTextContent("You're in the top 10% of Gardening pros this month, so you're offered new jobs first.");
    const card = (name: string) => screen.getByRole('region', { name });
    expect(card('Acceptance rate')).toHaveTextContent('96%');
    expect(card('Acceptance rate')).toHaveTextContent('Goal 85%');
    expect(card('Acceptance rate')).not.toHaveClass('below');
    expect(card('On time')).toHaveTextContent('Goal 90%');
    expect(card('On time')).toHaveClass('below');
    expect(within(card('On time')).getByText('84%')).toHaveClass('error-strong');
    expect(card('Completed jobs')).toHaveTextContent('Goal 98%');
    expect(card('Late cancellations')).toHaveTextContent('1 of 3');
    expect(card('Rating')).toHaveTextContent('Below 4.5 for 30 days leads to a quality check by the MISK team');
    expect(card('Rating')).toHaveClass('below');
    expect(within(card('On time')).getByRole('meter')).toHaveAttribute('aria-valuenow', '84');
  });

  it('encourages a pro who is not in the top', async () => {
    const api = proApi();
    api.on('GET /pro/performance', { body: { performance: performanceOf({ rank: { trade: 'Gardening', pros: 12, topPercent: null } }) } });
    renderAt('/pro/profile/performance');
    expect(await screen.findByText(/The pros with the best numbers are offered new jobs first./)).toBeInTheDocument();
    expect(screen.queryByText(/top 10%/)).not.toBeInTheDocument();
  });
});

describe('Notifications', () => {
  it('has a switch with an explanation for each kind of message, and saves a change', async () => {
    const api = proApi();
    api.on('GET /pro/notifications', {
      body: { topics: { job_offers: true, offer_sound: true, schedule_changes: true, payouts: true, tips_news: false } },
    });
    api.on('PATCH /pro/notifications', ({ body }) => ({
      body: { topics: { job_offers: true, offer_sound: true, schedule_changes: true, payouts: true, tips_news: false, ...(body as object) } },
    }));
    renderAt('/pro/profile/notifications');
    const switches = await screen.findAllByRole('switch');
    expect(switches).toHaveLength(5);
    expect(screen.getByRole('switch', { name: 'New job offers' })).toHaveAccessibleDescription(/may miss them/);
    expect(screen.getByRole('switch', { name: 'Offer sound' })).toHaveAccessibleDescription(
      "Plays a sound for new offers. Your phone's settings decide whether it sounds on silent.",
    );
    expect(screen.getByRole('switch', { name: 'Schedule changes' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Payouts' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Tips & news' })).not.toBeChecked();
    expect(screen.getByText(/payments, safety, your documents and your account are always sent/)).toBeInTheDocument();
    await user().click(screen.getByRole('switch', { name: 'New job offers' }));
    await waitFor(() => expect(api.bodies['PATCH /pro/notifications']).toEqual({ job_offers: false }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'New job offers' })).not.toBeChecked());
  });
});

const helpFacts = {
  payoutInterval: 'weekly',
  releaseHours: 24,
  notHomeWaitMinutes: 15,
  callOutFeeCents: 1500,
  freeCancelHours: 24,
  lateCancelLimit: 3,
  lateCancelWindowDays: 30,
  lateCancelPauseDays: 7,
  goals: { acceptancePct: 85, onTimePct: 90, completionPct: 98, rating: 4.5 },
};

describe('Help & support', () => {
  it('lists the pro questions, opens an answer under its question, and always shows Chat with us and Call', async () => {
    const api = proApi();
    api.on('GET /pro/help', { body: { help: { ...helpFacts, support: { email: null, phone: null } } } });
    renderAt('/pro/profile/help');
    const list = await screen.findByRole('list', { name: 'Common questions' });
    const questions = within(list).getAllByRole('button');
    expect(questions.map((q) => q.textContent)).toEqual([
      'When do I get paid?',
      "What if the customer isn't home?",
      'Can I cancel a job?',
      'How do I get more jobs?',
    ]);
    await user().click(questions[1] as HTMLElement);
    expect(questions[1]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/After 15 minutes you can leave and you get the call-out fee of €15/)).toBeVisible();
    await user().click(questions[2] as HTMLElement);
    expect(screen.getByText(/3 within 30 days pause new offers for 7 days/)).toBeVisible();
    await user().click(questions[0] as HTMLElement);
    expect(screen.getByText(/24 h after the job.*weekly on fridays/)).toBeVisible();

    // No contact set up: both buttons are still there and explain how to reach the team.
    await user().click(screen.getByRole('button', { name: 'Call' }));
    expect(await screen.findByText(/Reply to any message from MISK/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chat with us' })).toBeInTheDocument();
  });

  it('emails and calls the team when the contacts are set up', async () => {
    const api = proApi();
    api.on('GET /pro/help', { body: { help: { ...helpFacts, support: { email: 'help@example.com', phone: '+493012345678' } } } });
    renderAt('/pro/profile/help');
    expect(await screen.findByRole('link', { name: 'Chat with us' })).toHaveAttribute('href', 'mailto:help@example.com?subject=Help%20with%20MISK%20(pro)');
    expect(screen.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:+493012345678');
  });
});

describe('Terms & conditions', () => {
  it('links the pro terms, privacy policy, code of conduct and cancellation rules, and emails the data on request', async () => {
    const api = proApi();
    let pending = false;
    api.on('GET /account/data-export', () => ({
      body: { export: { email: 'd•••@example.com', pending, requestedAt: null, sentAt: null, nextAllowedAt: null } },
    }));
    api.on('POST /account/data-export', () => {
      pending = true;
      return { status: 202, body: { export: { email: 'd•••@example.com', pending: true, requestedAt: '2026-11-25T10:00:00.000Z', sentAt: null, nextAllowedAt: '2026-11-26T10:00:00.000Z' } } };
    });
    renderAt('/pro/profile/terms');
    const list = await screen.findByRole('list', { name: 'Terms & conditions' });
    expect(within(list).getByRole('link', { name: 'Pro terms' })).toHaveAttribute('href', '/terms#terms-pros');
    expect(within(list).getByRole('link', { name: 'Code of conduct' })).toHaveAttribute('href', '/terms#terms-conduct');
    expect(within(list).getByRole('link', { name: 'Cancellation rules' })).toHaveAttribute('href', '/terms#terms-proCancelling');
    expect(within(list).getByText('Privacy Policy').closest('li')).toHaveTextContent('Coming soon');
    await user().click(await within(list).findByRole('button', { name: 'Email me my data' }));
    await waitFor(() => expect(api.calls).toContain('POST /account/data-export'));
    expect(await within(list).findByText("We'll email your data to d•••@example.com within 48 hours.")).toBeInTheDocument();
  });

  it('asks for an email address first', async () => {
    const api = proApi();
    api.on('GET /account/data-export', { body: { export: { email: null, pending: false, requestedAt: null, sentAt: null, nextAllowedAt: null } } });
    renderAt('/pro/profile/terms');
    expect(await screen.findByRole('link', { name: 'Add an email address' })).toHaveAttribute('href', '/pro/profile/personal');
    expect(screen.queryByRole('button', { name: 'Email me my data' })).not.toBeInTheDocument();
  });

  it('opens the code of conduct and the cancellation rules in the terms', async () => {
    proApi();
    renderAt('/terms');
    expect(await screen.findByRole('heading', { name: '9. Code of conduct for pros' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '10. Cancellation rules for pros' })).toBeInTheDocument();
    expect(screen.getByText(/3 late cancellations within 30 days pause new job offers for a week/)).toBeInTheDocument();
  });
});
