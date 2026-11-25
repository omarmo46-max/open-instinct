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
| Unanswered invite | You are an attendee, have not answered, and it starts within 72 h | Once early, once more under 24 h before |
| Birthday | All-day birthday event (Google's Birthdays calendar or a title with "birthday" / "عيد ميلاد") | The day before and the day of |
| Flight changed | A timed event that looks like a flight moved to another time | Once per change |
| Flight cancelled or missing | Marked cancelled, or gone from a complete calendar read | Once |
| Mail that looks like a flight change | Subject says flight or booking plus change, cancel, delay (English and Arabic) | Once per message |

Alerts are written in the owner's language (`owner.language`, Arabic or English).

## Rules it follows

- Quiet hours hold everything except a flight alert for a flight leaving within 12 hours.
- An alert counts as sent only after the channel accepted it. A failed send or a hold is retried next scan; nothing repeats.
- At most 5 alerts per scan (`maxPerRun`); the rest go next time.
- The first time it sees a flight it only records it. "Changed" needs something to change from.
- "Flight gone" is claimed only when the whole calendar was read (all pages).
- Event titles and subjects are cleaned (control and direction-override characters removed), shortened and quoted. The agent never opens a message or follows a link in one.
- State: `trigger-state.json` (sent keys for 60 days, watched flights). Each alert is in the audit log as kind `schedule`, conversation `triggers`.

## Config (`config.json`, key `triggers`)

`enabled`, `intervalMinutes` (5 to 240, default 30), `quietFrom`, `quietTo`, `inviteHorizonHours` (72), `flightHorizonDays` (14), `maxPerRun` (5).

## Known limits

- Flight detection is a heuristic on the title: it can miss a flight titled "Trip" and can catch "Flight club". Mail detection is a subject pattern, not understanding.
- If a flight is moved beyond the watch window it is reported as "can no longer find", not "moved".
- Birthdays come from the calendar only. Contacts without a calendar entry are not seen.
- Tested against fakes. The Composio slugs (`GOOGLECALENDAR_EVENTS_LIST`, `GMAIL_FETCH_EMAILS`) and response fields need one live check.
