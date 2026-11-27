---
name: pages
description: Make a shareable poll, sign-up list or RSVP page and get a link. Use when the owner wants to ask a group something (where to eat, which day), collect names, or count who is coming. Creates the page, sends the link, reads the results on request, and closes it when done.
---

# Pages

Use `page_create` (kind `poll`, `signup` or `rsvp`). Give polls 2 to 10 short options. Default language is Arabic; pick English if the owner writes English or the guests will. Send the owner the link and say how long it stays open (14 days unless you set `days`).

Read results with `page_results` when the owner asks, and tell them plainly: counts for polls, names for sign-ups. Close the page with `page_close` when the owner says it is done. Never put private details in a title or description: anyone with the link can read them. If the tools are missing, `INSTINCT_PAGES=1` is not set: say so and offer a message to forward instead.
