import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

const API = 'http://localhost:3100';
const CUSTOMER_PHONE = '+4915100000001';
const PRO_PHONE = '+4915100000002';
// A 1×1 PNG, standing in for a photo of the finished lawn.
const PHOTO = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cf00000301010018dd8db40000000049454e44ae426082',
  'hex',
);

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const found = results.violations.map(
    (v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`).join(' | ')}`,
  );
  expect(found).toEqual([]);
}

async function signInByPhone(browser: Browser, phone: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/signin?method=phone');
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: /Send me a sign-in code/ }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  const response = await page.request.get(`${API}/test/last-code?phone=${encodeURIComponent(phone)}`);
  const { code } = (await response.json()) as { code: string };
  await page.getByLabel('6-digit code').fill(code);
  // Wait for the session before the test moves on, or a quick next navigation finds nobody signed in.
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/auth/phone/verify') && response.ok()),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  return page;
}

test.describe.serial('MISK marketplace', () => {
  let bookingUrl = '';

  test('a new customer books and pays for a lawn mowing', async ({ browser }) => {
    const page = await signInByPhone(browser, CUSTOMER_PHONE);
    await expect(page.getByRole('heading', { name: 'Welcome!' })).toBeVisible();
    await expectAccessible(page);
    await page.getByLabel('Your first name').fill('Sara');
    await page.getByRole('button', { name: /Open the customer app/ }).click();

    await expect(page.getByRole('heading', { name: 'Sara' })).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('link', { name: 'Gardening' }).click();
    await page.getByText('Lawn mowing').click();
    await page.getByRole('button', { name: /Continue · from €35/ }).click();

    await page.getByLabel('Street and house number').fill('12 Linden Street');
    await page.getByLabel('Postcode').selectOption('10115');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Continue · €45.50' }).click();

    const freeSlot = page.locator('.slot:not([disabled])').first();
    await expect(freeSlot).toBeVisible();
    await expectAccessible(page);
    await freeSlot.click();
    await page.getByRole('button', { name: /^Continue · / }).click();

    await expect(page.getByRole('region', { name: 'Price' }).getByText('€48.40')).toBeVisible();
    await page.getByRole('button', { name: 'Book and pay €48.40' }).click();
    await expect(page.getByRole('heading', { name: 'Lawn mowing' })).toBeVisible();
    bookingUrl = page.url();
    expect(bookingUrl).toMatch(/\/bookings\/[0-9a-f-]{36}$/);
    await expectAccessible(page);
    await page.context().close();
  });

  test('the pro accepts the offer and does the job', async ({ browser }) => {
    const page = await signInByPhone(browser, PRO_PHONE);
    const offer = page.getByRole('article', { name: 'New job request' });
    await expect(offer).toBeVisible();
    await expect(offer.getByText('€37.31')).toBeVisible();
    await expectAccessible(page);
    await offer.getByRole('button', { name: 'Accept job' }).click();

    await page.getByRole('button', { name: /Start driving/ }).click();
    await page.getByRole('button', { name: /I've arrived/ }).click();

    await page.getByRole('button', { name: /Ask for extra work/ }).click();
    await page.getByLabel('What extra work?').fill('Trim the front hedge');
    await page.getByLabel('Price in euros').fill('20');
    await page.getByRole('button', { name: 'Send to customer' }).click();
    await expect(page.getByText('Waiting for the customer')).toBeVisible();

    await page.getByLabel('Add a photo').setInputFiles({ name: 'lawn.png', mimeType: 'image/png', buffer: PHOTO });
    await expect(page.getByRole('img', { name: /Photos of the finished work 1/ })).toBeVisible();
    await expectAccessible(page);
    await page.context().close();
  });

  test('the customer approves the extra work, the pro completes, and the customer rates', async ({ browser }) => {
    const customer = await signInByPhone(browser, CUSTOMER_PHONE);
    await customer.goto(bookingUrl);
    await customer.getByRole('button', { name: 'Approve +€20' }).click();
    await expect(customer.getByText('Approved', { exact: true })).toBeVisible();
    await expect(customer.getByText('€68.40')).toBeVisible();

    const pro = await signInByPhone(browser, PRO_PHONE);
    await pro.goto(bookingUrl.replace('/bookings/', '/pro/jobs/'));
    await pro.getByRole('button', { name: /Complete the job/ }).click();
    await expect(pro.getByText('You earned')).toBeVisible();
    await expect(pro.getByText('€53.71')).toBeVisible();
    await pro.context().close();

    await customer.reload();
    // The card is charged 24 hours after the job, unless the customer reports a problem first.
    await expect(customer.getByRole('button', { name: 'Report a problem' })).toBeVisible();
    await customer.getByRole('img', { name: '5 stars' }).click();
    await expect(customer.getByRole('radio', { name: '5 stars' })).toBeChecked();
    await customer.getByText('Tidy work').click();
    await customer.getByRole('button', { name: 'Send rating' }).click();
    await expect(customer.getByText('You gave 5 stars. Thank you!')).toBeVisible();
    await expect(customer.getByText('The amount is held on your card.')).toBeVisible();
    await expectAccessible(customer);
    await customer.context().close();
  });

  test('a new customer signs up with email and password', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/signin');
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    await page.getByLabel(/^First name/).fill('Lena');
    await page.getByLabel(/^Last name/).fill('Berg');
    await page.getByLabel(/^Email address/).fill('lena@example.com');
    await page.getByLabel(/^Password/).fill('garden42');
    await page.getByLabel(/^Confirm password/).fill('garden42');
    await page.getByRole('checkbox', { name: /I accept the terms/ }).check();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Welcome!' })).toBeVisible();
    await expect(page.getByLabel('Your first name')).toHaveValue('Lena');
    await page.getByRole('button', { name: /Open the customer app/ }).click();
    await expect(page.getByRole('heading', { name: 'Lena' })).toBeVisible();
    await context.close();
  });

  test('a new team member requests an admin account on the control panel', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: 'http://localhost:4174' });
    const page = await context.newPage();
    await page.goto('/admin/login');
    await page.getByRole('link', { name: 'Request an account' }).click();
    await page.getByLabel(/^First name/).fill('Lina');
    await page.getByLabel(/^Last name/).fill('Hoxha');
    await page.getByLabel(/^Work email address/).fill('lina@misk.test');
    await page.getByLabel(/^Password/).fill('a long new admin password');
    await page.getByLabel(/^Confirm password/).fill('a long new admin password');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Request account' }).click();
    await expect(page.getByRole('status')).toContainText('Your request is with the MISK team');
    await page.goto('/admin/login');
    await page.getByLabel('Username or email').fill('lina@misk.test');
    await page.getByLabel('Password').fill('a long new admin password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('waiting for an admin to approve it');
    await context.close();
  });

  test('the MISK team sees the job and the money on the overview', async ({ browser }) => {
    // The control panel is its own website, with its own login.
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: 'http://localhost:4174' });
    const page = await context.newPage();
    // A day later: the job is charged and the pro paid.
    expect((await page.request.post(`${API}/test/pass-charge-delay`, { headers: { origin: 'http://localhost:4174' } })).ok()).toBe(true);
    await page.goto('/admin');
    await page.getByLabel('Username or email').fill('admin');
    await page.getByLabel('Password').fill('e2e admin password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Control panel' });
    await expect(page.getByText('€68.40')).toBeVisible();
    await expectAccessible(page);

    await nav.getByRole('link', { name: 'Bookings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Done (1)' })).toBeVisible();
    await page.getByLabel('Search').fill('sara');
    await page.getByRole('button', { name: /^Open B-\d+$/ }).click();
    const panel = page.getByRole('dialog');
    await expect(panel.getByText('Sara', { exact: false }).first()).toBeVisible();
    await expect(panel.getByRole('list', { name: 'Progress' })).toBeVisible();
    await expect(panel.getByText('Paid.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Refund in full' })).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await page.getByLabel('Search').fill('nobody here');
    await expect(page.getByText('No bookings match these filters')).toBeVisible();

    await nav.getByRole('link', { name: 'Providers', exact: true }).click();
    await expect(page.getByText('Active pros')).toBeVisible();
    await page.getByRole('button', { name: 'Active (1)' }).click();
    await page.getByRole('button', { name: 'Open Daniel' }).click();
    const proPanel = page.getByRole('dialog', { name: 'Daniel' });
    await expect(proPanel.getByText('ID verified')).toBeVisible();
    await expect(proPanel.getByRole('button', { name: 'Pause jobs' })).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await expect(proPanel).toBeHidden();
    await nav.getByRole('link', { name: 'Plans', exact: true }).click();
    await page.getByRole('link', { name: 'New plan' }).click();
    await page.getByLabel('Plan name').fill('Weekly lawn care');
    await page.getByLabel('Category').selectOption({ label: 'Gardening' });
    await page.getByLabel('Monthly price (€)').fill('49');
    await page.getByRole('textbox', { name: 'Add a task' }).fill('Mow');
    await page.getByRole('textbox', { name: 'Add a task' }).press('Enter');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Publish plan' }).click();
    await expect(page.getByRole('heading', { name: 'Plan published' })).toBeVisible();
    await nav.getByRole('link', { name: 'Catalogue', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Gardening/ })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Visible to customers: Lawn mowing' })).toBeChecked();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'See in the app' }).click();
    await expect(page.getByRole('dialog', { name: 'Gardening in the customer app' }).getByText('Lawn mowing')).toBeVisible();
    await page.keyboard.press('Escape');
    await context.close();
  });
  test('a customer subscribes to the plan the team published, and the pro sees it', async ({ browser }) => {
    const customer = await signInByPhone(browser, CUSTOMER_PHONE);
    await customer.goto('/plans');
    await customer.getByRole('link', { name: /Weekly lawn care/ }).click();
    await expect(customer.getByRole('region', { name: 'Your monthly price' })).toContainText('€49');
    await customer.getByRole('checkbox', { name: 'Tue' }).check({ force: true });
    await customer.getByLabel('Street and house number').fill('12 Linden Street');
    await customer.getByLabel('Postcode').selectOption('10115');
    await expectAccessible(customer);
    await customer.getByRole('button', { name: 'Subscribe · €49/month' }).click();
    await expect(customer.getByText('Daniel is your regular pro')).toBeVisible();
    await expect(customer.getByRole('button', { name: 'Skip' }).first()).toBeVisible();
    await expectAccessible(customer);
    await customer.context().close();

    const pro = await signInByPhone(browser, PRO_PHONE);
    const plans = pro.getByRole('region', { name: 'Monthly plans in your trades' });
    await expect(plans.getByText('Weekly lawn care')).toBeVisible();
    await expect(plans.getByText('1 of your customers')).toBeVisible();
    await pro.goto('/pro/week');
    await expectAccessible(pro);
    await pro.context().close();
  });
});
