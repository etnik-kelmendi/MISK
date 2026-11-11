# MISK — Home and garden help, booked in minutes

MISK is a marketplace for home and garden services. Customers book a verified pro for a one-off job
at a fixed price; pros apply, get approved and accept nearby jobs; the MISK team runs everything from
a web control panel. The product reference is `docs/product-demo.html`; the work queue is `GOALS.md`.

| Folder     | Contents                                                        |
| ---------- | --------------------------------------------------------------- |
| `backend/` | API: Fastify, PostgreSQL, Stripe Connect, Twilio                |
| `web/`     | Two websites from one codebase: the customer and pro app (`/`, `/pro`), and the admin control panel (`/admin`), each with its own login |

Both need Node 24 or newer (`.nvmrc`).

```mermaid
flowchart LR
    C["Customer app /"] --> API
    P["Pro app /pro"] --> API
    A["Admin control panel<br/>its own website"] --> API
    API["MISK API"] --> DB[("PostgreSQL")]
    API --> FS[("Uploads folder")]
    API <--> ST["Stripe"]
    API --> SMS["Twilio"]
```

## Run it locally

You need a free [Stripe](https://dashboard.stripe.com/register) account for its **test** keys; no
real money moves with them. Twilio is optional locally: without it, sign-in codes appear in the API log.

```
# Terminal 1: database (PostgreSQL comes with the dev dependencies)
cd backend
npm ci
cp .env.example .env        # then add your Stripe test keys
npm run db:dev

# Terminal 2: API on http://localhost:3000
cd backend
npm run migrate
npm run user:create-first-admin
npm run dev

# Terminal 3: Stripe webhooks to your machine (Stripe CLI); put the printed whsec_ secret in backend/.env
stripe listen --forward-to localhost:3000/payments/webhook

# Terminal 4: customer and pro app on http://localhost:5173
cd web
npm ci
cp .env.example .env
npm run dev

# Terminal 5: admin control panel on http://localhost:5174
cd web
npm run dev:admin
```

Then, as admin at http://localhost:5174/admin/login: add served postcodes under **Areas**, and categories and services
under **Catalogue**. Sign up a pro at `/signin`, approve them under **Pros**, and have them set up payouts
(Stripe test onboarding accepts test bank details). Customers can book once a pro covers their postcode.
Pay with Stripe's test card `4242 4242 4242 4242`.

## Demo data

Two ways to work with a full, realistic marketplace without typing data in:

| Command (in `backend/`) | What you get |
| ----------------------- | ------------ |
| `npm run preview:server` | A throwaway API on port 3100 with fake payments, filled with demo data on every start. Run the app with `VITE_API_BASE_URL=http://localhost:3100 npx vite --port 4173` and the control panel with `VITE_API_BASE_URL=http://localhost:3100 npx vite --mode admin --port 4174`. Everything works end to end, including completing, paying and refunding the demo jobs. |
| `npm run db:seed` | Fills your own development database (`npm run db:dev`). Refuses a database that already has users; `npm run db:seed -- --reset` empties it first. Never runs with `NODE_ENV=production`. |

The demo data (`backend/src/seed/demo-data.ts`) is the same every time, with dates relative to today:

- 8 live Berlin postcodes and 2 on the waitlist (with 4 and 1 people waiting, plus 1 waiting outside any zone)
- 6 live categories with 19 services (one paid per hour), a draft category, 4 monthly plans (3 live, 1 draft)
- 13 pros in every Providers tab: 6 active (one with a quality warning and on the watch list, one with insurance running
  out), 3 applications (one ready, one with open checks, one asked for more information), one waiting for a new
  insurance to be checked, one suspended, one rejected and one draft
- 9 customers (5 by phone, 4 by email) and 5 more who are only on a waitlist
- About 77 bookings: eight weeks of finished jobs with ratings, photos, extra work, payouts, tips, cancellations and
  refunds; one of each live state today (working, on the way with extra work waiting, accepted, searching with a
  15-minute offer, unassigned, awaiting payment); a job done this morning that is charged tomorrow; a job with a reported
  problem; and a late cancellation charged in full
- A team with one member per role (Admin, Operations, Support, Finance, plus an invited one), and weeks of activity in the
  log: fee, payout, zone, notification and team changes, price changes, booking and provider actions

| Sign in as | Where | With |
| ---------- | ----- | ---- |
| Admin | the control panel's `/admin/login` | `admin` / `demo admin password` |
| Operations, Support or Finance | the control panel's `/admin/login` | `olivia.ops@example.com`, `sam.support@example.com` or `fiona.finance@example.com` / `demo admin password` |
| Customer by email | `/signin` | `anna@example.com` (has a job done this morning to tip or report) (or `ben@`, `clara@`, `emil@example.com`) / `garden42` |
| Customer by phone | `/signin?method=phone` | `+4915100000001` (Sara, has a job in progress) |
| Pro by phone | `/signin?method=phone` | `+4915200000001` (Daniel, gardener) |

Phone codes appear in the API log without Twilio; in the preview also at
`http://localhost:3100/test/last-code?phone=%2B4915100000001`. With `db:seed` and real Stripe test keys, seeded bookings carry
made-up payment ids, so do not complete or refund them there; use the preview for that.

## Checks

| Where      | Command              | What it checks                                                  |
| ---------- | -------------------- | --------------------------------------------------------------- |
| `backend/` | `npm run typecheck`  | TypeScript                                                      |
| `backend/` | `npm run lint`       | ESLint, zero warnings                                           |
| `backend/` | `npm test`           | API and unit tests on a real, throwaway PostgreSQL              |
| `web/`     | `npm run lint`       | ESLint with accessibility rules and no hardcoded text           |
| `web/`     | `npm run build`      | Type check and production build                                 |
| `web/`     | `npm test`           | Component and unit tests                                        |
| `web/`     | `npm run test:e2e`   | The whole marketplace in a browser against the real API, with axe accessibility checks |

`npm run test:e2e` needs `npm ci` in `backend/` and `npx playwright install chromium` first. It uses a
fake payment provider and fake text messages that live in `backend/test/`; the real server refuses to
start without Stripe.

## How a booking works

```mermaid
stateDiagram-v2
    [*] --> awaiting_payment: customer books a free slot
    awaiting_payment --> searching: card hold confirmed
    awaiting_payment --> cancelled: unpaid after 30 minutes
    searching --> accepted: pro accepts within 15 minutes
    searching --> searching: decline or timeout, next pro
    searching --> unassigned: nobody left, admins step in
    accepted --> on_the_way
    on_the_way --> working
    working --> completed: photo added
    completed --> completed: 24 hours later with no problem, money taken and pro paid
```

- **Slots** start every two hours from 08:00 to 18:00 for today and the next five days, in
  `MARKET_TIMEZONE`, and only when a free, approved pro with payouts set up covers the postcode.
- **Money** is held on the card at booking and taken 24 hours after the job is done. If the customer
  reports a problem in the app before then, the charge waits for the team to refund or charge it. The pro's share (82% by default) of
  the job and of approved extra work is transferred to their Stripe account, paid out every Friday.
  The service fee (€2.90 by default) stays with MISK. Both are set under **Settings**.
- **Extra work** is charged only after the customer approves it in the app.
- **Monthly plans** are built and published by admins. Customers subscribe in the app's Plans tab (size,
  days, morning or afternoon, optional extra), get one regular pro, and pay monthly through Stripe. Visits
  are planned four weeks ahead; customers can skip a limited number a month and cancel after the minimum
  term. Seasonal plans run April to October and are not charged in winter. Pros see the plans in their
  trades and their plan visits, and tick off the tasks on each visit.
- **Cancelling** is free until a pro is assigned and then until 24 hours before; after that only admins
  can cancel. Admins can also refund a finished job, which takes the pro's payout back.
- **Providers** (admin) shows active pros, who is online, average acceptance and expiring documents,
  with tabs for Applications, Active, Pending approval and Suspended. Each pro passes four checks (ID,
  trade certificate, liability insurance, certificate of good conduct). Pros whose document runs out move
  to Pending approval by themselves until a new copy is accepted. The team can approve, ask for more
  information, reject, pause jobs, put on a watch list, book a coaching call, suspend (their jobs go to
  other pros) and reinstate; every action is logged.
- **Catalogue** (admin) lists the trades on the left (visible services, pros) and the selected trade's
  services on the right, with duration, base price (edited in the table), Small / Medium / Large prices
  or a per-hour price, what the pro earns, and a visible switch. New trades start as drafts; "See in the
  app" shows the trade as customers see it. Every change is logged and reaches the app within 30 seconds.
- **Settings** (admin) has four tabs that save by themselves ("All changes saved"): Fees & payments
  (service fee, commission 10–30%, payout frequency, and the charging, cancellation and tip rules), Service
  area (zones on a map, go live / pause, waitlist), Notifications (push, SMS and email per message, test
  messages to yourself) and Team & access (roles, invites, the activity log).
- **Admin Bookings** lists one-off bookings and plan visits with tabs (All, Needs action, Live now,
  Upcoming, Done), search (booking number, customer, address, pro), trade and type filters, CSV export of
  the rows shown, and a side panel to assign a pro, move the time, cancel, refund or charge. Every action
  is logged with the admin who made it.

## Configuration

Every setting is documented in `backend/.env.example` and `web/.env.example`. Secrets go in `.env`
files, which git ignores.

### Stripe

1. Use test keys (`sk_test_…`, `pk_test_…`) everywhere except production. Live keys are refused unless
   `NODE_ENV=production`.
2. Enable **Connect** in the Stripe dashboard, with Express accounts.
3. Add a webhook endpoint for `https://<api host>/payments/webhook` listening to
   `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`, `invoice.paid` and
   `invoice.payment_failed` (the last two bill monthly plans), and put its signing secret in
   `STRIPE_WEBHOOK_SECRET`.

### Push notifications

Push messages need a VAPID key pair. Create one once with `npx web-push generate-vapid-keys` and put it in
`backend/.env` as `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (a `mailto:` address). Without
them push messages are kept as not sent and the apps say push is not set up.

### Twilio

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER` (international format). Required
in production; sign-in is impossible without it.

## Deploying

1. Build: `npm ci && npm run build` in both folders. The API runs with `npm start` (`node dist/server.js`).
   `web/dist` is the customer and pro app and `web/dist-admin` the admin control panel: static files for any
   web host or CDN, each with every unknown path served `index.html`.
2. Serve all three over HTTPS on the same site (for example `api.misk.app`, `misk.app` and `admin.misk.app`),
   so the session cookies work. Set `WEB_ORIGIN` to the app's exact origin, `ADMIN_ORIGIN` to the control
   panel's, and `NODE_ENV=production`. Admins can sign in only on the control panel, everyone else only in
   the app, and each site has its own session.
3. Behind a reverse proxy, set `TRUST_PROXY=true` so rate limits see real client addresses.
4. Run `npm run migrate` before each release, and `npm run user:create-first-admin` once. Further admins
   are added under **Team** in the control panel.
   - **Forgotten admin password:** "Forgot password?" on the admin sign-in emails a single-use link, valid
     for 30 minutes, to the admin's recovery email (set under **Team**). This needs the SMTP settings in
     `backend/.env`. Without an email on the account, another admin sets a new password under **Team**, or
     run `npm run user:reset-password` on the server.
5. `UPLOAD_DIR` holds pro documents and job photos: put it on persistent, backed-up storage.
6. Health check: `GET /health` returns 200 when the database is reachable.

## Before launch

These are open owner decisions; see `QUESTIONS.md`.

- [ ] The in-app terms (`/terms`) reviewed by a lawyer with the legal entity name, the privacy policy written, and `VITE_TERMS_URL` / `VITE_PRIVACY_URL` set (Q7).
- [ ] SMTP configured: email sign-up sends a confirmation link and cannot complete without it (D39).
- [ ] Pilot city, its time zone and served postcodes (Q2).
- [ ] Pros' share and service fee confirmed (Q4, Q5); cancellation policy within 24 hours (Q3).
- [ ] VAT treatment and invoices checked with an accountant (Q8).
- [ ] Customers' and pros' consent to texts and data storage recorded at sign-up.
- [ ] Stripe account verified for live payments and Connect payouts in the pilot country.
