# HANDOFF: where the work stands

Read this first in a new chat. It says what is done, what is left, how to work, and what to watch out for.
Last updated after **Phase A was closed** (all tests green, build clean). **Next: Phase B.**

## The project in one paragraph

Open Instinct is an open-source, self-hostable personal AI agent you talk to by message (iMessage, SMS, email,
WhatsApp, Telegram). It is a re-implementation of the closed product "Instinct" (by Noah Shinn / Spear Street
Technology), built from public information only; we never saw their code. The goal of this fork: a professional,
Arabic-first, privacy-first product that can compete as a niche player (not head-on with Meta or OpenAI).
Architecture: Inkbox (messaging identity) -> gateway (stateless relay, signup, Telegram hub) -> Maritime microVM per
user -> server -> core (Pi agent loop, policy, memory, scheduler, audit) with tool packages around it.
Docs: `README.md`, `docs/ARCHITECTURE.md`, `docs/PERMISSIONS.md`, `docs/SECURITY.md`, `docs/research/INSTINCT.md`
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
pnpm --filter @open-instinct/core test    # one package
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
`TELEGRAM_GATEWAY_TOKEN` (set by the gateway), `STT_*`, `INSTINCT_OWNER_LANGUAGE`, `INSTINCT_OWNER_LOCALE`.

## Done: Phase B1 (proactive triggers)

The agent scans Gmail and Google Calendar by itself and texts the owner first. Code only, no model call: `core/triggers.ts` (engine, detectors, quiet hours, dedupe), `apps/triggers-source.ts` (Composio reader), `Scheduler.ensureSystem` plus `ScheduleEntry.task` (the scan is a schedule entry so Maritime wakes the VM), `AgentRuntime.notifyOwner`, wiring in `server/boot.ts`. Details and limits: `docs/TRIGGERS.md`.

- Off by default. `INSTINCT_TRIGGERS=1` (or `triggers.enabled` in config.json) and a Composio session with Gmail/Calendar connected. `INSTINCT_QUIET_HOURS=23:00-07:00`.
- Detects: unanswered invite (72 h ahead, again under 24 h), birthday (day before and day of), flight change / cancelled / missing from the calendar, and mail whose subject looks like a flight change (English and Arabic).
- An alert counts as sent only after the channel took it; quiet hours hold all but an urgent flight alert (departs within 12 h).
- **B1 hardening (second pass):** broader trip detection using title, airport place and `fromGmail` event type, with look-alike exclusions and owner corrections (`trigger_feedback`); mail alerts say they rest on the subject only; a vanished plan is checked against a 90+ day read before it is called missing; moves under `flightChangeMinutes` ignored; extra birthday shapes plus owner marking; mute or pause by chat (`trigger_mute`, `trigger_unmute`, `trigger_status`); ordinary alerts grouped into one message; one-time welcome; `inviteSoonHours` and `urgentFlightHours` configurable; audit kind `trigger`.
- **Not verified live.** Tested against fakes. The slugs `GOOGLECALENDAR_EVENTS_LIST` and `GMAIL_FETCH_EMAILS` and the response field names must be confirmed once with a real Composio account.

## Done: Phase B2 to B5

Details and limits in `docs/PROACTIVE.md`.

- **B2** `core/habits.ts` learns the sleep window from message hours (no text); `Scheduler.start` takes a `hold` callback and `ScheduleEntry.waitForWake` (tool arg `wait_for_wake`); triggers use the learned quiet window.
- **B3** `core/memory-search.ts` + tool `memory_search`: words by default, meaning with `INSTINCT_SEMANTIC_MEMORY=1` and an embeddings key (opt-in, sends memory text out).
- **B4** `core/preferences.ts` + tools `preference_note`, `booking_brief`, `preference_forget`. Stated wins; a choice repeated 3 times becomes learned; ties are asked, not guessed.
- **B5** `core/places.ts`, `LocationService`, tools `place_save`, `arrival_reminder`, `where_am_i`, `place_remove`, route `POST /location`. Off unless `INSTINCT_LOCATION=1`.
- All new owner tools use the existing `memory.write` capability (owner only), so the permission table is unchanged.
- Not verified live: iPhone automation, a real embeddings service, Composio slugs (B1).

## Not done yet (in order the user asked)

| Phase | Items |
|---|---|
| A (closed) | Nothing open. Only carried to the live test phase: run the checklist at the end of `docs/IPHONE-SHORTCUT.md` on a real iPhone |
| **B** proactive + memory (B1 to B5 done) | ~~B1 triggers~~ (done, see below), B2 sleep/wake scheduling by habit, B3 semantic memory search, B4 learned preferences applied to bookings, B5 location and arrival awareness (note: there is **no B6**) |
| **C** security (all) | C1 content firewall for every inbound message and attachment, C2 separate action monitor (block or ask before execution), C3 hallucination / grounding checker, C4 signed tool identity and short-lived credentials, C5 end-to-end encrypted files between agents, C6 vault (logins, cards, addresses), C7 TOTP, C8 1Password broker, C9 external audit and pen test (needs outside people) |
| **D** | D1 spending budget (autonomous within a limit; needs a payment rail and API access), D5 compensation-claim skill |
| **E** (all) | E1 business-agent protocols (PAP / PACT style; needs partners), E2 domain connectors (health booking etc.; needs partner APIs), E3 revocable invite links and referrals, E4 group coordination of 10 to 100 people incl. non-users, E5 shareable interactive pages, E6 Concierge calls without per-call approval |
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
- Brand: "Open Instinct" is too close to the original and to Merit Systems' OpenInstinct; pick a new name before any public launch.
- Payments (Stripe Link) are US-only today; a non-US launch needs another rail (D3 is deferred).
- Business reality: a code-only sale is worth a fraction of rebuild cost (MIT license, no users). Value comes from users, trust and a niche (Arabic, WhatsApp/Telegram, privacy, open audit).

## Security notes

- A GitHub personal access token was pasted into the chat. **Revoke it** at GitHub, Settings, Developer settings, Personal access tokens, and use a new one only when needed.
- `.gitleaks.toml` has a Telegram bot token rule. Never commit `.env` files or tokens.

## Test counts at this checkpoint

core 416, gateway 84, server 134, telegram 25, media 12, inkbox 174 (+1 skipped), cli 88, network 69, payments 67,
apps 172, computer 43, atomicmail 53, ample 25, keenable 11, whatsapp 6, context 3. Source about 21.4k lines, tests about 16.8k.
