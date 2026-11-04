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
| Q6 | Tips (shown in the demo's review screen). | Not in Phase 1; ratings only. |
| Q7 | Terms of service and privacy policy text, and the legal entity name. | Not written by the developer. The sign-in screen links to `TERMS_URL` and `PRIVACY_URL` from the web configuration, and the README's launch checklist lists both as blockers. |
| Q8 | VAT treatment of prices and invoices to customers. | Prices are shown as final consumer prices including VAT; Stripe receipts are emailed only if the customer gives an email. Invoices are not generated. |
| Q9 | Should pros set different hours per day? The demo says "you can change hours per day later". | Slots start 08:00–18:00 every two hours on the chosen working days, and a job must end by 20:00. |
| Q10 | The demo says "you can add the other role later". Can one phone number be both a customer and a pro? | No: the role chosen at first sign-in is final. A pro who also wants to book uses a second number. |
| Q11 | Should a pro who is suspended keep their already accepted jobs? | Yes; admins reassign them from the booking list if needed. |
