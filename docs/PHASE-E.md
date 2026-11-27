# Phase E: pages, concierge calls and the partner layer

E3 (invite links, referrals) and E4 (group coordination of 10 to 100 people) are not built and are out of scope. The groups the agent may answer in (Phase A) are a different, smaller feature and stay.

## E5: shareable pages (`INSTINCT_PAGES=1`)

The owner asks for a poll, a sign-up list or an RSVP. `page_create` returns a public link `INSTINCT_PUBLIC_URL/p/<id>`.

- The page is plain HTML, no scripts, a strict Content-Security-Policy, every value escaped, Arabic (right to left) by default or English.
- Limits: 2 to 10 poll options, up to 500 responses, a name of at most 60 characters, a note of at most 300, 5 responses per visitor per hour, open for 14 days by default (up to 90).
- Sign-up and RSVP refuse a repeated name. Poll voters see the tally after voting; for sign-up and RSVP only the owner sees the names (`page_results`). The owner can close a page (`page_close`).
- Code: `packages/server/src/pages.ts`. Routes `/p/<id>` sit before the owner-token check because the random id is the credential.

## E6: concierge calls

A standing mandate replaces the per-call yes. `concierge_mandate_set` (always asked, owner only) lists the numbers, the purposes, the hours, a daily cap and a per-number cap, and an expiry. `concierge_call` (capability `phone.concierge`, owner only) refuses anything outside it, places the call through Inkbox Voice AI, logs it and audits it. The result reaches the owner by text when the call ends, as for any call. `phone_call` is unchanged and still asks every time. Code: `packages/inkbox/src/concierge.ts`. See [PERMISSIONS.md](PERMISSIONS.md).

## E1 and E2: the partner layer (foundation, no partner connected yet)

`packages/network/src/partners.ts`.

- **E1, the protocol (`OPP/1`).** A typed request (domain, intent, subject, details, idempotency key) and a typed answer (ok, needs_info, proposal, declined, error). Domains: health, restaurants, travel, retail, government, utilities, other. Intents: info, quote, availability, status, book, order, cancel.
- **E2, the connectors.** One adapter per partner implements `PartnerConnector` and is registered in `PartnerRegistry` (in `server/src/boot.ts`). Nothing else changes when a partner joins.
- **Tools.** `partner_list`, `partner_request`, `partner_confirm`. With no partner connected they say so and point to the web and phone fallback.
- **Booking is two steps.** `book`, `order` and `cancel` never commit in `partner_request`: the partner returns a proposal, the owner says yes, then `partner_confirm` commits that proposal once, within 30 minutes. Money still moves only through the payment tools.
- Honest limit: `partner_confirm` relies on the agent having the owner's yes (as the other commit tools do). Treat a partner connection as something to harden with the owner-ask path before partners with real money join.

To connect a partner: write a `PartnerConnector`, register it, add its test. The fake partner in `packages/network/test/partners.test.ts` is the template.

## C5 over A2A

Encrypted files and keys between agents now work over A2A. Flow: each owner runs `e2ee_share_keys_a2a` to the other's agent, checks the fingerprint with them another way, and pins the keys (`e2ee_pin_peer`). Then `e2ee_send_file_a2a` seals a workspace file (up to 2 MB) for that peer. The receiver verifies the signature against the pinned key, decrypts into `workspace/received/`, and treats the content as untrusted. A forged sender label, a changed byte or an unpinned sender is refused.
