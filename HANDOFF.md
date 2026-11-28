# HANDOFF: where the work stands

Read this first in a new chat. It says what is done, what is left, how to work, and what to watch out for.
Last updated after **Phase E**. Phases A, B1 to B5, C1 to C8, D and E are done. **Next: a live test phase, then Phase F.**

## Rename: Instinct to Orion (done)

Everything the owner or a tester can see now says Orion: the `orion` command, `ORION_*` settings, the `.orion` state folder, `@orion-ai/*`, tool names `ask_orion` / `reply_orion`, the `X-Orion-Token` header, and the agent's own name. Old `INSTINCT_*` settings still work: `applyLegacyEnv` (core) copies them to `ORION_*` at start. State written to `.instinct` by an older run is not migrated (move the folder to `.orion`). The GitHub repository is now `omarmo46-max/orion-ai` (renamed from the old name; GitHub redirects the old URL). `docs/research/` and this file still discuss the competitor by name on purpose; keep them out of anything testers see.

## The project in one paragraph

Orion AI is an open-source, self-hostable personal AI agent you talk to by message (iMessage, SMS, email,
WhatsApp, Telegram). It is a re-implementation of the closed product "Instinct" (by Noah Shinn / Spear Street
Technology), built from public information only; we never saw their code. The goal of this fork: a professional,
Arabic-first, privacy-first product that can compete as a niche player (not head-on with Meta or OpenAI).
Architecture: Inkbox (messaging identity) -> gateway (stateless relay, signup, Telegram hub) -> Maritime microVM per
user -> server -> core (Pi agent loop, policy, memory, scheduler, audit) with tool packages around it.
Docs: `README.md`, `docs/ARCHITECTURE.md`, `docs/PERMISSIONS.md`, `docs/SECURITY.md`, `docs/PHASE-C-SECURITY.md`, `docs/research/INSTINCT.md`
(what the original does), `docs/research/REQUIREMENTS.md`.

## How to work (the user's rules)

1. **Accuracy and professionalism first.** Every feature ships with tests; the build and the full suite stay green
   before moving on. Say plainly what was tested only against fakes and what needs a live account.
2. **Save credits:** read only the code you will change; batch edits in one command (a small Python `sub(path, old, new)`
   helper that asserts the anchor exists); run only the affected package tests, the full suite once per phase; keep
   replies short. No long recaps.
3. **Reply in Egyptian Arabic** (the user writes Arabic); keep code, comments and docs in English.
4. Be honest about limits (legal, partnerships, audits, live tests). Never claim a feature works on a real
   service if it was only tested with a fake.
5. One phase at a time, a short report at the end of each, then the next. The user says "كمّل" to continue.
6. Never write secrets into files. The user shared a GitHub token in chat: it must be revoked (see "Security notes").

## Commands

```bash
# Node >= 22.19, pnpm 10
pnpm install
pnpm build            # tsc for every package (order is handled by pnpm)
pnpm test             # every package; ~1,000 tests
pnpm --filter @orion-ai/core test    # one package
```

## Done: Phase A (A1 to A8), closed

Phase A is closed by the owner's decision. The two leftovers are fixed in code and docs: the iPhone Shortcut guide (`docs/IPHONE-SHORTCUT.md`, `examples/voice-check.mjs`) and the agent with its own Telegram bot plus a gateway (own bot wins; gateway events refused; one note to the person). Honest limit that carries into the live test phase: the Shortcut has not been run on a real iPhone, and everything is tested against fakes only.


| # | What | Where |
|---|---|---|
| Telegram channel | Bot API long polling, private chats, media download, 4096 split, typing, `sendFile` (photo or document), opt-in groups, offset file | `packages/telegram` |
| Telegram identity | numeric user id is identity (never @username); `owner.telegramIds`, contact `telegramIds` (capped at partner), `TELEGRAM_OWNER_ID`, owner claim with `/start <code>` | `core/principal.ts`, `config.ts`, `owner-claim.ts`, `runtime.ts` |
| A1 group agent | silent until the owner allows (`groups` tool); allowed group = one principal `group:<chat>` with `GROUP_ROW` (converse, web.read, owner.relay, group.notes); no owner memory, instructions, skills, setup or city in its prompt; rate limit 20/10 min and 60/hour; per-group notes; speaker labels | `core/groups.ts`, `group-tools.ts`, `policy.ts`, `runtime.ts`, `prompt.ts`, `docs/PERMISSIONS.md` (Groups) |
| A2 speech to text | any OpenAI-compatible `/audio/transcriptions` (`STT_API_KEY` or `OPENAI_API_KEY`, `STT_BASE_URL`, `STT_MODEL`, `STT_LANGUAGE`) | `packages/media/transcribe.ts` |
| A3 images and documents | images go to the model when it can see (non-stranger, non-group); PDF (unpdf), DOCX (mammoth), text formats read and wrapped as untrusted | `core/attachments.ts`, `packages/media` |
| A4 voice endpoint | `POST /voice` (audio body, owner surface) returns transcript + answer; Shortcut guide `docs/IPHONE-SHORTCUT.md`, check script `examples/voice-check.mjs` | `server/http.ts` (**not yet run on a real iPhone**) |
| A5 `/new` | `/new`, `/reset`, `محادثة جديدة`... clears the thread, keeps durable memory | `core/runtime.ts`, `i18n.ts` |
| A6 shared Telegram bot | gateway `TelegramHub`: one bot for many agents; link code via connect page (30 min, single use); agents call the hub's agent API with their own token and can only write to their owner's chat; files fetched through the hub on demand; `telegram.message` and `telegram.link` events | `gateway/telegram-hub.ts`, `store.ts`, `provision.ts`, `pages.ts`, `telegram/remote.ts`, `core/envelope.ts`, `server/http.ts`, `boot.ts` |
| A7 send_file | `send_file` attaches on Telegram and WhatsApp conversations; to a Telegram-only owner | `inkbox/tools.ts`, `telegram`, `whatsapp` |
| A8 Arabic | Arabic yes/no in approvals, language prompt layer (dialect mirroring), `owner.language` / `owner.locale`, localized acks and `/new`, `detectLanguage` | `core/i18n.ts`, `approvals.ts`, `prompt.ts` |

Env added: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, `TELEGRAM_ENABLED`, `TELEGRAM_GROUPS`, `TELEGRAM_GATEWAY_URL`,
`TELEGRAM_GATEWAY_TOKEN` (set by the gateway), `STT_*`, `ORION_OWNER_LANGUAGE`, `ORION_OWNER_LOCALE`.

## Done: Phase B1 (proactive triggers)

The agent scans Gmail and Google Calendar by itself and texts the owner first. Code only, no model call: `core/triggers.ts` (engine, detectors, quiet hours, dedupe), `apps/triggers-source.ts` (Composio reader), `Scheduler.ensureSystem` plus `ScheduleEntry.task` (the scan is a schedule entry so Maritime wakes the VM), `AgentRuntime.notifyOwner`, wiring in `server/boot.ts`. Details and limits: `docs/TRIGGERS.md`.

- Off by default. `ORION_TRIGGERS=1` (or `triggers.enabled` in config.json) and a Composio session with Gmail/Calendar connected. `ORION_QUIET_HOURS=23:00-07:00`.
- Detects: unanswered invite (72 h ahead, again under 24 h), birthday (day before and day of), flight change / cancelled / missing from the calendar, and mail whose subject looks like a flight change (English and Arabic).
- An alert counts as sent only after the channel took it; quiet hours hold all but an urgent flight alert (departs within 12 h).
- **B1 hardening (second pass):** broader trip detection using title, airport place and `fromGmail` event type, with look-alike exclusions and owner corrections (`trigger_feedback`); mail alerts say they rest on the subject only; a vanished plan is checked against a 90+ day read before it is called missing; moves under `flightChangeMinutes` ignored; extra birthday shapes plus owner marking; mute or pause by chat (`trigger_mute`, `trigger_unmute`, `trigger_status`); ordinary alerts grouped into one message; one-time welcome; `inviteSoonHours` and `urgentFlightHours` configurable; audit kind `trigger`.
- **Not verified live.** Tested against fakes. The slugs `GOOGLECALENDAR_EVENTS_LIST` and `GMAIL_FETCH_EMAILS` and the response field names must be confirmed once with a real Composio account.

## Done: Phase B2 to B5

Details and limits in `docs/PROACTIVE.md`.

- **B2** `core/habits.ts` learns the sleep window from message hours (no text); `Scheduler.start` takes a `hold` callback and `ScheduleEntry.waitForWake` (tool arg `wait_for_wake`); triggers use the learned quiet window.
- **B3** `core/memory-search.ts` + tool `memory_search`: words by default, meaning with `ORION_SEMANTIC_MEMORY=1` and an embeddings key (opt-in, sends memory text out).
- **B4** `core/preferences.ts` + tools `preference_note`, `booking_brief`, `preference_forget`. Stated wins; a choice repeated 3 times becomes learned; ties are asked, not guessed.
- **B5** `core/places.ts`, `LocationService`, tools `place_save`, `arrival_reminder`, `where_am_i`, `place_remove`, route `POST /location`. Off unless `ORION_LOCATION=1`.
- All new owner tools use the existing `memory.write` capability (owner only), so the permission table is unchanged.
- Not verified live: iPhone automation, a real embeddings service, Composio slugs (B1).

## Done: Phase C (C1 to C8)

Details, settings and limits in `docs/PHASE-C-SECURITY.md`. C9 (outside audit and penetration test) is not done: it needs outside people.

- **C1** `core/firewall.ts`: inbound text and attachments scored; allow, warn (taints the conversation 30 min) or block (strangers only, silent). **C2** `core/action-monitor.ts`: ask or block before a tool runs (secrets in arguments, stored credentials, tainted conversation, bursts). **C3** `core/grounding.ts`: unsupported figures, links, codes and claimed actions get a note.
- **C4** `core/tool-identity.ts`: Ed25519 identity, pins for outside tools (Composio, MCP; quarantine on change), signed manifest, short-lived credentials. **C5** `core/e2ee.ts`: X25519 + AES-256-GCM files between agents with pinned peers. Now wired into A2A (see Phase E fix below).
- **C6** `core/vault.ts` + `core/secrets-broker.ts`: encrypted vault, `{{secret:...}}` references filled in after approval and scrubbed from results. **C7** `core/totp.ts`: RFC 6238 and step-up. **C8** `core/onepassword.ts`: 1Password through the `op` CLI with an allowed-vault list.
- Wiring: `RuntimeDeps.security` (interface in `security-types.ts`, implemented by `SecurityLayer`), hooks in `runtime.ts` (inbound, guard, recordToolCall, reply), `ToolMeta.secretAccess` / `acceptsSecrets`, `ToolRegistry.remove`, boot in `server/boot.ts`, owner tools in `core/security-tools.ts`.
- Second pass: pins watch only `meta.external` tools (set in `apps/wrap.ts`); tool results are scanned and taint the conversation (`inspectToolResult`); owner approval of credential use is a signed single-use `CredentialIssuer` token; secret-reveal tools are no longer scrubbed and are withheld from the audit; security events have audit kind `security`; the audit log is hash-chained (`AuditLog.verify`, tool `audit_verify`).
- Behavior change to know about: a reply that states a figure, link or code nobody supplied now ends with a plain note; set `ORION_GROUNDING=off` to remove it.
- Not verified live: a real 1Password account, a real authenticator app, a browser filling a login, real attackers.

## Done: Phase D

- **D1** EGP budget rail, `packages/payments/src/egp/`, opt-in with `EGP_WALLET=1`; details in `docs/PAYMENTS-EGYPT.md`. Vodafone Cash temporary cards are made by the owner by hand; budget, holds, single-use card pickup and the private card page are built. A partner API plugs in through `AutomaticCardIssuer`. Stripe Link is untouched. Not verified live.
- **D5** `skills/compensation-claims/SKILL.md`: evidence, claim, Arabic/English drafts, approval, follow-up, escalation.

## Done: Phase E (decided with the owner: E5, E6, and the foundation of E1 and E2; E3 and E4 dropped)

Details in `docs/PHASE-E.md`.

- **E5** shareable polls, sign-ups and RSVPs (`ORION_PAGES=1`), `server/src/pages.ts`.
- **E6** concierge calls under a standing mandate, `inkbox/src/concierge.ts`, new capability `phone.concierge`; `phone_call` still asks every time.
- **E1 + E2 foundation** the partner layer `OPP/1` and `PartnerConnector`, `network/src/partners.ts`; no partner connected yet.
- **E3 (invite links, referrals) and E4 (group coordination of 10 to 100) are dropped**: not built, no code. Phase A's allowed-groups feature stays.
- Not verified live: real calls, real visitors on a public page, a real partner.

## Fix after Phase E: C5 wired into A2A

`network/src/e2ee-a2a.ts`: encrypted files and key exchange now travel over A2A as one data part (`e2ee: "1"`). Tools `e2ee_share_keys_a2a` and `e2ee_send_file_a2a` (owner only, files up to 2 MB, inside the workspace). The receiver (`server/src/hooks.ts`, `makeDescribeDataPart`) decrypts a file from a pinned peer into `workspace/received/` and tells the model it is untrusted; unpinned, forged or changed files are not opened. Keys that arrive are never trusted on sight: the owner confirms the fingerprint, then `e2ee_pin_peer`. Tested end to end with two agents (`network/test/e2ee-a2a.test.ts`). E5 is also checked through the real boot and HTTP (`server/test/phase-e-boot.test.ts`).

## Website (`packages/web`) and custom model fallback

English only, light theme, MongoDB accounts, email verification codes, 8 public pages (see `packages/web/README.md`). Public pages are separate routes; the "Sign up now" button is at the top left and opens a dialog with Create account and Sign in. All 16 dashboard pages are live (there is no chat page in the website by design): Overview, Approvals, Activity, Apps, Channels, People, Schedules, Memory, Skills, Pages, AI model, Payments, Security, Connection, Account, Data. They read the agent through the read-only owner API (`server/src/owner-api.ts`, `GET /owner/<resource>`); changes go through chat commands so approvals and step-up still apply.

Bring your own model: the dashboard stores the key encrypted and sends it to the agent (`PUT /model`). `server/src/custom-model.ts` wraps the model stream: the custom model is used while it works; when it fails before any output the same turn goes to the default model, the owner is told once, and the dashboard shows "Stopped"; it retries after 10 minutes and says when it is back. Tests: `web/test/web.test.ts`, `server/test/custom-model.test.ts`, `server/test/phase-e-boot.test.ts`.

Not verified live: MongoDB (tests use an in-memory store with the same interface), a real mail transport (codes are logged), real provider keys, and the visual design in a browser.

## Not done yet (in order the user asked)

| Phase | Items |
|---|---|
| A (closed) | Nothing open. Only carried to the live test phase: run the checklist at the end of `docs/IPHONE-SHORTCUT.md` on a real iPhone |
| **B** proactive + memory (B1 to B5 done) | ~~B1 triggers~~ (done, see below), B2 sleep/wake scheduling by habit, B3 semantic memory search, B4 learned preferences applied to bookings, B5 location and arrival awareness (note: there is **no B6**) |
| **C** security (all) | C1 content firewall for every inbound message and attachment, C2 separate action monitor (block or ask before execution), C3 hallucination / grounding checker, C4 signed tool identity and short-lived credentials, C5 end-to-end encrypted files between agents, C6 vault (logins, cards, addresses), C7 TOTP, C8 1Password broker, C9 external audit and pen test (needs outside people) |
| **D** | D1 spending budget (autonomous within a limit; needs a payment rail and API access), D5 compensation-claim skill |
| **E** (done) | E5, E6 and the foundation of E1 and E2 are built, see above. E1 and E2 wait for real partners. E3 and E4 are dropped |
| **F** (all) | F1 web console for users (connectors, vault, settings, delete data) plus a professional marketing site (study the original's buttons and copy; **same principles, original text and design, no copying**; placeholder brand name in one file), F2 accounts, login, billing, F3 status page and alerts, F4 per-user usage and cost, F5 backup and restore, F6 export and delete from chat, F7 readable action log with undo, F8 terms, privacy, brand (needs a lawyer; drafts only), F9 browser on the user's device (residential IP) |
| Left out on purpose | D2 Shop Pay, D3 local payment rails, D4 subscription audit, Selections, Mac app, WHOOP, the G opportunities (local services, local models, skills marketplace, family plans). Decide together at the end |

## Known limits and decisions to remember

- Everything was tested against fakes (fake Bot API, fake STT, fake gateway relay). **No live iMessage, Maritime, WhatsApp or Telegram run yet.** A live test phase is required before launch.
- Telegram groups work only with a bot per agent (`TELEGRAM_GROUPS=1`), not through the shared hub bot.
- An agent with its own bot (`TELEGRAM_BOT_TOKEN`) AND gateway env keeps its own bot: gateway `telegram.message` / `telegram.link` events are refused (`blocked`), the owner ids are not rewritten, and the person gets one note per hour pointing to the agent's bot (`GatewayNotices` in `server/boot.ts`). `TELEGRAM_ENABLED=0` prefers the gateway.
- Through the hub, only the linked owner can talk to the agent on Telegram; friends and contacts cannot (they are told to connect).
- Agents provisioned before Phase A have no `agentToken`; they need re-provisioning to use the hub.
- Link codes grant ownership of an agent: the connect page URL (`/connect/<usr_...>`, 64-bit id) is a capability and must stay private.
- WhatsApp uses Baileys (unofficial; ban risk; use a dedicated number).
- Brand: "Orion AI" is too close to the original and to Merit Systems' OpenInstinct; pick a new name before any public launch.
- Payments (Stripe Link) are US-only today; a non-US launch needs another rail (D3 is deferred).
- Business reality: a code-only sale is worth a fraction of rebuild cost (MIT license, no users). Value comes from users, trust and a niche (Arabic, WhatsApp/Telegram, privacy, open audit).

## Security notes

- A GitHub personal access token was pasted into the chat. **Revoke it** at GitHub, Settings, Developer settings, Personal access tokens, and use a new one only when needed.
- `.gitleaks.toml` has a Telegram bot token rule. Never commit `.env` files or tokens.

## Test counts at this checkpoint

core 483, gateway 84, server 134, telegram 25, media 12, inkbox 174 (+1 skipped), cli 88, network 69, payments 67,
apps 172, computer 43, atomicmail 53, ample 25, keenable 11, whatsapp 6, context 3. Source about 21.4k lines, tests about 16.8k.
