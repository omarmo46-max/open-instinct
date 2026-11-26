# Phase B: habits, memory search, booking preferences, places

B1 (mail and calendar alerts) is in `TRIGGERS.md`. This page covers B2 to B5.

## B2 Sleep and wake by habit

The agent counts which local hours the owner writes in (a count per hour and the days seen, never message text; file `habits.json`).
Once it has 40 messages over 7 days and a clear 7-hour quiet stretch, that stretch is the owner's sleep window. Before that it uses the configured quiet hours (default 23:00 to 07:00).

- Proactive alerts (B1) follow the learned window. Only a flight leaving within 12 hours goes out during it.
- A schedule made with `wait_for_wake: true` is held while the owner sleeps and runs at the first check after they wake. Alarms and exact-time jobs leave it off and run on time.
- Needs no setup. Nothing leaves the machine.

## B3 Memory search

Tool `memory_search` looks through `MEMORY.md` and the last 90 journal days.

- Default: by words (BM25) with Arabic normalization (alef and ya variants, ta marbuta, "ال"). Local, free.
- By meaning: set `INSTINCT_SEMANTIC_MEMORY=1` and an `EMBED_API_KEY` (or `OPENAI_API_KEY`). Optional `EMBED_BASE_URL`, `EMBED_MODEL` (default `text-embedding-3-small`). **Memory lines are then sent to that embeddings service**, which is why it is opt-in. Vectors are cached in `memory/embeddings.json`. If the service fails, search falls back to words and says so.

## B4 Booking preferences

Tools `preference_note`, `booking_brief`, `preference_forget` (owner only).

- The owner states a preference ("window seat") and it applies at once. A plain choice only counts; the same choice three times, leading by two, becomes a learned preference.
- Competing choices with no winner are listed as "ask the owner", never guessed.
- `booking_brief` is called before a booking search. Spending approvals and limits are unchanged: a preference never books or pays on its own.

## B5 Places and arrival

Off unless `INSTINCT_LOCATION=1`. Tools: `place_save`, `arrival_reminder`, `where_am_i`, `place_remove`.

The phone reports to `POST /location` (owner token, same as `/voice`):

- `{"lat": 30.04, "lon": 31.23, "accuracy": 20}`: a fix. Arrival is inside the place radius; leaving needs 30% more distance, so a border does not flap. Fixes worse than 200 m are ignored.
- `{"place": "Home", "event": "arrive"}`: from an iOS automation ("When I arrive") calling the Shortcuts action "Get Contents of URL". Works for saved places only.

An arrival reminder fires once, texts the owner, and stays pending if the message could not be sent.
Stored: the last fix and the last 20 events (`location.json`), plus saved places. `place_remove` with `clear_history` deletes the last fix and events. Nothing is sent to a model or a third party.

## Known limits

- Habits need about a week of use before they apply. Until then, configured quiet hours.
- Meaning search quality depends on the embeddings service; without one it is word matching, so "my sibling" will not find "sister".
- Location arrives only when the phone sends it. iOS decides how often a Shortcut automation runs; this is not live tracking.
- Not tested against a real iPhone, a real embeddings service, or a live Composio account.
