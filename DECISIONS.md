# Decisions

Each entry: what was decided, why, and when. Newest last.

| ID | Date | Decision | Why |
| -- | ---- | -------- | --- |
| D1 | 2026-11-04 | MISK is its own repository, not part of `shb-solutions`. | SHB forbids any price in its code by an automated check; MISK is built around prices. Two products, two histories. |
| D2 | 2026-11-04 | Same stack as SHB: Node 24, Fastify, PostgreSQL with `node-pg-migrate`, React 19 + Vite, Vitest, Playwright. | Proven in the sibling project; one set of tools to run and maintain. |
| D3 | 2026-11-04 | Phase 1 first: one-off bookings, payments, pro onboarding, dispatch, admin. Monthly plans come after the Phase 1 gate. | The demo's own roadmap; gives a usable product soonest. |
| D4 | 2026-11-04 | Phase 1 ships as one responsive web app with three areas (`/`, `/pro`, `/admin`). Native apps are Phase 3. | The demo's roadmap puts native apps in Phase 3; the web app reuses the same API. |
| D5 | 2026-11-04 | Stripe Connect: card held with a manual-capture PaymentIntent, captured on completion, pro paid by a separate transfer to their Express account, weekly Friday payouts. | The pro is chosen only after booking, so a destination charge at booking time is impossible. Separate charges and transfers fit dispatch. |
| D6 | 2026-11-04 | Bookings can be made at most 6 days ahead. | Card holds expire after 7 days; the job must finish while the hold is valid. |
| D7 | 2026-11-04 | Coverage uses served postcodes with centre coordinates managed by admins; a pro covers a postcode when it is within their travel distance of their home postcode. | Keeps the demo's travel-distance slider without a paid geocoding service. |
| D8 | 2026-11-04 | Prices are integer euro cents everywhere. Size multipliers are stored per service as percentages (default S 100, M 130, L 170, from the demo). | No floating-point money. |
| D9 | 2026-11-04 | Customers and pros sign in with a 6-digit SMS code; admins with username and password. Apple and Google sign-in wait for accounts (see `QUESTIONS.md` Q1). | Phone sign-in needs only Twilio, which the team already uses. |
| D10 | 2026-11-04 | Without Twilio settings, sign-in codes are written to the API log, and only when `NODE_ENV` is not `production`; production refuses to start without Twilio. | Local development works offline; production can never silently drop codes. |
| D11 | 2026-11-04 | Production refuses to start without Stripe settings. Tests and the end-to-end server inject a fake payment gateway that lives under `test/`. | No booking can ever be taken without real payment in production. |
| D13 | 2026-11-04 | A slot is offered when free eligible pros outnumber the same trade's bookings at that time that are still waiting for a pro. Bookings in one trade are taken one at a time (advisory lock), and a database constraint stops any pro holding two overlapping jobs. | Never promises a pro who is not there. Counting demand per trade, not per postcode, may hide a slot at busy times; it never overbooks. |
| D14 | 2026-11-04 | Dispatch order: highest average rating (4.5 assumed for a new pro), then fewest jobs in the last 7 days, then shortest distance. One offer at a time, 15 minutes each. | The demo: "offered to the best-rated free pro nearby"; spreading work keeps new pros engaged. |
| D15 | 2026-11-04 | Completion needs at least one photo. Unanswered extra work is dropped at completion. Capture and payout run right after completion and are retried every minute until done. | The demo's "add photos & complete"; nothing is charged without approval; a provider outage never loses money. |
| D12 | 2026-11-04 | Uploads (documents, photos) are stored on local disk under `UPLOAD_DIR` with random names, checked by content signature (JPEG, PNG, PDF), at most 8 MB each, and served only through access-checked routes. | Simple to run for a one-city pilot; storage sits behind one module so it can move to object storage. |
