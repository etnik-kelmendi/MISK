# Open questions

Each question records the default that is built until the owner answers. Answered questions move to
`DECISIONS.md`.

| ID | Question | Default built |
| -- | -------- | ------------- |
| Q1 | Should customers and pros also sign in with Apple and Google? Needs an Apple developer account and a Google OAuth client. | Phone code only. |
| Q2 | Which city is the pilot, and which postcodes are served? | None seeded; admins add postcodes with their centre coordinates in the control panel. |
| Q3 | Cancellation within 24 hours of the slot: allowed with a fee, or not allowed in the app? | Customers can cancel free until 24 h before; after that only an admin can cancel and refund. |
| Q4 | Pros' share of the job price. The demo shows 82%. | 82% of the job price and of approved extra work; the service fee goes to MISK. Admins can change it. |
| Q5 | Service fee per booking. The demo shows €2.90. | €2.90, editable by admins. |
| Q6 | Tips (shown in the demo's review screen). | Answered by the Settings story: tips are taken after the job and split by the commission (D34). |
| Q7 | Terms of service and privacy policy text, and the legal entity name. | Not written by the developer. The sign-in screen links to `TERMS_URL` and `PRIVACY_URL` from the web configuration, and the README's launch checklist lists both as blockers. |
| Q8 | VAT treatment of prices and invoices to customers. | Prices are shown as final consumer prices including VAT; Stripe receipts are emailed only if the customer gives an email. Invoices are not generated. |
| Q9 | Should pros set different hours per day? The demo says "you can change hours per day later". | Slots start 08:00–18:00 every two hours on the chosen working days, and a job must end by 20:00. |
| Q10 | The demo says "you can add the other role later". Can one phone number be both a customer and a pro? | No: the role chosen at first sign-in is final. A pro who also wants to book uses a second number. |
| Q11 | Should a pro who is suspended keep their already accepted jobs? | No longer open: suspending hands booked jobs and plans to other pros (D29). Jobs already under way stay. |
| Q12 | Should people who register by email get "Forgot password?" too, and should pros who registered by email be asked for a phone number for job-offer texts? | Not yet: email-registered customers and pros have no password reset, and get no text messages until they have a phone number. |
| Q13 | The Providers story says "according to the provided design", but the demo file has no Providers screen. | Built in the style of the other admin pages (key numbers, tabs with counts, table, side panel). Send the design to match it exactly. |
| Q14 | A monthly plan whose pro is suspended and for whom no free pro is found keeps billing. Should its billing pause until a new pro is set? | Billing continues; the admin sees the count when suspending, and the customer is texted. |
| Q15 | Does "book a coaching call" need a calendar invite or a call log? | The admin picks a date and time; the pro gets a text, and the call is shown in the profile and the activity log. |
| Q16 | The Catalogue story also says "according to the provided design", but the demo has no Catalogue design. Should the size explanations differ per trade (e.g. lawn area for gardening, rooms for cleaning)? | Built in the style of the other admin pages. One explanation per size for every trade: Small (a balcony, one room or a small garden), Medium (a flat, or a garden up to about 150 m²), Large (a house, several rooms or a large garden). |
| Q17 | The Settings story also mentions "the provided design", which is not in the demo. | Built in the style of the other admin pages. |
| Q18 | "Push" for customers and pros: the apps are web apps until Phase 3. | Web Push to the app on phones and computers, turned on per device under Account. Native push comes with the native apps. |
| Q19 | What exactly may Operations, Support and Finance open? | Operations: day-to-day (bookings, providers, plans, catalogue, area, notifications). Support: bookings and providers. Finance: bookings and fees & payments. Admin: everything (D35). |
| Q20 | When should the evening reminder and the rating request go out? | Reminder from 18:00 the day before; rating request 2 hours after the job, once, if not rated. |
| Q21 | Should a refund also give back the customer's tip? | No: the tip stays with the pro unless the team refunds it in Stripe. |
