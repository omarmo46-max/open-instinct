# @open-instinct/telegram

A Telegram bot as a channel. People message the bot one to one and the agent answers in the
same chat. It speaks the official [Bot API](https://core.telegram.org/bots/api) with `fetch`
(long polling), so there are no extra dependencies, no public URL, no tunnel and no TLS to set up.

## Set up

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name and a
   username ending in `bot`. Copy the token it gives you.
2. Find your numeric user id: message [@userinfobot](https://t.me/userinfobot).
3. Add to the agent's environment and restart:

   ```bash
   TELEGRAM_BOT_TOKEN=123456789:AA...
   TELEGRAM_OWNER_ID=123456789
   ```

4. The log prints `telegram: connected as @your_bot`. Open the bot and say hello.

`TELEGRAM_ENABLED=0` turns the channel off while keeping the token. Use **one process per
bot token**: a second poller makes Telegram answer `409 Conflict`.

### No id yet? Claim the agent with a code

A front door that hands out agents before it knows the owner sets `owner.claimOnFirstContact`
and a one-time `claimCode` (see `docs/PERMISSIONS.md`). On Telegram the owner opens
`https://t.me/<bot>?start=<code>` (or sends `/start <code>`) and their Telegram id becomes the
owner. The code is removed from the message before the model sees it, and it works once.

## Who is who

- The identity is the numeric Telegram **user id** that Telegram puts on every update. A
  `@username` can be changed or taken by someone else, so it is only shown, never trusted.
- An id in `owner.telegramIds` (seeded by `TELEGRAM_OWNER_ID` while `config.json` has none) is
  the owner. Telegram authenticates the sender, so like iMessage, SMS and WhatsApp the owner's
  replies can approve payments and calls.
- A contact is recognised by `"telegramIds": ["123456789"]` in `contacts.json`. As with phone
  and email, a contact reached on Telegram is capped at `partner`; `staff` stays agent-only.
- Anyone else is a `stranger` and gets the stranger rules (polite no, one-line note to you).

## What it does

- Private chats only. Groups, supergroups and channels are ignored.
- Photos, voice notes, audio, video and documents (Bot API limit: 20 MB) are saved to
  `workspace/inbound`, named like Inkbox attachments. Too large or failed downloads are
  mentioned to the agent in the message text.
- Replies are plain text (no Markdown parsing, so nothing a model writes can break a send),
  split at 4096 characters, with a typing indicator. Links to files are sent as documents and
  fall back to the plain link.
- Owner notices (finished phone calls, scheduled results) follow the owner to the chat they
  last wrote from, or to `owner.telegramIds[0]` for a Telegram-only owner who has not written yet.
  Telegram only lets a bot message someone who has opened the bot at least once.
- Messages are persisted (`telegram-inbox.json`) before they are handled, and the update
  offset is saved in `secrets/telegram/offset.json`, so a restart neither loses nor replays messages.

## Caveats

- The bot token is a password. It is never logged, and error text has it scrubbed. If it
  leaks, revoke it in @BotFather (`/revoke`).
- Telegram bot chats are encrypted in transit but not end to end; Telegram can read them.
  Prefer iMessage or Signal for anything you would not put in a cloud chat.
- Sending a local file as an attachment (the `send_file` tool) is not wired to Telegram yet:
  the agent shares a link instead.
