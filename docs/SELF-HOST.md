# Self-hosting Orion AI

This guide runs one Orion AI agent on a machine you control. That can be your laptop, a home server, or a VPS. Nothing here needs Maritime hosting. The agent is one Node process, one data directory, and (optionally) one Inkbox identity so you can text it on iMessage.


Analogy: the agent is a person who works from home. Inkbox is their phone line. The data directory is their filing cabinet. This guide sets up the home office.

## Contents

1. [What you need](#what-you-need)
2. [Install](#install)
3. [Step 1: `orion init`](#step-1-orion-init)
4. [Step 2: `orion dev --tunnel`](#step-2-orion-dev---tunnel)
5. [How the tunnel gives you a public webhook URL](#how-the-tunnel-gives-you-a-public-webhook-url)
6. [Step 3: connect your iPhone](#step-3-connect-your-iphone)
7. [Docker Compose](#docker-compose)
8. [Where state lives](#where-state-lives)
9. [Backups](#backups)
10. [Updating](#updating)
11. [The computer: none, or hosted](#the-computer-none-or-hosted)
12. [Keeping the owner surface private](#keeping-the-owner-surface-private)
13. [Environment variables](#environment-variables)
14. [Troubleshooting](#troubleshooting)

## What you need

| Item | Why | Required |
|---|---|---|
| Node 22.19 or newer and pnpm | runs the agent and the CLI | yes |
| A model key (`ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` with `OPENAI_BASE_URL`) | the model behind the agent | yes |
| An Inkbox admin key (`INKBOX_ADMIN_API_KEY`) from the Inkbox console | gives the agent an iMessage line, email and A2A endpoint | for iMessage |
| A Maritime key (`MARITIME_API_KEY`) with the `computers` scope | a hosted Linux desktop the agent can drive | for computer use |
| Docker | only for the Compose path | no |

The machine needs outbound HTTPS only. No inbound ports, no domain, no TLS certificate. The Inkbox tunnel handles the public side.

## Install

```bash
git clone https://github.com/omarmo46-max/orion-ai && cd orion-ai
pnpm install && pnpm -r build
```

Run the CLI from inside the repo:

```bash
pnpm --filter @orion-ai/cli exec orion --help
```

Or link it so `orion` is on your PATH:

```bash
cd packages/cli && pnpm link --global && cd ../..
orion --help
```

The rest of this guide writes `orion ...` and assumes one of those two.

## Step 1: `orion init`

`init` writes `config.json` into the data directory. With `INKBOX_ADMIN_API_KEY` in the environment it also creates the agent's Inkbox identity.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export INKBOX_ADMIN_API_KEY=ApiKey_...

orion init --name "Maria" --phone +14155550100 --email maria@example.com \
  --handle maria-orion --timezone America/New_York
```

What each flag does:

| Flag | Meaning |
|---|---|
| `--name` | your name. Required |
| `--phone`, `--email` | how the agent knows a message is from you, the owner |
| `--handle` | the agent's Inkbox handle. People will text `connect @maria-orion` |
| `--timezone` | used in prompts and schedules |
| `--model` | `provider/model-id`. Default `anthropic/claude-fable-5-1` |
| `--skip-inkbox` | write config only, even when an admin key is set |

With the admin key, `init` does five things on Inkbox:

1. Creates the identity `@maria-orion` with iMessage enabled.
2. Mints an identity-scoped API key. This is the key the agent process runs with.
3. Creates the webhook signing key.
4. Saves all of it to `<dataDir>/secrets/inkbox.json` with mode 0600.
5. Prints the connect instructions.

If the handle is taken, Inkbox gives you `maria-orion-2` and `init` saves that name. If your Inkbox plan is full, `init` stops with the plan limit error and the billing URL. See [INKBOX.md](INKBOX.md#plan-limits).

Running `init` again updates the existing config. It does not wipe anything.

## Step 2: `orion dev --tunnel`

`dev` runs the agent server in the current process. No Docker. No Maritime.

```bash
orion dev --tunnel
```

Expected output:

```
Orion AI is running on http://127.0.0.1:8080  (data: /Users/maria/.orion)
  tunnel: https://maria-orion.inkboxwire.com
  webhook: subscription whs_8f2 (new)
```

`dev` loads `secrets/inkbox.json` into the environment, so you do not export `INKBOX_API_KEY` yourself. Ctrl-C closes the tunnel, the server and the agent cleanly.

Flags:

| Flag | Meaning |
|---|---|
| `--port 8080` | local port. Default 8080 |
| `--host 127.0.0.1` | bind address. `dev` defaults to `0.0.0.0`, so pass this on a shared machine or set a chat token |
| `--tunnel` | open the Inkbox tunnel and subscribe the webhook |
| `--quiet` | less log output |
| `--data-dir <dir>` | use another data directory |

Without `--tunnel` the agent still runs. You can talk to it from a second terminal:

```bash
orion chat "remember that I like window seats"
orion status
```

But iMessage cannot reach it. Inkbox needs a public URL to post events to. That is what the tunnel provides.

## How the tunnel gives you a public webhook URL

Inkbox posts every inbound message to your agent as an HTTP webhook. A laptop behind a home router has no public address. Instead of opening a port, the agent opens an outbound connection to Inkbox, and Inkbox forwards traffic back down it.

Analogy: you cannot receive mail at a desk in a coworking space. So you rent a mailbox at the front desk, and the receptionist walks letters to you.

Step by step:

1. `orion dev --tunnel` sets `ORION_TUNNEL=1`.
2. The server starts a second listener on loopback that answers only `GET /health` and `POST /webhooks/inkbox`. Everything else on that listener is 404.
3. The CLI opens an Inkbox tunnel with the identity key and the handle. Every identity owns the host `https://<handle>.inkboxwire.com`. The tunnel is outbound HTTP/2, so it works from inside any network that allows HTTPS out.
4. With `INKBOX_ADMIN_API_KEY` set, the CLI subscribes the identity's webhooks to `https://<handle>.inkboxwire.com/webhooks/inkbox`. An existing subscription for the same URL is reused. The signing key is stored in `<dataDir>/secrets/webhook.json`.
5. Without the admin key, the CLI prints the URL and you create the subscription yourself in the Inkbox console or with the API. See [INKBOX.md](INKBOX.md#webhooks-and-signing-keys).

Two safety points:

- The tunnel never exposes `/chat`, `/status` or `/schedules`. Those are the owner's surface and stay on your local port only.
- Every webhook is checked against the signing key before the agent reads it. A bad or missing signature gets 401. A missing key gets 503.

## Step 3: connect your iPhone

```bash
orion connect
```

Output:

```
Connect your iMessage
  1. Text connect @maria-orion to +1 415 555 0199
  2. A new thread from your Orion appears. Say hi.
  Tap-to-text link: sms:...
  QR code written to /Users/maria/.orion/connect-qr.png
```

Inkbox runs a shared iMessage router number. You text `connect @handle` to it once. From then on you have a normal iMessage thread with your agent. The first message must come from you. The agent on the shared line cannot text a stranger first. Details are in [INKBOX.md](INKBOX.md#the-shared-router-and-connect-handle).

## Docker Compose

The Compose path runs the same server in a container. It is a good fit for a VPS.

```bash
cp deploy/.env.example deploy/.env
# fill in the model key, owner fields and Inkbox values
docker compose -f deploy/docker-compose.yml up --build
```

The agent answers on `http://127.0.0.1:8080`. The port is published on loopback only.

How it maps:

| Compose setting | Value | Meaning |
|---|---|---|
| `PORT` | `8080` | the port inside the container |
| `ORION_DATA_DIR` | `/data` | state, on the `agent-data` volume |
| `ORION_SKILLS_DIR` | `/app/skills` | the SKILL.md playbooks copied into the image |
| `env_file` | `deploy/.env` | every other variable |
| `restart` | `unless-stopped` | comes back after a reboot |

Notes for this path:

- The container runs as the unprivileged `orion` user. The entrypoint only uses root to make `/data` writable, then drops privileges.
- Without Inkbox keys the agent still runs. Replies go to the container log (`docker compose -f deploy/docker-compose.yml logs -f agent`).
- To receive iMessage in a container, set `ORION_TUNNEL=1` in `deploy/.env` along with the `INKBOX_*` values. The server opens the tunnel itself and, with `INKBOX_ADMIN_API_KEY`, subscribes the webhook.
- Set `ORION_CHAT_TOKEN` in `deploy/.env` if anything beyond this machine should reach `/chat`. See [Keeping the owner surface private](#keeping-the-owner-surface-private).
- The `gateway` service in the same file is for the multi-user shape. It needs `--profile gateway` and is not part of a single-person self-host. See the [gateway README](../packages/gateway/README.md).

To run `orion` commands against the container's data, point them at the same directory. The simplest way is to run the CLI on the host with `--data-dir` set to a bind mount, or to keep the CLI's `.orion` for `init` and copy `secrets/inkbox.json` values into `deploy/.env`.

## Where state lives

Everything is in one directory. The CLI default is `./.orion`. The server default is `/data` when that directory exists, else `./.orion`. `ORION_DATA_DIR` or `--data-dir` overrides both.

| Path | What it holds | Written by |
|---|---|---|
| `config.json` | owner (name, phones, emails, timezone), agent name and handle, model, feature flags | `init`, first boot |
| `secrets/inkbox.json` | identity key, identity id, signing key, handle. Mode 0600 | `init` |
| `secrets/webhook.json` | webhook subscription id, URL, signing key. Mode 0600 | `dev --tunnel`, server |
| `contacts.json` | people, their phones, emails, agent handles and tiers | `invite`, `trust set`, the agent |
| `policy.json` | tiers, grants, spend limits | `trust grant`, `trust revoke`, the agent |
| `schedules.json` | cron and one-shot jobs | `schedules`, the agent |
| `approvals.json` | pending owner approvals | the agent |
| `memory/MEMORY.md` | durable memory, plain Markdown | the agent |
| `memory/journal/` | one file per day | the agent |
| `sessions/` | Pi JSONL transcripts, one per conversation | the agent |
| `audit.jsonl` | append-only log of every side effect | the agent |
| `workspace/` | files the agent makes for you | the agent |
| `inbox/` | files you sent to the agent | the agent |
| `maritime.json` | the deployed agent id, only after `orion deploy` | `deploy` |
| `connect-qr.png` | the connect QR | `connect` |

Two rules worth knowing:

- `config.json` wins over the environment after the first boot. Env seeds it; it does not override it later. To change the owner or the model, run `init` again or edit the file.
- Memory is Markdown. You can open `memory/MEMORY.md` and read or fix it by hand.

## Backups

Back up the whole data directory. It is small, mostly text, and contains everything the agent knows.

What matters most:

| File | If lost |
|---|---|
| `secrets/inkbox.json` | the agent cannot send or receive. Inkbox shows the identity key and signing key only once. You would mint new ones with the admin key |
| `secrets/webhook.json` | the server cannot verify webhooks until it mints a new signing key |
| `memory/`, `sessions/`, `audit.jsonl` | the agent forgets, and you lose the record of what it did |
| `contacts.json`, `policy.json` | the trusted network and grants are gone |

Local run:

```bash
tar czf orion-backup-$(date +%F).tgz -C "$(dirname "$ORION_DATA_DIR")" "$(basename "$ORION_DATA_DIR")"
```

Docker Compose keeps `/data` on a named volume. Compose names it after the project, which defaults to the directory name, so look it up first:

```bash
docker volume ls | grep agent-data
docker run --rm -v deploy_agent-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/orion-backup-$(date +%F).tgz -C /data .
```

Store the archive somewhere encrypted. It contains API keys.

Restore is the reverse: stop the agent, unpack into the data directory (or the volume), start it again. Keep file modes: `secrets/` should be 0700 and the files inside 0600.

## Updating

Local run:

```bash
git pull
pnpm install && pnpm -r build
# restart orion dev
```

Docker Compose:

```bash
git pull
docker compose -f deploy/docker-compose.yml up --build -d
```

State lives outside the code, so an update never touches the data directory. Run `orion status` after a restart to confirm the agent name, model and computer kind are what you expect.

## The computer: none, or hosted

Orion AI can drive a Linux desktop: open a browser, click, type, read a page. On Maritime the desktop runs inside the agent's own VM. When you self-host there is no desktop next to the agent. You have two choices.

| Mode | Set | What happens |
|---|---|---|
| No computer | `ORION_COMPUTER=none` | the agent has no `computer` tools. It still texts, emails, reads Gmail and Calendar through Composio, runs schedules, and talks to other Orions |
| Hosted computer | `MARITIME_API_KEY=mk_...` and `ORION_COMPUTER=auto` (the default) or `maritime` | the agent uses Maritime Computers over MCP. Maritime keeps one persistent desktop for you behind `https://mcp.maritime.sh` |

How `auto` decides: it probes for an in-VM desktop first. On your own machine there is none. If `MARITIME_API_KEY` is set, it uses the hosted computer. Otherwise it runs with no computer. Nothing fails; the tool set is just smaller.

Hosted computer details:

- The key needs the `computers` scope. Mint it in the Maritime dashboard.
- `MARITIME_COMPUTERS_MCP_URL` changes the endpoint. Default `https://mcp.maritime.sh`.
- The first call creates the desktop and can take up to 60 seconds. A sleeping desktop wakes in a few seconds.
- A `402 no_plan` means the Maritime account has no Computers plan. The key being valid does not prove the plan exists. Test with one real action.
- Logins, 2FA and payments are yours. The agent calls `request_takeover` and texts you a viewer link. You do the step in a browser and click Done. The agent sees nothing while you are in control.

More in the [computer package README](../packages/computer/README.md).

## Keeping the owner surface private

`POST /chat`, `GET /status` and `GET /schedules` run with the full owner tool set. Anyone who can reach them is you, as far as the agent is concerned. Two guards exist.

1. Bind address. A bare `node packages/server/dist/main.js` with no `PORT` listens on `127.0.0.1` only. `orion dev` also binds `127.0.0.1` unless you pass `--host 0.0.0.0`. Compose publishes `127.0.0.1:8080` on the host, so the container port is not reachable from outside.
2. Token. Set `ORION_CHAT_TOKEN` to a random string. Every call must then send `Authorization: Bearer <token>` (or `X-Orion-Token: <token>`) or it gets 401.

```bash
export ORION_CHAT_TOKEN=$(openssl rand -hex 24)
orion dev --host 127.0.0.1 --tunnel
```

`orion chat` and `orion status` read `ORION_CHAT_TOKEN` from the environment and send it as `Authorization: Bearer <token>`, so export the same value in the shell you run them from. Any other client sends the header itself:

```bash
curl -s http://127.0.0.1:8080/chat \
  -H "Authorization: Bearer $ORION_CHAT_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"message":"hi"}'
```

Or keep the token off and leave `orion dev` on loopback. On a laptop that is enough. On a VPS, set the token.

The tunnel does not change any of this. It carries signed webhooks only and never reaches `/chat`.

## Environment variables

Every variable below is read by the server or the CLI. `deploy/.env.example` lists them with comments. `config.json` wins over most of them after the first boot.

| Variable | Read by | Meaning |
|---|---|---|
| `ORION_DATA_DIR` | server, CLI | the data directory |
| `ORION_MODEL` | server | `provider/model`. Default `anthropic/claude-fable-5-1`. `openai-compatible/<id>` uses `OPENAI_BASE_URL` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` | server, CLI | model access |
| `ORION_OWNER_NAME`, `ORION_OWNER_PHONE`, `ORION_OWNER_EMAIL`, `ORION_OWNER_TIMEZONE`, `ORION_AGENT_NAME` | server | seed `config.json` on first boot. `init` flags do the same job |
| `INKBOX_API_KEY`, `INKBOX_AGENT_HANDLE`, `INKBOX_IDENTITY_ID`, `INKBOX_SIGNING_KEY` | server, CLI | the identity-scoped Inkbox credentials. `init` saves them in `secrets/inkbox.json`; `dev` loads them |
| `INKBOX_ADMIN_API_KEY` | CLI, server | org-wide key. Provisions the identity, subscribes webhooks, creates invitations |
| `INKBOX_BASE_URL` | CLI, server | only for a self-hosted Inkbox |
| `ORION_TUNNEL` | server, CLI | `1` opens the Inkbox tunnel. `dev --tunnel` sets it |
| `ORION_CHAT_TOKEN` | server, CLI | bearer token for the owner surface |
| `ORION_BIND` | server | bind address override |
| `ORION_PUBLIC_URL` | server | public URL of the agent, used to build the Stripe Link callback |
| `ORION_COMPUTER` | server | `auto`, `desktopd`, `maritime`, `none` |
| `MARITIME_API_KEY` | server, CLI | hosted computer (scope `computers`), and `orion deploy` |
| `MARITIME_COMPUTERS_MCP_URL` | server | hosted computer endpoint. Default `https://mcp.maritime.sh` |
| `COMPOSIO_API_KEY`, `COMPOSIO_TOOLKITS` | server, CLI | Gmail, Calendar and other apps. The key alone turns apps on |
| `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET`, `STRIPE_PUBLISHABLE_KEY`, `LINK_REDIRECT_URI` | server, CLI | Stripe Link agent wallet. All of the first three are needed for payment tools |
| `BRAVE_SEARCH_API_KEY` | server, CLI | better web search. DuckDuckGo otherwise |
| `ORION_SKILLS_DIR` | server | SKILL.md folder. Default `<repo>/skills` |
| `ORION_REPLY_BUDGET_MS` | server | how long `/chat` waits before acknowledging and finishing in the background. Default 20000 |
| `PORT` | server | listen port. Default 8080 |
| `NO_COLOR`, `ORION_DEBUG` | CLI | plain output; stack traces |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `no tunnel: iMessage webhooks need --tunnel or the gateway` | `dev` started without the flag | run `orion dev --tunnel` |
| `INKBOX_API_KEY and INKBOX_AGENT_HANDLE are required` | no `secrets/inkbox.json` | run `orion init` with `INKBOX_ADMIN_API_KEY` set |
| `webhook: subscribe Inkbox events to https://...` printed in grey | no admin key, so no auto-subscribe | set `INKBOX_ADMIN_API_KEY`, or subscribe by hand to the printed URL |
| texts from your phone get no answer | your number is not the owner's | check `--phone` in `init` matches the iPhone you text from, in E.164 form |
| webhook returns 401 | signing key mismatch | delete `secrets/webhook.json` and restart with the admin key, or set `INKBOX_SIGNING_KEY` to the current key |
| webhook returns 503 | no signing key configured at all | same as above |
| `Inkbox plan limit` on `init` | the org is at its identity cap | upgrade, or delete an unused identity |
| `402 no_plan` on a computer action | Maritime account has no Computers plan | add the plan, or set `ORION_COMPUTER=none` |
| `COMPOSIO_API_KEY` set but no app tools | `config.json` has `apps.enabled: false` | run `orion init --name <you> --apps` |

Related reading: [INKBOX.md](INKBOX.md) for the identity, router and webhooks; [ARCHITECTURE.md](ARCHITECTURE.md) for the message flow; [PERMISSIONS.md](PERMISSIONS.md) for who may ask the agent for what; the [CLI README](../packages/cli/README.md) for every command and flag; the [server README](../packages/server/README.md) for the HTTP routes.
