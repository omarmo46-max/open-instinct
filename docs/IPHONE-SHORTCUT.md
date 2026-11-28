# Talk to your agent from an iPhone Shortcut

Press a button, speak, and hear the answer. The Shortcut records your voice, sends it to the agent's
`POST /voice` endpoint, and speaks the reply. It works on any iPhone that can run the Shortcuts app; the
button you start it from depends on the model (see [Start it](#4-start-it)).

> **Status.** The endpoint is covered by automated tests with a fake speech-to-text service
> ([`packages/server/test/http.test.ts`](../packages/server/test/http.test.ts)). Use
> [`examples/voice-check.mjs`](../examples/voice-check.mjs) to check your own server from a computer
> before you build the Shortcut, then run the [phone checklist](#phone-checklist) once on your own
> iPhone. A real-device run is the one thing the test suite cannot do.

## What you need

| Need | Why |
|---|---|
| A server URL your phone can reach over **HTTPS** | The Shortcut is an HTTP client. A Maritime VM has no public port ([DEPLOY-MARITIME.md](DEPLOY-MARITIME.md)), so use a self-hosted agent behind a reverse proxy, a Cloudflare Tunnel, or Tailscale ([SELF-HOST.md](SELF-HOST.md)). Never expose it over plain HTTP. |
| `ORION_CHAT_TOKEN` set on the agent | `/voice` is the owner's surface. Without a token it is open to anyone who can reach the port. The Shortcut sends this token. |
| Speech to text: `STT_API_KEY` (or `OPENAI_API_KEY`) | Without it the agent cannot hear you and `/voice` answers `422` with an explanation. `STT_BASE_URL`, `STT_MODEL` and `STT_LANGUAGE` are optional ([KEYS.md](KEYS.md)). |

## 1. Check the server first (2 minutes, from a computer)

```bash
node examples/voice-check.mjs https://your-agent.example.com/voice ./hello.m4a "$ORION_CHAT_TOKEN"
```

It prints the HTTP status, what the agent heard (`transcript`) and its answer (`response`). If this
works, the Shortcut only has to do the same thing.

## 2. Build the Shortcut

Open **Shortcuts**, tap **+**, and add these four actions in order.

1. **Record Audio**. Tap the arrow and set *Start Recording* to **Immediately** and *Finish Recording* to **On Tap**.
2. **Get Contents of URL**. Tap *Show More* and set:
   - **URL**: `https://your-agent.example.com/voice`
   - **Method**: `POST`
   - **Headers**: add `Authorization` = `Bearer YOUR_CHAT_TOKEN`, and `Content-Type` = `audio/mp4`
   - **Request Body**: `File`, then choose **Recorded Audio**
3. **Get Dictionary Value**. Get **Value** for key `response` in *Contents of URL*.
4. **Speak Text** with *Dictionary Value*.

Name it for how you will call it, for example "Ask Orion". Optionally add **Show Result** with the
`transcript` value (a second *Get Dictionary Value*) to see what the agent heard.

Why the `Content-Type` header: the server accepts `audio/*`, `video/mp4` and `application/octet-stream`.
Set it explicitly so the request never goes out as JSON or form data.

## 3. What comes back

```json
{ "response": "You have two meetings today...", "acked": false, "conversationKey": "chat:voice",
  "transcript": "what is on my calendar today", "pending": ["..."] }
```

| Status | Meaning | What to do |
|---|---|---|
| `200` | Heard and answered. `response` is the reply. | Nothing. |
| `200` with `response` "On it. I will send the result when it is done." | The agent needs longer than `ORION_REPLY_BUDGET_MS` (default 20 s). | Replies that finish later are held for the voice conversation and come back in `pending` on your next recording. Ask "anything new?" to collect it. |
| `401` | Missing or wrong token. | Check the `Authorization` header: `Bearer ` then the token, nothing else. |
| `415` | The request was not audio. | Check the `Content-Type` header and that the body is *File*. |
| `400` / `413` | Empty recording, or over 25 MB. | Record again; keep it short. |
| `422` | Speech to text failed or is not set up. The `error` field says why. | Set `STT_API_KEY`. |
| `501` | This agent has no voice support. | Update the agent. |
| `500` | The agent hit an error. | Look at the agent's log. |

## 4. Start it

- **iPhone 15 Pro and later (iOS 17.2+), Action Button**: Settings, Action Button, **Shortcut**, pick "Ask Orion".
- **Any iPhone, Back Tap** (iOS 14+): Settings, Accessibility, Touch, **Back Tap**, Double Tap, then pick the Shortcut under *Shortcuts*.
- **Any iPhone, Siri**: say "Hey Siri, Ask Orion".
- **Home Screen**: in the Shortcut, tap the name at the top, **Add to Home Screen**.
- **Lock Screen / Control Center** on newer iOS versions also offer a Shortcut control.

If an option is missing in your Settings, your iOS version is older than that feature. Siri and the Home
Screen icon work on older versions too.

## Phone checklist

Run this once on your iPhone and tick every line before you call it done.

- [ ] The Shortcut records, uploads, and speaks an answer on Wi-Fi.
- [ ] Same on mobile data (the URL works outside your home network).
- [ ] A wrong token gives an error (`401`), not an answer.
- [ ] A short Arabic sentence is understood (check `transcript`).
- [ ] A long question hits the budget, returns "On it...", and the answer arrives in `pending` on the next recording.
- [ ] Your chosen button starts it with the phone locked.

## الخلاصة بالعربي

1. شغّل الوكيل على سيرفر له رابط HTTPS، واضبط `ORION_CHAT_TOKEN` و`STT_API_KEY`.
2. جرّب السيرفر من الكمبيوتر بـ `examples/voice-check.mjs` قبل ما تبني الاختصار.
3. في تطبيق الاختصارات: **Record Audio** ثم **Get Contents of URL** (POST على `/voice`، الهيدر `Authorization: Bearer ...` و`Content-Type: audio/mp4`، والـ Body ملف التسجيل) ثم **Get Dictionary Value** للمفتاح `response` ثم **Speak Text**.
4. شغّله بزر الأكشن (iPhone 15 Pro وأحدث) أو النقر على الظهر (Back Tap) أو "Hey Siri".
5. لو الرد أطول من 20 ثانية بيرجّع "On it..." والرد الكامل بيوصل في `pending` مع التسجيل اللي بعده.
