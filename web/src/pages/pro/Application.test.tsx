import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApplicationView, ProDocument, ProProfile } from '../../api/types';
import { catalogue, fakeApi, renderAt, users, type FakeApi } from '../../test/harness';

const user = () => userEvent.setup();

const draft: ProProfile = {
  status: 'draft',
  homePostcode: null,
  homeAddress: null,
  radiusKm: 12,
  workingDays: [1, 2, 3, 4, 5],
  reviewNote: null,
  payoutsEnabled: false,
  hasPayoutAccount: false,
  jobsPaused: false,
  suspendedReason: null,
  ratingAverage: null,
  ratingCount: 0,
  trades: [],
  tradeNames: [],
  documents: { id: null, certificate: null, insurance: null, background: null },
  backgroundConsentAt: null,
  requestedDocuments: [],
  reapplyOn: null,
  editable: true,
  certificateRequired: true,
};

const garden = catalogue.categories[0];
if (!garden) throw new Error('test catalogue has no trade');
const cleaning = { ...garden, id: 'cat-clean', slug: 'cleaning', name: 'Cleaning', needsCertificate: false, services: [] };

function waiting(fileName: string, extra: Partial<ProDocument> = {}) {
  return {
    uploadId: `f-${fileName}`,
    fileName,
    uploadedAt: '2026-11-09T09:00:00.000Z',
    expiresOn: null,
    reviewStatus: 'pending' as const,
    reviewNote: null,
    state: 'waiting_review' as const,
    ...extra,
  };
}

/** A pro on the Application page, whose saves answer with the profile changed as asked. */
function applying(profile: ProProfile = draft): FakeApi {
  const api = fakeApi(users.pro);
  let current = profile;
  api.on('GET /catalogue', { body: { ...catalogue, categories: [...catalogue.categories, cleaning] } });
  api.on('GET /pro/profile', () => ({ body: { profile: current } }));
  api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
  api.on('PATCH /pro/profile', ({ body }) => {
    const change = body as Partial<ProProfile> & { backgroundConsent?: boolean };
    const { backgroundConsent, ...rest } = change;
    current = {
      ...current,
      ...rest,
      ...(backgroundConsent === undefined ? {} : { backgroundConsentAt: backgroundConsent ? '2026-11-09T09:00:00.000Z' : null }),
    };
    return { body: { profile: current } };
  });
  return api;
}

function view(
  profile: Partial<ProProfile>,
  timeline: ApplicationView['timeline'],
  support: ApplicationView['support'] = { email: null, phone: null },
): ApplicationView {
  return {
    profile: {
      ...draft,
      status: 'submitted',
      editable: false,
      homeAddress: 'Linden Street 4',
      homePostcode: '10115',
      radiusKm: 15,
      trades: ['cat-garden'],
      tradeNames: ['Gardening'],
      submittedAt: '2026-11-09T09:00:00.000Z',
      backgroundConsentAt: '2026-11-09T08:00:00.000Z',
      documents: {
        id: waiting('id.jpg'),
        certificate: waiting('cert.pdf'),
        insurance: waiting('insurance.pdf'),
        background: { ...waiting(''), uploadId: null },
      },
      ...profile,
    },
    timeline,
    support,
  };
}

const steps = (documents: string, background: string, decision: string) =>
  [
    { key: 'sent', state: 'done' },
    { key: 'documents', state: documents },
    { key: 'background', state: background },
    { key: 'decision', state: decision },
  ] as NonNullable<ApplicationView['timeline']>['steps'];

describe('the Application page (D93)', () => {
  it('opens for a new pro, with a progress bar of four parts and Monday to Friday chosen', async () => {
    applying();
    renderAt('/pro');
    const progress = await screen.findByRole('list', { name: 'Your application: 1 of 4 parts done' });
    const parts = within(progress).getAllByRole('listitem');
    expect(parts.map((li) => li.textContent)).toEqual([
      'Trades, not done yet',
      'Documents, not done yet',
      'Background check, not done yet',
      'Working days, done',
    ]);
    expect(parts[0]).toHaveAttribute('aria-current', 'step');
    const days = screen.getByRole('group', { name: 'Working days' });
    expect(within(days).getAllByRole('button').map((b) => b.getAttribute('aria-pressed'))).toEqual([
      'true',
      'true',
      'true',
      'true',
      'true',
      'false',
      'false',
    ]);
    expect(screen.getByText('You can change your hours, days off and holidays later in your profile')).toBeInTheDocument();
  });

  it('lets the pro choose several live trades and saves them by itself', async () => {
    const api = applying();
    renderAt('/pro/apply');
    await user().click(await screen.findByRole('button', { name: 'Gardening' }));
    await user().click(screen.getByRole('button', { name: 'Cleaning' }));
    expect(screen.getByRole('button', { name: 'Gardening' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Cleaning' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(api.bodies['PATCH /pro/profile']).toEqual({ trades: ['cat-garden', 'cat-clean'] }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Your application: 2 of 4 parts done' })).toBeInTheDocument();
  });

  it('saves the home address and travel distance, says customers never see the address, and keeps the slider from 3 to 30 km', async () => {
    const api = applying();
    renderAt('/pro/apply');
    expect(await screen.findByText('Customers never see your address')).toBeInTheDocument();
    await user().type(screen.getByLabelText('Street and house number'), 'Linden Street 4');
    await user().selectOptions(await screen.findByLabelText('Postcode'), '10115');
    await waitFor(() =>
      expect(api.bodies['PATCH /pro/profile']).toEqual({ homeAddress: 'Linden Street 4', homePostcode: '10115' }),
    );
    const slider = screen.getByLabelText('From your home address');
    expect(slider).toHaveAttribute('min', '3');
    expect(slider).toHaveAttribute('max', '30');
    fireEvent.change(slider, { target: { value: '25' } });
    expect(screen.getByText('25 km')).toBeInTheDocument();
    await waitFor(() => expect(api.bodies['PATCH /pro/profile']).toEqual({ radiusKm: 25 }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('has an upload button for each document, and an uploaded one waits for the check', async () => {
    const api = applying();
    api.on('POST /pro/documents/certificate', {
      status: 201,
      body: { profile: { ...draft, documents: { ...draft.documents, certificate: waiting('cert.pdf') } } },
    });
    renderAt('/pro/apply');
    expect(await screen.findByText('Documents (0/3)')).toBeInTheDocument();
    expect(screen.getByLabelText('Upload ID card or passport')).toBeDisabled();
    expect(screen.getByLabelText('Upload Liability insurance')).toBeDisabled();
    expect(screen.queryByLabelText(/Upload Background check/)).not.toBeInTheDocument();
    await user().upload(screen.getByLabelText('Upload Trade certificate'), new File(['%PDF'], 'cert.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText('Uploaded, waiting for check')).toBeInTheDocument();
    expect(screen.getByText('Documents (1/3)')).toBeInTheDocument();
  });

  it('needs no trade certificate when only cleaning is chosen', async () => {
    applying({ ...draft, trades: ['cat-clean'], certificateRequired: false });
    renderAt('/pro/apply');
    expect(await screen.findByText('Documents (0/2)')).toBeInTheDocument();
    const certificate = screen.getByText('Trade certificate', { selector: '.b' }).closest('.doc') as HTMLElement;
    expect(within(certificate).getByText('Not needed for your trades.')).toBeInTheDocument();
  });

  it('keeps Submit off until the background check is agreed to, then sends and opens the status page', async () => {
    const api = applying();
    const sent = view({}, { steps: steps('current', 'upcoming', 'upcoming'), current: 'documents' });
    api.on('POST /pro/submit', { body: { profile: sent.profile } });
    api.on('GET /pro/application', { body: sent });
    renderAt('/pro/apply');
    const button = await screen.findByRole('button', { name: 'Agree to the background check first' });
    expect(button).toBeDisabled();
    const consent = screen.getByRole('checkbox', {
      name: 'I agree to a background check. A partner checks your criminal record. MISK only sees "clear" or "not clear", usually within 2 days.',
    });
    await user().click(consent);
    const submit = screen.getByRole('button', { name: 'Submit application' });
    expect(submit).toBeEnabled();
    await user().click(submit);
    // The waiting consent is saved before the application goes.
    expect(api.bodies['PATCH /pro/profile']).toEqual({ backgroundConsent: true });
    expect(api.calls.indexOf('PATCH /pro/profile')).toBeLessThan(api.calls.indexOf('POST /pro/submit'));
    expect(await screen.findByRole('heading', { name: 'Under review' })).toBeInTheDocument();
  });

  it('shows the reason when the application cannot be sent yet', async () => {
    const api = applying({ ...draft, backgroundConsentAt: '2026-11-09T09:00:00.000Z' });
    api.on('POST /pro/submit', { status: 400, body: { error: 'trades_missing' } });
    renderAt('/pro/apply');
    await user().click(await screen.findByRole('button', { name: 'Submit application' }));
    expect(await screen.findByText('Please choose at least one trade.')).toBeInTheDocument();
  });
});

describe('the Application status page (D93)', () => {
  function showing(data: ApplicationView) {
    const api = fakeApi(users.pro);
    api.on('GET /pro/application', { body: data });
    api.on('GET /pro/profile', { body: { profile: data.profile } });
    renderAt('/pro/application');
    return api;
  }

  it('shows the status in words, the four steps with the current one, and what was sent', async () => {
    showing(view({}, { steps: steps('current', 'upcoming', 'upcoming'), current: 'documents' }));
    expect(await screen.findByRole('heading', { name: 'Under review' })).toBeInTheDocument();
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('.tt')?.firstChild?.textContent)).toEqual([
      'Application sent',
      'Documents checked',
      'Background check',
      'Decision',
    ]);
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[0]).not.toHaveAttribute('aria-current');
    const summary = screen.getByRole('region', { name: 'What you sent' });
    expect(within(summary).getByText('Gardening')).toBeInTheDocument();
    expect(within(summary).getByText('Linden Street 4, 10115')).toBeInTheDocument();
    expect(within(summary).getByText('Up to 15 km')).toBeInTheDocument();
    expect(within(summary).getByText('Mon, Tue, Wed, Thu, Fri')).toBeInTheDocument();
    expect(within(summary).getByText('3 of 3 uploaded')).toBeInTheDocument();
    expect(within(summary).getByText('Consent given 9 Nov 2026')).toBeInTheDocument();
  });

  it('asks for the missing document in the team’s words, and after the upload the review carries on', async () => {
    const asked = view(
      { status: 'info_requested', reviewNote: 'Your trade certificate photo is too blurry to read.', requestedDocuments: ['certificate'] },
      { steps: steps('attention', 'upcoming', 'upcoming'), current: 'documents' },
    );
    const api = showing(asked);
    const resumed = view({}, { steps: steps('current', 'upcoming', 'upcoming'), current: 'documents' });
    api.on('POST /pro/documents/certificate', () => {
      api.on('GET /pro/application', { body: resumed });
      return { status: 201, body: { profile: resumed.profile } };
    });
    expect(await screen.findByRole('heading', { name: 'We need one more thing' })).toBeInTheDocument();
    expect(screen.getByText('Your trade certificate photo is too blurry to read.')).toBeInTheDocument();
    expect(screen.getByText('Upload it and the review carries on where it stopped. No need to apply again.')).toBeInTheDocument();
    await user().upload(screen.getByLabelText('Upload Trade certificate'), new File(['%PDF'], 'sharper.pdf', { type: 'application/pdf' }));
    expect(await screen.findByRole('heading', { name: 'Under review' })).toBeInTheDocument();
    expect(api.calls.filter((c) => c === 'POST /pro/submit')).toEqual([]);
  });

  it('welcomes an approved pro and leads to the Jobs page', async () => {
    showing(view({ status: 'approved' }, { steps: steps('done', 'done', 'done'), current: 'decision' }));
    expect(await screen.findByRole('heading', { name: "You're approved!" })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to my jobs' })).toHaveAttribute('href', '/pro');
  });

  it('gives the reason of a decline, a way to contact support and when the pro can apply again', async () => {
    showing(
      view(
        { status: 'rejected', reviewNote: 'Your background check did not meet our requirements.', reapplyOn: '2027-05-23' },
        { steps: steps('done', 'failed', 'failed'), current: 'decision' },
        { email: 'help@example.com', phone: null },
      ),
    );
    expect(await screen.findByRole('heading', { name: 'Not approved this time' })).toBeInTheDocument();
    expect(screen.getByText('Your background check did not meet our requirements.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', 'mailto:help@example.com');
    expect(screen.getByText(/You can apply again in 6 months/)).toHaveTextContent('From 23 May 2027.');
    expect(screen.queryByRole('link', { name: 'Apply again' })).not.toBeInTheDocument();
  });

  it('lets a declined pro apply again once 6 months have passed, and copes without a support contact', async () => {
    showing(
      view({ status: 'rejected', reviewNote: 'Not this time.', editable: true }, { steps: steps('done', 'done', 'failed'), current: 'decision' }),
    );
    expect(await screen.findByRole('link', { name: 'Apply again' })).toHaveAttribute('href', '/pro/apply');
    // Without a support email or phone the button is still there and says how to reach the team.
    expect(screen.queryByRole('link', { name: 'Contact support' })).not.toBeInTheDocument();
    const contact = screen.getByRole('button', { name: 'Contact support' });
    expect(contact).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Reply to the message we sent you/)).not.toBeInTheDocument();
    await user().click(contact);
    expect(contact).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText(/Reply to the message we sent you/)).toBeInTheDocument();
  });
});
