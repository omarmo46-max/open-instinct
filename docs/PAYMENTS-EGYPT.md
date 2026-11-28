# Payments in Egyptian pounds (EGP rail)

Stripe Link (see [PAYMENTS.md](PAYMENTS.md)) is unchanged and still the US/Canada rail. The EGP rail runs beside it and needs no Stripe keys. Turn it on with `EGP_WALLET=1`.

## Why it works this way

Vodafone Cash can create a temporary online-payment card that works for 24 hours. We found no public API that lets software create one, so today the owner creates the card by hand. The budget, not the card, is what keeps the agent in bounds. When a partner offers an API, only an issuer adapter changes.

## Flow

1. The owner sets a budget once: `egp_budget_set` (pool, per-purchase cap, daily cap, on/off). Keep the wallet balance at or above the pool.
2. The agent reaches the checkout and calls `egp_card_request` with the exact total. The budget is checked and a hold is placed.
3. The owner gets plain steps and a private link (30 minutes, single use). They create a temporary card in the wallet app and type it into that page, never into chat.
4. The agent calls `egp_card_pickup` once, pays, then calls `egp_card_done` (`paid` counts the spend, `failed` or `cancelled` releases the hold).

## Security

- Card data lives only in a `0600` file under the state dir, is handed over once, and is deleted on pickup, completion or expiry. It is never written to `egp-cards.json`, the audit log or a message (tested).
- The page link holds a random one-time token (only its SHA-256 is stored, compared in constant time). Card numbers are Luhn-checked.
- Every call is gated by the `purchase` capability and the tier policy; the spend itself is enforced by the EGP budget. Budget changes are owner-only and audited.
- Amounts are kept in piasters. The daily cap uses Cairo time.
- A charge above the approved amount is refused.

## Files

`packages/payments/src/egp/`: `budget.ts`, `cards.ts`, `issuer.ts`, `page.ts`, `tools.ts`, `money.ts`. Server: `egpEnabled` in `payments.ts`, wiring in `boot.ts`, the `/egp/card/...` route in `http.ts`. Set `ORION_PUBLIC_URL` so the private link is reachable from the owner's phone.

## Plugging in a partner

Implement `AutomaticCardIssuer` (`issue({ requestId, piasters, merchant, ttlMs, idempotencyKey })` returns the card and its expiry), pass it in `createEgpRail({ issuers: [...], issuerId })`. The agent, the budget, the tools and the tests stay as they are; the manual step disappears. A test with a fake partner is in `test/egp.test.ts`.

Partners to approach: Vodafone Cash (with its digital-services partner), Fawry, a bank or card issuer with a virtual-card API. What to bring: the flow above, the security notes, user numbers, and the budget model (the owner sets the limit; every purchase is bounded). Questions to ask them: can a server create a single-use card for an exact amount, with the owner's one-time consent? Sandbox access? Fees, limits, and which merchants reject the card?

## Not verified live

Everything is tested against fakes. The real Vodafone Cash card creation, merchant acceptance, and the 24-hour expiry are from public articles and must be checked on a real account before launch.
