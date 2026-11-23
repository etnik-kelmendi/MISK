import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublicPlan, SavedAddress, Subscription, SubscriptionPause, SubscriptionVisit } from '../../api/types';
import { fakeApi, renderAt, users } from '../../test/harness';
import { firstVisitDay, todayIn } from '../../lib/plans';

const user = () => userEvent.setup();
/** The page's top bar, which carries the plan's status badge on My plan. */
const appbar = () => document.querySelector('.appbar') as HTMLElement;

/** D90: the customer Plans page, the Plan builder and My plan. */

const DAY = 24 * 3600 * 1000;
const future = (days: number, hours = 0) => new Date(Date.now() + days * DAY + hours * 3600 * 1000).toISOString();

/** Weekly lawn care at €49 for a medium garden: the server's price table for every frequency and size. */
const lawn: PublicPlan = {
  id: 'plan-lawn',
  name: 'Lawn care',
  categoryId: 'cat-garden',
  categoryName: 'Gardening',
  categoryIcon: 'leaf',
  priceCents: 4900,
  frequency: 'weekly',
  visitMinutes: 60,
  tasks: ['Mow', 'Edge', 'Blow paths'],
  addonName: 'Hedge trimming',
  addonPriceCents: 1500,
  seasonal: false,
  seasonFrom: null,
  seasonTo: null,
  minTermMonths: 3,
  pauseNoticeDays: 7,
  maxPauseWeeks: 4,
  proSharePct: 70,
  status: 'published',
  publishedAt: '',
  updatedAt: '',
  prices: {
    every_2_weeks: { S: 2499, M: 2940, L: 3969 },
    weekly: { S: 4165, M: 4900, L: 6615 },
    twice_weekly: { S: 7497, M: 8820, L: 11907 },
    three_times_weekly: { S: 10413, M: 12250, L: 16538 },
  },
  fromCents: 4165,
};

/** Home cleaning every 2 weeks, April to October, with a 1-month term and no pauses. */
const cleaning: PublicPlan = {
  ...lawn,
  id: 'plan-clean',
  name: 'Home cleaning',
  categoryId: 'cat-clean',
  categoryIcon: 'sparkle',
  priceCents: 6900,
  frequency: 'every_2_weeks',
  tasks: ['Kitchen', 'Bathrooms'],
  addonName: null,
  addonPriceCents: null,
  seasonal: true,
  seasonFrom: 4,
  seasonTo: 10,
  minTermMonths: 1,
  maxPauseWeeks: 0,
  prices: {
    every_2_weeks: { S: 5865, M: 6900, L: 9315 },
    weekly: { S: 9775, M: 11500, L: 15525 },
    twice_weekly: { S: 17595, M: 20700, L: 27945 },
    three_times_weekly: { S: 24438, M: 28750, L: 38813 },
  },
  fromCents: 5865,
};

function visit(overrides: Partial<SubscriptionVisit> = {}): SubscriptionVisit {
  return {
    id: 'v1',
    startsAt: future(3),
    endsAt: future(3, 1),
    status: 'planned',
    tasksDone: [],
    movedFrom: null,
    pendingMove: null,
    pausedBy: null,
    skippedAt: null,
    skipsUsedInMonth: 0,
    ...overrides,
  };
}

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-1',
    planId: 'plan-lawn',
    planName: 'Lawn care',
    categoryId: 'cat-garden',
    categoryIcon: 'leaf',
    tasks: ['Mow', 'Edge', 'Blow paths'],
    size: 'M',
    frequency: 'weekly',
    days: [2],
    timeWindow: 'morning',
    visitMinutes: 60,
    address: '12 Linden Street',
    postcode: '10115',
    notes: '',
    withAddon: true,
    addonName: 'Hedge trimming',
    priceCents: 6400,
    seasonal: false,
    seasonFrom: null,
    seasonTo: null,
    minTermMonths: 3,
    pauseNoticeDays: 7,
    maxPauseWeeks: 4,
    status: 'active',
    billingPaused: false,
    startedAt: future(-10),
    currentPeriodEnd: '2027-01-12T09:00:00.000Z',
    endsAt: null,
    createdAt: future(-10),
    proName: 'Daniel',
    cancelableFrom: '2027-02-12T09:00:00.000Z',
    firstVisitOn: null,
    nextVisitAt: future(3),
    minTermEndsAt: '2027-02-12T09:00:00.000Z',
    cancelEndsAt: '2027-02-12T09:00:00.000Z',
    skipsPerMonth: 2,
    skipsLeftThisMonth: 2,
    paymentMethod: { brand: 'visa', last4: '4242', wallet: null },
    visits: [visit(), visit({ id: 'v2', startsAt: future(10), endsAt: future(10, 1) })],
    pauses: [],
    ...overrides,
  };
}

function pauseRow(overrides: Partial<SubscriptionPause> = {}): SubscriptionPause {
  return {
    id: 'p1',
    startsOn: '2027-03-01',
    endsOn: '2027-03-15',
    weeks: 2,
    startsAt: '2027-02-28T23:00:00.000Z',
    endsAt: '2027-03-14T23:00:00.000Z',
    status: 'upcoming',
    visitsCalledOff: 2,
    visitCreditCents: 1488,
    creditCents: 2976,
    visitsRestored: 0,
    reversedCents: 0,
    createdAt: '',
    withdrawnAt: null,
    ...overrides,
  };
}

const address: SavedAddress = {
  id: 'a-home',
  label: 'Home',
  address: '12 Linden Street',
  postcode: '10115',
  areaName: 'Mitte',
  served: true,
  selected: true,
  createdAt: '2026-10-01T09:00:00.000Z',
};

describe('Plans page (D90)', () => {
  function plansApi(subscriptions: Subscription[] = [], plans: PublicPlan[] = [lawn, cleaning]) {
    const api = fakeApi(users.customer);
    api.on('GET /plans', { body: { plans } });
    api.on('GET /subscriptions', { body: { subscriptions } });
    return api;
  }

  it('shows each published plan with its icon, price a month, how often, months, tasks, extras and Choose', async () => {
    plansApi();
    renderAt('/plans');
    const card = (await screen.findByRole('heading', { name: 'Lawn care' })).closest('li') as HTMLElement;
    expect(card).toHaveTextContent('1× a week · All year');
    expect(card).toHaveTextContent('from€41.65/mo');
    expect(within(card).getByRole('list', { name: 'Done every visit of Lawn care' })).toHaveTextContent('Mow Edge Blow paths');
    expect(card).toHaveTextContent('Optional extras: Hedge trimming');
    expect(within(card).getByRole('link', { name: /Choose lawn care/ })).toHaveAttribute('href', '/plans/plan-lawn');

    const clean = (screen.getByRole('heading', { name: 'Home cleaning' }).closest('li') as HTMLElement);
    expect(clean).toHaveTextContent('Every 2 weeks · April – October');
    expect(clean).toHaveTextContent('Optional extras: No extras');
    expect(within(clean).getByRole('link', { name: /Choose home cleaning/ })).toHaveAttribute('href', '/plans/plan-clean');
    // No "My plan" card without a plan.
    expect(screen.queryByRole('link', { name: /My plan/ })).not.toBeInTheDocument();
  });

  it('switches to a side-by-side table, one column per plan, in a sideways scrolling region', async () => {
    plansApi();
    renderAt('/plans');
    const all = await screen.findByRole('button', { name: 'All plans' });
    const compare = screen.getByRole('button', { name: 'Compare side by side' });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(compare).toHaveAttribute('aria-pressed', 'false');
    await user().click(compare);
    expect(compare).toHaveAttribute('aria-pressed', 'true');

    const region = screen.getByRole('region', { name: 'All plans side by side' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveClass('table-scroll');
    const table = within(region).getByRole('table', { name: 'All plans side by side' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Lawn care', 'Home cleaning']);
    expect(within(table).getAllByRole('rowheader').map((h) => h.textContent)).toEqual([
      'From',
      'How often',
      'Season',
      'Each visit',
      'Extras',
      'Minimum term',
      'Holiday pause',
    ]);
    const row = (name: string) => within(table).getByRole('rowheader', { name }).closest('tr') as HTMLElement;
    expect(within(row('From')).getAllByRole('cell').map((c) => c.textContent)).toEqual(['from €41.65/mo', 'from €58.65/mo']);
    expect(within(row('Season')).getAllByRole('cell').map((c) => c.textContent)).toEqual(['All year', 'April – October']);
    expect(within(row('Extras')).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Hedge trimming (+€15/mo)', 'No extras']);
    expect(within(row('Minimum term')).getAllByRole('cell').map((c) => c.textContent)).toEqual(['3 months', '1 month']);
    expect(within(row('Holiday pause')).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      "up to 4 weeks a year, 7 days' notice",
      'not allowed',
    ]);
    expect(within(table).getByRole('link', { name: 'Choose lawn care' })).toHaveAttribute('href', '/plans/plan-lawn');
    expect(within(table).getByRole('link', { name: 'Choose home cleaning' })).toHaveAttribute('href', '/plans/plan-clean');
    expect(screen.getByText('Swipe sideways to see every plan.')).toBeInTheDocument();

    await user().click(all);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it("lists what every plan includes, with each plan's own term and pause rules where they differ", async () => {
    plansApi();
    renderAt('/plans');
    const box = await screen.findByRole('region', { name: 'Every plan includes' });
    expect(box).toHaveTextContent('The same verified pro every visit');
    expect(box).toHaveTextContent('Skip up to 2 visits a month');
    expect(box).toHaveTextContent("Holiday pause, by plan: Lawn care: up to 4 weeks a year, 7 days' notice · Home cleaning: not allowed");
    expect(box).toHaveTextContent("A minimum term, then cancel with 30 days' notice: Lawn care: 3 months · Home cleaning: 1 month");
    expect(box).toHaveTextContent('One monthly charge, never per visit');
  });

  it('gives the common rule once when every plan has the same terms', async () => {
    plansApi([], [lawn, { ...lawn, id: 'plan-2', name: 'Full garden care' }]);
    renderAt('/plans');
    const box = await screen.findByRole('region', { name: 'Every plan includes' });
    expect(box).toHaveTextContent("Holiday pause up to 4 weeks a year, 7 days' notice");
    expect(box).toHaveTextContent("Minimum 3 months, then cancel with 30 days' notice");
  });

  it('shows My plan at the top, with its status, opening My plan', async () => {
    plansApi([subscription()]);
    renderAt('/plans');
    const card = await screen.findByRole('link', { name: /My plan/ });
    expect(card).toHaveAttribute('href', '/my-plans/sub-1');
    expect(card).toHaveTextContent('Lawn care');
    expect(card).toHaveTextContent('€64/month');
    expect(within(card).getByText('Active')).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'My plan' });
    expect(section.compareDocumentPosition(screen.getByRole('button', { name: 'All plans' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says Ending and Paused on the My plan card', async () => {
    plansApi([
      subscription({ endsAt: '2027-02-12T09:00:00.000Z' }),
      subscription({ id: 'sub-2', pauses: [pauseRow({ status: 'running' })] }),
    ]);
    renderAt('/plans');
    const cards = await screen.findAllByRole('link', { name: /My plan/ });
    expect(within(cards[0] as HTMLElement).getByText('Ending')).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText('Paused')).toBeInTheDocument();
  });
});

describe('Plan builder (D90)', () => {
  function builderApi(plans: PublicPlan[] = [lawn, cleaning]) {
    const api = fakeApi(users.customer);
    api.on('GET /plans', { body: { plans } });
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    api.on('GET /addresses', { body: { addresses: [address], max: 10 } });
    return api;
  }

  /** The first day the server plans for a start and days, worked out here independently of the page. */
  function expectedFirst(start: number, days: number[]): string {
    const today = todayIn('Europe/Berlin');
    for (let offset = 1 + start; offset <= 28; offset += 1) {
      const day = new Date(Date.parse(`${today}T12:00:00Z`) + offset * DAY);
      const weekday = ((day.getUTCDay() + 6) % 7) + 1;
      if (days.includes(weekday)) return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(day).replace(',', '');
    }
    throw new Error('no day');
  }

  it('updates the price straight away, keeps Subscribe off until the days and terms, and shows the summary after', async () => {
    const api = builderApi();
    const created = subscription({
      frequency: 'twice_weekly',
      days: [2, 4],
      priceCents: 13407,
      status: 'active',
      nextVisitAt: '2026-12-01T07:00:00.000Z',
      minTermEndsAt: '2027-03-01T10:00:00.000Z',
    });
    api.on('POST /subscriptions', { status: 201, body: { subscription: created, payment: null } });
    api.on('GET /subscriptions/sub-1', { body: { subscription: created } });
    renderAt('/plans/plan-lawn');

    const summary = await screen.findByRole('region', { name: 'Your monthly price' });
    expect(within(summary).getByText('€49')).toBeInTheDocument();
    expect(summary).toHaveTextContent('about€11.40per visit');
    expect(summary).toHaveTextContent('About 4.3 visits a month with one regular pro');
    expect(summary).toHaveTextContent('Skip up to 2 visits a month; a skipped visit is still part of the monthly price');
    expect(summary).toHaveTextContent("Minimum term: 3 months, then cancel with 30 days' notice");
    expect(summary).toHaveTextContent("Pause up to 4 weeks a year, with 7 days' notice");

    // How often: four choices, as radio buttons; the price follows at once.
    const often = screen.getByRole('group', { name: 'How often' });
    expect(within(often).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(['Every 2 weeks', '1× a week', '2× a week', '3× a week']);
    expect(within(often).getByRole('radio', { name: '1× a week' })).toBeChecked();
    await user().click(within(often).getByRole('radio', { name: '2× a week' }));
    expect(within(summary).getByText('€88.20')).toBeInTheDocument();
    expect(summary).toHaveTextContent('about€10.14per visit');
    expect(summary).toHaveTextContent('About 8.7 visits a month');
    await user().click(screen.getByRole('radio', { name: 'Large' }));
    expect(within(summary).getByText('€119.07')).toBeInTheDocument();
    const extra = screen.getByRole('checkbox', { name: /Hedge trimming/ });
    expect(extra.closest('label')).toHaveTextContent('+€15/mo');
    await user().click(extra);
    expect(within(summary).getByText('€134.07')).toBeInTheDocument();

    // Days must match how often: two for twice a week.
    expect(screen.getByRole('group', { name: 'Preferred days (pick 2)' })).toBeInTheDocument();
    const subscribe = screen.getByRole('button', { name: 'Pick 2 more days' });
    expect(subscribe).toBeDisabled();
    expect(screen.getByText('Pick your days to see the first visit.')).toBeInTheDocument();
    await user().click(screen.getByRole('checkbox', { name: 'Tue' }));
    expect(subscribe).toHaveAccessibleName('Pick 1 more day');
    await user().click(screen.getByRole('checkbox', { name: 'Thu' }));
    expect(subscribe).toHaveAccessibleName('Accept the terms to subscribe');
    expect(subscribe).toBeDisabled();

    // Start, and the first visit's date for it.
    expect(screen.getByRole('radio', { name: 'As soon as possible' })).toBeChecked();
    expect(screen.getByText(`First visit ${expectedFirst(0, [2, 4])}, morning`)).toBeInTheDocument();
    await user().click(screen.getByRole('radio', { name: 'In 2 weeks' }));
    expect(screen.getByText(`First visit ${expectedFirst(14, [2, 4])}, morning`)).toBeInTheDocument();
    await user().click(screen.getByRole('radio', { name: 'Afternoon' }));
    expect(screen.getByText(`First visit ${expectedFirst(14, [2, 4])}, afternoon`)).toBeInTheDocument();

    // The terms open from their link; ticking the box allows Subscribe.
    await user().click(screen.getByRole('button', { name: 'subscription terms' }));
    const terms = await screen.findByRole('dialog', { name: 'Subscription terms' });
    expect(terms).toHaveTextContent("Minimum term: 3 months, then cancel with 30 days' notice");
    expect(terms).toHaveTextContent('A skipped visit is still part of the monthly price: nothing is refunded.');
    await user().click(within(terms).getByRole('button', { name: 'Close' }));
    await user().click(screen.getByRole('checkbox', { name: 'I agree to the subscription terms' }));
    expect(subscribe).toBeEnabled();
    expect(subscribe).toHaveAccessibleName('Subscribe · €134.07/month');

    // Payment: card, Apple Pay and Google Pay; the selected address filled in where.
    const pay = screen.getByRole('group', { name: 'Pay with' });
    expect(within(pay).getByRole('radio', { name: /Apple Pay/ })).toBeInTheDocument();
    expect(within(pay).getByRole('radio', { name: /Google Pay/ })).toBeInTheDocument();
    expect(within(pay).getByRole('radio', { name: /Another card/ })).toBeChecked();
    expect(screen.getByLabelText('Street and house number')).toHaveValue('12 Linden Street');
    expect(screen.getByLabelText('Postcode')).toHaveValue('10115');

    await user().click(subscribe);
    expect(await screen.findByRole('heading', { name: 'Lawn care is active' })).toBeInTheDocument();
    expect(api.bodies['POST /subscriptions']).toEqual({
      planId: 'plan-lawn',
      frequency: 'twice_weekly',
      size: 'L',
      days: [2, 4],
      timeWindow: 'afternoon',
      start: 'in_2_weeks',
      address: '12 Linden Street',
      postcode: '10115',
      notes: '',
      withAddon: true,
      paymentMethod: { type: 'new_card' },
      acceptTerms: true,
    });
    const done = screen.getByLabelText('Your new plan');
    expect(done).toHaveTextContent('First visitTue 1 Dec, morning');
    expect(done).toHaveTextContent('Your proDaniel');
    expect(done).toHaveTextContent('Billing€134.07 monthly · Card');
    expect(done).toHaveTextContent('Minimum termUntil 1 Mar 2027');
    await user().click(screen.getByRole('button', { name: 'See my visits' }));
    expect(await screen.findByRole('heading', { name: 'My plan' })).toBeInTheDocument();
  });

  it('keeps the number of days to how often: three for three times a week, one when going back to once', async () => {
    builderApi();
    renderAt('/plans/plan-lawn');
    await user().click(await screen.findByRole('radio', { name: '3× a week' }));
    for (const day of ['Mon', 'Wed', 'Fri']) await user().click(screen.getByRole('checkbox', { name: day }));
    expect(screen.getByRole('button', { name: 'Accept the terms to subscribe' })).toBeDisabled();
    // A fourth day replaces the oldest choice.
    await user().click(screen.getByRole('checkbox', { name: 'Sat' }));
    expect(screen.getAllByRole('checkbox', { checked: true }).map((c) => c.closest('label')?.textContent)).toEqual(['Wed', 'Fri', 'Sat']);
    await user().click(screen.getByRole('radio', { name: '1× a week' }));
    expect(screen.getByRole('group', { name: 'Preferred day (pick 1)' })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { checked: true }).map((c) => c.closest('label')?.textContent)).toEqual(['Wed']);
  });

  it('changes the plan at the top', async () => {
    builderApi();
    renderAt('/plans/plan-lawn');
    const plans = await screen.findByRole('group', { name: 'Plan' });
    expect(within(plans).getByRole('radio', { name: /Lawn care/ })).toBeChecked();
    await user().click(within(plans).getByRole('radio', { name: /Home cleaning/ }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Home cleaning/ })).toBeChecked());
    const summary = screen.getByRole('region', { name: 'Your monthly price' });
    expect(within(summary).getByText('€69')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Every 2 weeks' })).toBeChecked();
    expect(screen.getByText('Included every visit: Kitchen · Bathrooms')).toBeInTheDocument();
    expect(screen.getByText('No extras')).toBeInTheDocument();
  });

  it('pays with a saved card and says so on the summary', async () => {
    const api = builderApi();
    api.on('GET /payment-methods', {
      body: { cards: [{ id: 'pm_card_visa', brand: 'visa', last4: '4242', expMonth: 8, expYear: 2030 }], cardsAvailable: true, last: null, publishableKey: null },
    });
    api.on('POST /subscriptions', { status: 201, body: { subscription: subscription(), payment: null } });
    api.on('GET /subscriptions/sub-1', { body: { subscription: subscription() } });
    renderAt('/plans/plan-lawn');
    expect(await screen.findByRole('radio', { name: /Visa •••• 4242/ })).toBeChecked();
    await user().click(screen.getByRole('checkbox', { name: 'Tue' }));
    await user().click(screen.getByRole('checkbox', { name: 'I agree to the subscription terms' }));
    await user().click(screen.getByRole('button', { name: 'Subscribe · €49/month' }));
    expect(await screen.findByText('€64 monthly · Visa •••• 4242')).toBeInTheDocument();
    expect(api.bodies['POST /subscriptions']).toMatchObject({ paymentMethod: { type: 'card', cardId: 'pm_card_visa' }, acceptTerms: true });
  });

  it('shows what is wrong with the address before sending anything', async () => {
    const api = builderApi();
    api.on('GET /addresses', { body: { addresses: [], max: 10 } });
    renderAt('/plans/plan-lawn');
    await user().click(await screen.findByRole('checkbox', { name: 'Tue' }));
    await user().click(screen.getByRole('checkbox', { name: 'I agree to the subscription terms' }));
    await user().click(screen.getByRole('button', { name: 'Subscribe · €49/month' }));
    expect(screen.getByText('Enter the street and house number where the job is.')).toBeInTheDocument();
    expect(screen.getByText('Choose your postcode.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /subscriptions');
  });

  it('agrees with the server rule for the first visit day', () => {
    const today = '2026-11-23'; // a Monday
    const season = { seasonal: false, seasonFrom: null, seasonTo: null };
    expect(firstVisitDay(today, 'asap', [1], season)).toBe('2026-11-30');
    expect(firstVisitDay(today, 'asap', [2, 4], season)).toBe('2026-11-24');
    expect(firstVisitDay(today, 'next_week', [2], season)).toBe('2026-12-01');
    expect(firstVisitDay(today, 'in_2_weeks', [3], season)).toBe('2026-12-09');
    expect(firstVisitDay(today, 'asap', [], season)).toBeNull();
    // A seasonal plan from April finds no day in the 4 planning weeks of November.
    expect(firstVisitDay(today, 'asap', [2], { seasonal: true, seasonFrom: 4, seasonTo: 10 })).toBeNull();
  });
});

describe('My plan (D90)', () => {
  function planApi(overrides: Partial<Subscription> = {}) {
    const api = fakeApi(users.customer);
    api.on('GET /subscriptions/sub-1', { body: { subscription: subscription(overrides) } });
    api.on('GET /subscriptions/sub-1/pause-options', {
      body: {
        earliestStartOn: '2027-03-01',
        latestStartOn: '2027-12-31',
        latestEndOn: '2028-01-28',
        noticeDays: 7,
        maxPauseWeeks: 4,
        weeksLeftThisYear: 4,
        weeksLeft: { '2027': 4 },
        visitCreditCents: 1488,
        visitStarts: ['2027-03-02T07:00:00.000Z', '2027-03-09T07:00:00.000Z'],
        reason: null,
      },
    });
    return api;
  }

  it('shows the plan name, how often, days, price, status, next payment and card', async () => {
    planApi();
    renderAt('/my-plans/sub-1');
    const card = (await screen.findByRole('heading', { name: 'Lawn care' })).closest('.plan-card') as HTMLElement;
    expect(card).toHaveTextContent('1× a week · Tue · morning');
    expect(card).toHaveTextContent('€64/month');
    expect(card).toHaveTextContent('Next charge Tue 12 Jan · Visa •••• 4242');
    expect(appbar()).toHaveTextContent('Active');
  });

  it('lists the visits of the next 4 weeks with date, time window and pro, and the skips left', async () => {
    planApi({ visits: [visit(), visit({ id: 'far', startsAt: future(35), endsAt: future(35, 1) })], skipsLeftThisMonth: 1 });
    renderAt('/my-plans/sub-1');
    const visits = await screen.findByRole('region', { name: 'Upcoming visits' });
    expect(within(visits).getAllByRole('listitem')).toHaveLength(1);
    const item = within(visits).getByRole('listitem');
    expect(item).toHaveTextContent(/\d\d:\d\d – \d\d:\d\d/);
    expect(item).toHaveTextContent('Daniel · Mow, Edge');
    expect(visits).toHaveTextContent('Skips left this month: 1');
    expect(visits).toHaveTextContent('A skipped visit is still part of your monthly price: nothing is refunded.');
  });

  it('skips a visit, shows it faded with Undo, and undoes it', async () => {
    const api = planApi();
    api.on('POST /subscriptions/sub-1/visits/v1/skip', {
      body: { subscription: subscription({ skipsLeftThisMonth: 1, visits: [visit({ status: 'skipped', skipsUsedInMonth: 1 }), visit({ id: 'v2', startsAt: future(10), endsAt: future(10, 1) })] }) },
    });
    api.on('POST /subscriptions/sub-1/visits/v1/unskip', { body: { subscription: subscription() } });
    renderAt('/my-plans/sub-1');
    const [skip] = await screen.findAllByRole('button', { name: /^Skip the visit on/ });
    await user().click(skip as HTMLElement);
    const undo = await screen.findByRole('button', { name: /^Undo skipping the visit on/ });
    expect(undo.closest('li')).toHaveClass('skipped');
    expect(undo.closest('li')).toHaveTextContent('Skipped');
    expect(screen.getByRole('region', { name: 'Upcoming visits' })).toHaveTextContent('Skips left this month: 1');
    expect(screen.getAllByRole('button', { name: /^Skip the visit on/ })).toHaveLength(1);
    await user().click(undo);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Skip the visit on/ })).toHaveLength(2));
    expect(api.calls).toEqual(expect.arrayContaining(['POST /subscriptions/sub-1/visits/v1/skip', 'POST /subscriptions/sub-1/visits/v1/unskip']));
  });

  it('turns Skip off when the month has 2 skips, and every change off within 24 hours', async () => {
    planApi({
      visits: [
        visit({ id: 'soon', startsAt: future(0, 20), endsAt: future(0, 21) }),
        visit({ id: 'full', startsAt: future(5), endsAt: future(5, 1), skipsUsedInMonth: 2 }),
        visit({ id: 'late-skip', status: 'skipped', startsAt: future(0, 22), endsAt: future(0, 23) }),
      ],
    });
    renderAt('/my-plans/sub-1');
    const skips = await screen.findAllByRole('button', { name: /^Skip the visit on/ });
    const moves = screen.getAllByRole('button', { name: /^Move the visit on/ });
    expect(skips[0]).toBeDisabled();
    expect(moves[0]).toBeDisabled();
    expect(skips[0]).toHaveAccessibleDescription('Less than 24 hours to go: this visit can no longer be changed.');
    expect(skips[1]).toBeDisabled();
    expect(skips[1]).toHaveAccessibleDescription(/You have used both skips for/);
    expect(moves[1]).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Undo skipping/ })).toBeDisabled();
  });

  it('moves a visit: nearby days with whether the pro is free, then marks it Moved', async () => {
    const api = planApi();
    const free = future(4);
    const busy = future(5);
    api.on('GET /subscriptions/sub-1/visits/v1/move-options', {
      body: {
        options: [{ startsAt: free, endsAt: free }],
        days: [
          { startsAt: free, endsAt: free, free: true },
          { startsAt: busy, endsAt: busy, free: false },
        ],
        reason: null,
      },
    });
    api.on('POST /subscriptions/sub-1/visits/v1/move', {
      body: { subscription: subscription({ visits: [visit({ startsAt: free, endsAt: future(4, 1), movedFrom: future(3) })] }) },
    });
    renderAt('/my-plans/sub-1');
    await user().click((await screen.findAllByRole('button', { name: /^Move the visit on/ }))[0] as HTMLElement);
    const sheet = await screen.findByRole('dialog', { name: 'Move this visit' });
    const [freeDay, busyDay] = await within(sheet).findAllByRole('radio');
    expect(freeDay?.closest('label')).toHaveTextContent('Daniel is free');
    expect(busyDay?.closest('label')).toHaveTextContent('Daniel is busy');
    expect(busyDay).toBeDisabled();
    await user().click(freeDay as HTMLElement);
    await user().click(within(sheet).getByRole('button', { name: 'Ask Daniel to confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.bodies['POST /subscriptions/sub-1/visits/v1/move']).toEqual({ startsAt: free });
    expect(screen.getByText('Moved')).toBeInTheDocument();
  });

  it('pauses with the Holiday pause switch, in the plan rules, and calls an upcoming pause off', async () => {
    const api = planApi();
    api.on('POST /subscriptions/sub-1/pause', { body: { subscription: subscription({ pauses: [pauseRow()] }) } });
    api.on('POST /subscriptions/sub-1/pause/p1/cancel', { body: { subscription: subscription({ pauses: [pauseRow({ status: 'withdrawn', visitsRestored: 2 })] }) } });
    renderAt('/my-plans/sub-1');
    const toggle = await screen.findByRole('switch', { name: 'Holiday pause' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText("Away? Pause visits for up to 4 weeks a year, with 7 days' notice. No payment for paused weeks.")).toBeInTheDocument();
    await waitFor(() => expect(toggle).toBeEnabled());
    await user().click(toggle);
    const sheet = await screen.findByRole('dialog', { name: 'Pause your plan' });
    fireEvent.change(within(sheet).getByLabelText('First day of the pause'), { target: { value: '2027-03-01' } });
    await user().selectOptions(within(sheet).getByLabelText('How long'), '2');
    await user().click(within(sheet).getByRole('button', { name: 'Pause plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.bodies['POST /subscriptions/sub-1/pause']).toEqual({ startsOn: '2027-03-01', weeks: 2 });

    const on = screen.getByRole('switch', { name: 'Holiday pause' });
    expect(on).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Paused from Mon 1 Mar to Mon 15 Mar. No payment for these weeks.')).toBeInTheDocument();
    expect(screen.getByText('€29.76 credited to your next bill')).toBeInTheDocument();
    await user().click(on);
    const confirm = screen.getByRole('alertdialog');
    await user().click(within(confirm).getByRole('button', { name: 'Yes, call off the pause' }));
    expect(await screen.findByText(/Pause called off\. 2 of 2 visits are back\./)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Holiday pause' })).toHaveAttribute('aria-checked', 'false');
  });

  it('shows a running pause as Paused, with paused visits marked and no switch-off', async () => {
    planApi({ pauses: [pauseRow({ status: 'running' })], visits: [visit({ status: 'cancelled', pausedBy: 'p1' })] });
    renderAt('/my-plans/sub-1');
    const toggle = await screen.findByRole('switch', { name: 'Holiday pause' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toBeDisabled();
    expect(screen.getByText('Paused until Mon 15 Mar. No payment for these weeks.')).toBeInTheDocument();
    expect(appbar()).toHaveTextContent('Paused');
    const item = within(screen.getByRole('region', { name: 'Upcoming visits' })).getByRole('listitem');
    expect(item).toHaveTextContent('Paused');
    expect(within(item).queryByRole('button')).not.toBeInTheDocument();
  });

  it('has no Holiday pause switch on a plan whose rules allow no pauses', async () => {
    const api = planApi({ maxPauseWeeks: 0 });
    renderAt('/my-plans/sub-1');
    expect(await screen.findByText('This plan cannot be paused.')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(api.calls).not.toContain('GET /subscriptions/sub-1/pause-options');
  });

  it('shows the end of the minimum term before cancelling, then Ending with the end date, and Keep my plan undoes it', async () => {
    const api = planApi();
    api.on('POST /subscriptions/sub-1/cancel', { body: { subscription: subscription({ endsAt: '2027-02-12T09:00:00.000Z' }) } });
    // Actions answer without the card, which My plan keeps from the first read.
    api.on('POST /subscriptions/sub-1/keep', { body: { subscription: subscription({ paymentMethod: undefined }) } });
    renderAt('/my-plans/sub-1');
    await user().click(await screen.findByRole('button', { name: 'Cancel subscription' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel your subscription?' });
    expect(dialog).toHaveTextContent('Your 3-month minimum term runs until 12 Feb 2027.');
    expect(dialog).toHaveTextContent('If you cancel now, your plan ends on 12 Feb 2027.');
    expect(api.calls).not.toContain('POST /subscriptions/sub-1/cancel');
    await user().click(within(dialog).getByRole('button', { name: 'Yes, cancel' }));

    expect(await screen.findByText('Your plan ends 12 Feb 2027,')).toBeInTheDocument();
    expect(screen.getByText(/when the 3-month minimum is up/)).toBeInTheDocument();
    expect(appbar()).toHaveTextContent('Ending');
    expect(screen.queryByRole('button', { name: 'Cancel subscription' })).not.toBeInTheDocument();
    // No next charge while the plan is ending.
    expect(screen.queryByText(/Next charge/)).not.toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'Keep my plan' }));
    expect(await screen.findByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument();
    expect(appbar()).toHaveTextContent('Active');
    expect(screen.getByText(/Visa •••• 4242/)).toBeInTheDocument();
    expect(api.calls).toContain('POST /subscriptions/sub-1/keep');
  });
});

describe('pro app: skipped plan visits (D90)', () => {
  it('shows a skipped visit as skipped, with nothing to do', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /pro/profile', {
      body: {
        profile: {
          status: 'approved',
          homePostcode: '10115',
          radiusKm: 12,
          workingDays: [1, 2, 3, 4, 5],
          reviewNote: null,
          payoutsEnabled: true,
          hasPayoutAccount: true,
          ratingAverage: 4.9,
          ratingCount: 10,
          trades: ['cat-garden'],
          documents: { id: null, certificate: null, insurance: null },
        },
      },
    });
    api.on('GET /pro/visits/v1', {
      body: {
        visit: {
          id: 'v1',
          subscriptionId: 'sub-1',
          startsAt: future(2),
          endsAt: future(2, 1),
          status: 'skipped',
          tasksDone: [],
          tasks: ['Mow', 'Edge'],
          planName: 'Lawn care',
          address: '12 Linden Street',
          postcode: '10115',
          notes: '',
          customerName: 'Sara',
          earningsCents: 798,
        },
      },
    });
    renderAt('/pro/visits/v1');
    expect(await screen.findByText('The customer skipped this visit. You are not expected then.')).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Mow' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Complete/ })).not.toBeInTheDocument();
  });
});
