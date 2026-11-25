#!/usr/bin/env node
/**
 * Check an agent's POST /voice from a computer, the way the iPhone Shortcut calls it.
 *
 *   node examples/voice-check.mjs <url> <audio-file> [token]
 *
 * Prints the HTTP status and the JSON the agent answered with. Exit code 0 only for a 200 that
 * carries a transcript and a response.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const [url, file, token = process.env.INSTINCT_CHAT_TOKEN] = process.argv.slice(2);
if (!url || !file) {
  console.error("usage: node examples/voice-check.mjs <https://host/voice> <audio-file> [token]");
  process.exit(2);
}
const types = { ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".webm": "audio/webm" };
const headers = { "content-type": types[extname(file).toLowerCase()] ?? "audio/mp4" };
if (token) headers.authorization = `Bearer ${token}`;

let res;
try {
  res = await fetch(url, { method: "POST", headers, body: readFileSync(file), signal: AbortSignal.timeout(120_000) });
} catch (err) {
  console.error(`request failed: ${err.message}`);
  process.exit(1);
}
const text = await res.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  /* not JSON: print as is */
}
console.log(`HTTP ${res.status}`);
console.log(json ? JSON.stringify(json, null, 2) : text);
const ok = res.status === 200 && json && typeof json.transcript === "string" && typeof json.response === "string";
if (!ok) console.error("not a complete answer: see the status table in docs/IPHONE-SHORTCUT.md");
process.exit(ok ? 0 : 1);
