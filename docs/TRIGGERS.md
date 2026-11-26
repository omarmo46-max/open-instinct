# Proactive triggers (B1)

The agent checks the owner's mail and calendar on a timer and texts first when something needs attention.
It does this in code. No model runs, so a scan costs no tokens and an email cannot give it instructions.

## Turn it on

1. Connect Gmail and Google Calendar through Composio (see `COMPOSIO.md`).
2. Set `INSTINCT_TRIGGERS=1`, or put `"triggers": { "enabled": true }` in `config.json`.
3. Optional: `INSTINCT_QUIET_HOURS=23:00-07:00` (owner's time zone, the default).

Without a Composio session it stays off and logs why. When it is off, its schedule entry is removed.

## What it tells you

| Alert | When | Repeats |
|---|---|---|
| Unanswered invite | You are an attendee, have not answered, and it starts within 72 h | Once early, once more under `inviteSoonHours` (24) before |
| Birthday | An event with type birthday, or "birthday" / "عيد ميلاد" in the title (all-day or timed) | The day before and the day of |
| Travel plan moved | A flight or trip event moved by `flightChangeMinutes` (20) or more; all-day trips: any date change | Once per change |
| Travel plan cancelled, or not found | Marked cancelled, or missing from the calendar | Once |
| Mail that looks like a travel change | Subject says flight or booking plus change, cancel, delay (English and Arabic) | Once per message |

Alerts are written in the owner's language (`owner.language`, Arabic or English).

## How it decides what is a trip

It scores the title, the place and the calendar's own event type. Strong signals: a route like `CAI → DXB`, a flight number, an airport in the place, or an event Google made from a confirmation email (`fromGmail`) that mentions flights. Weaker: words like flight, airline, airport, "trip to", "رحلة طيران", "سفرية". Titles with club, meeting, school, class, lunch and similar words are skipped unless a strong signal is present.
It will still be wrong sometimes, so the owner can correct it by chat ("that is not a flight", "Mona 30 is a birthday"): tool `trigger_feedback`. A correction is kept by title, so it covers a whole recurring series.

## Rules it follows

- Quiet hours hold everything except a travel alert for a plan leaving within `urgentFlightHours` (12). The window is learned from habits (see `PROACTIVE.md`).
- An alert counts as sent only after the channel accepted it. A failed send or a hold is retried next scan; nothing repeats.
- Several ordinary alerts in one scan go out as one message (a short list). Urgent ones go on their own. At most `maxPerRun` (5) per message; if a long list does not fit in one message, only the alerts that fit are marked sent and the rest go in the next scan.
- A move smaller than `flightChangeMinutes` is ignored, and the same instant written in another time zone is not a change. Small drifts add up against the original time until they matter.
- The first time it sees a plan it only records it. "Changed" needs something to change from.
- Before it says a plan is gone, it reads a much wider calendar window (at least 90 days). If the plan is there at another time it reports a move; if the wide read is complete and it is still not there it says "I could not find it, it is worth a look"; if the read was partial it says nothing.
- **Email alerts rest on the subject only.** The agent never opens a message, so the alert says it is a hint and not a confirmation. A real change that is only in the body is not seen.
- Event titles and subjects are cleaned, shortened and quoted. The agent never follows a link in one.
- The first time it runs it sends one welcome message saying what it watches and how to mute it (only when the calendar was readable, and not at night).
- State: `trigger-state.json` (sent keys for 60 days, watched plans, welcome flag) and `trigger-prefs.json` (mutes and corrections). Each alert is in the audit log as kind `trigger`.

## Controlling it from chat (owner only)

`trigger_mute` (a kind, one item by title, or `all` to pause everything), `trigger_unmute`, `trigger_feedback`, `trigger_status`.
Kinds: `invite`, `birthday`, `flight`, `travel_mail`.
A muted or corrected title matches by whole words, so "friday standup" also covers "Friday standup weekly". Titles shorter than 4 characters match exactly only. Use the title as it appears on the calendar, not a translation.

## Config (`config.json`, key `triggers`)

`enabled`, `intervalMinutes` (5 to 240, default 30), `quietFrom`, `quietTo`, `inviteHorizonHours` (72), `inviteSoonHours` (24), `flightHorizonDays` (14), `urgentFlightHours` (12), `flightChangeMinutes` (20), `maxPerRun` (5).

## Known limits

- Trip detection is still a heuristic. A trip titled "Holiday" with no airport, route or travel word is not seen until the owner marks it with `trigger_feedback`.
- Mail detection is a subject pattern, not understanding.
- Birthdays come from the calendar only. Contacts without a calendar entry are not seen.
- Tested against fakes. The Composio slugs (`GOOGLECALENDAR_EVENTS_LIST`, `GMAIL_FETCH_EMAILS`) and response fields need one live check.
