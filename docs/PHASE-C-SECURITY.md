# Phase C: security

Eight layers, all in code, none of them needs a model call. They are on by default; `INSTINCT_SECURITY=0` removes the runtime hooks (the vault, step-up and encryption tools stay usable).
**None of this makes prompt injection impossible.** The firewall lowers the number of attacks that arrive, the action monitor limits what a successful one can do, and the owner's yes is the last gate.

## C1 Content firewall (`firewall.ts`)

Every inbound message and attachment is checked before the model sees it.

- **Text from anyone but the owner:** instruction-override phrases, fake `system:` lines, chat-template tokens, a fake `</untrusted>`, requests for the prompt or any secret, "do not tell the owner", exfiltration links, invisible tag characters, base64 that decodes to instructions. English and Arabic. Full-width letters and zero-width characters are folded first.
- **Attachments, from anyone:** executables, macro documents, double extensions (`invoice.pdf.exe`), direction-override file names, path traversal, a type that does not match the name, archives (contents cannot be checked), SVG, files over 25 MB. Only the name, type and size are looked at; the bytes are not opened.
- **Result:** `allow`, `warn` (the model gets a security notice, the message is handled strictly as data, and the conversation is "tainted" for 30 minutes) or `block` (strangers only; dropped and logged, the owner is not texted so an attacker cannot use it to spam them).
- The owner's own words are never judged. An owner attachment that looks dangerous only produces a warning.
- Zero-width non-joiner and joiner are kept (Persian, Arabic, emoji need them).

## C2 Action monitor (`action-monitor.ts`)

A second judge between the policy and the tool. It can ask or block, never loosen the policy.

- Stored credentials (`{{secret:...}}`): owner only, only in tools that accept them, never in a tainted conversation, always with the owner's yes.
- A call that would carry a stored secret, an API key, a private key, a token or a valid card number: the owner is asked, a stranger is blocked.
- After a flagged message, any risky tool (send, buy, book, write files, schedule, save memory, computer) needs the owner's confirmation; a stranger is blocked.
- More than 8 outward actions a minute (3 for strangers) are stopped.
- Every decision is in the audit log (kind `security`) with the reason.
- **Tool results are checked too.** A web page or an email a tool returns is scanned for hidden instructions; a flagged result taints the conversation, so risky tools then need the owner's yes. It cannot hide the text from the model, only tighten what the model can do next.

## C3 Grounding check (`grounding.ts`)

Before a reply goes out, amounts, links, emails, phone numbers, dates and booking codes in it must appear in what the user said, in a tool result this conversation, or in memory. "I sent / booked / paid / cancelled / saved it" must match a tool that ran this turn. Anything unsupported gets a plain note at the end of the reply, in the reply's language. Estimates ("about $300") are skipped.
`INSTINCT_GROUNDING=off` turns it off.
Limits: it checks that a claim has a source, not that the source is true; a total the model computed itself will be flagged; replies sent through the `reply` tool in the middle of a run are not checked.

## C4 Signed tool identity and short-lived credentials (`tool-identity.ts`)

- The agent has an Ed25519 identity (`keys/identity.json`, mode 0600).
- Tools from outside servers (Composio, MCP; marked `meta.external`) are fingerprinted (name, description, schema, capabilities) and pinned with a signature. If one changes between two starts it is taken out of service until the owner accepts it (`tool_pins`, `tool_pin_approve`). The agent's own tools, including its own app-connection tools, are not watched, because they change only when the software is upgraded.
- `signManifest` / `verifyManifest`: a signed list of the agent's tools another agent can check.
- `CredentialIssuer`: signed tokens that name one tool and scope, expire in at most 15 minutes, can be single-use and can be revoked. The owner's approval of a call that uses stored credentials is such a token (one tool, those exact arguments, two minutes, one use), so a stolen or replayed approval is worthless. Other tools do not ask for one yet.

## C5 End-to-end encrypted files (`e2ee.ts`)

X25519 + HKDF-SHA256 + AES-256-GCM, signed with the sender's Ed25519 identity. Only the pinned recipient can read the file, a changed byte fails, a different recipient fails, and a peer's key is pinned on first sight (a different key is refused until replaced).
Tools: `e2ee_my_keys`, `e2ee_pin_peer`, `e2ee_encrypt_file`, `e2ee_decrypt_file` (workspace files only, 25 MB). Exchange public keys and compare the fingerprint over another channel. It is not yet wired into the agent-to-agent protocol: the files are exchanged however you like.

## C6 Vault (`vault.ts`)

Logins, cards, addresses, notes. AES-256-GCM at rest, file mode 0600. The key is `INSTINCT_VAULT_KEY` (32 bytes, base64 or hex) or `INSTINCT_VAULT_PASSPHRASE` (scrypt). Card security codes are refused. Card numbers must pass the Luhn check.

- The model never needs a secret. It writes `{{secret:vault:Netflix.password}}` in a tool call to a tool that accepts them (`computer`, `computer_batch`, or the names in `INSTINCT_SECRET_TOOLS`). The owner approves, then the runtime fills it in and removes the value from the result.
- Tools: `vault_list` (labels and hints), `vault_save`, `vault_address`, `vault_delete`, `vault_reveal` and `totp_code` (owner approval and step-up).
- A tool whose purpose is to reveal a secret (`vault_reveal`, `totp_code`, `op_reveal`) is not scrubbed, and its result is kept out of the audit log. Everything it returns is in the conversation the model sees and in that conversation's saved history until `/new`: prefer references.
- Values are scrubbed from other tool results and from what the grounding check keeps. A screenshot cannot be scrubbed: do not let it show a password in clear text.
- `vault_save` means the owner typed the secret in chat, so the model has seen it and the chat holds it. The tool tells the owner to delete that message.

## C7 TOTP and step-up (`totp.ts`)

RFC 6238 (checked against the RFC test vectors). `stepup_enroll` gives a secret and an otpauth link for any authenticator app; `stepup_confirm` turns it on. After that, revealing a stored secret or using a stored credential needs a fresh 6-digit code first. The code is caught by the runtime before the model sees it, works once, unlocks for 5 minutes, and 5 wrong codes lock it for 15 minutes. Turning it off needs the owner's approval and a code.
The step-up secret is in `keys/stepup.json` (mode 0600), next to the vault key, so it protects against remote attacks (a prompt injection, a stolen chat), not against someone with the disk.

## C8 1Password broker (`onepassword.ts`)

Needs the `op` command line, `OP_SERVICE_ACCOUNT_TOKEN` and `INSTINCT_OP_VAULTS` (comma-separated; none listed means nothing can be read). The agent never holds a 1Password login: it makes one `op read` per use, only in allowed vaults, with the same approval and step-up as the vault. Use it as `{{secret:op://Personal/Netflix/password}}`. `op_list` shows item titles only; `op_reveal` shows a field.

## Tamper-evident activity log

Every entry in `audit.jsonl` carries the hash of the one before it. The owner tool `audit_verify` (or `AuditLog.verify()`) reports an edited, removed or reordered line at its line number. Entries written before chaining are counted but not judged; a half-written line from a crash is tolerated. The chain proves nothing was changed afterwards; it cannot stop someone who can rewrite the whole file and recompute it, so keep a copy somewhere the agent cannot write if that matters.

## Settings

| Variable | Effect |
|---|---|
| `INSTINCT_SECURITY=0` | Remove the runtime hooks (C1 to C3 and the monitor) |
| `INSTINCT_GROUNDING=off` | No grounding notes |
| `INSTINCT_VAULT_KEY` or `INSTINCT_VAULT_PASSPHRASE` | Turn the vault on |
| `INSTINCT_SECRET_TOOLS` | Extra tool names that may receive `{{secret:...}}` |
| `OP_SERVICE_ACCOUNT_TOKEN` + `INSTINCT_OP_VAULTS` | Turn the 1Password broker on |

## Not done

- **C9, outside audit and penetration test:** needs people outside this project.
- Not tested against real attackers, a real 1Password account, or a browser that actually fills a form. All tests use fakes.
- The firewall is pattern-based. A new phrasing can get past it; that is what C2 and the owner's yes are for.
- Replies sent with the `reply` tool during a run are not checked for grounding.
- Text the owner pastes into the chat counts as the owner's own words and is not scanned.
- Tool results are scanned with the same patterns as messages, so a clean-looking injection in a web page is still not caught.
