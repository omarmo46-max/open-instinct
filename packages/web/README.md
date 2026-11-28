# @orion-ai/web

The website: public pages, email accounts on MongoDB, and a dashboard that talks to each person's own agent.

## Run

```
WEB_MONGODB_URI=mongodb+srv://...   # required in production
WEB_SECRET_KEY=$(openssl rand -base64 32)   # required in production: encrypts API keys and tokens
WEB_PUBLIC_URL=https://your-domain.com
WEB_BRAND="Orion AI"           # optional
pnpm --filter @orion-ai/web build && pnpm --filter @orion-ai/web start
```

Without `WEB_MONGODB_URI` it runs on in-memory storage for local trials (accounts are lost on restart).
Optional: `WEB_PORT` (default 8090), `WEB_TRUST_PROXY=1` behind a proxy, `WEB_ALLOW_PRIVATE_AGENTS=1` for local development only.
Emails (verification and reset codes) go to the server log until a mail transport is plugged into `Mailer`.

## Pages

Public: Home, Features, How it works, Security, FAQ, Terms, Privacy, Log in / Sign up (a dialog on every page, plus its own pages).
Dashboard (16 pages): Overview, Approvals, Activity, Apps, Channels, People, Schedules, Memory, Skills, Pages, AI model, Payments, Security, Connection, Account, Data and privacy.

Every page shows the assistant's real state, read from its owner API (`GET /owner/<resource>`, behind the owner token, read-only, phones and emails masked, no secrets). Every change is sent to the assistant as a chat command (`POST /app/act`), so approvals, step-up codes and the permission policy apply exactly as in a text message; the assistant's reply is shown once on the next page. Connecting an app opens the app's own sign-in page.

## Connecting an agent

1. In the dashboard open Connection and enter the agent's public https address and its `ORION_CHAT_TOKEN`.
2. The first time, the page shows a callback secret once. Put it on the agent as `ORION_WEB_URL` and `ORION_WEB_SECRET`.
3. The dashboard then reads `/status`, sends dashboard actions to `/chat` as commands, and hands model settings to `PUT /model`.

## Your own AI model

The owner adds a provider, a model name and an API key (Anthropic, OpenAI, Google, OpenRouter, or an OpenAI-compatible endpoint). The key is tested, encrypted (AES-256-GCM) and sent to the agent. The agent (`packages/server/src/custom-model.ts`) uses it while it works. If it fails before producing output, the same turn is answered by the default model, the owner is told, and the dashboard shows "Stopped". After 10 minutes it tries the owner's model again, and says when it is back.

## Security notes

Passwords: scrypt. Sessions: random cookie (hash stored), HttpOnly, SameSite=Lax, 14 days. CSRF token on every POST. Rate limits on sign-up, sign-in, codes, chat and key tests. Codes: 6 digits, hashed, 10 minutes, 5 attempts. The agent address a user types is fetched by this server, so it must be https and must not resolve to a private address (DNS rebinding is not fully covered: run this server where it cannot reach your internal network). Strict CSP: scripts only from the site itself.
